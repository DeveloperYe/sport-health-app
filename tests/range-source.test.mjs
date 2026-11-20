// task-1 第一批：PMTiles 按需 Range 读取的纯函数层。
//
// 这层不碰 uni/plus/DOM，所以能在 node 里直接测。三条硬约束都在这里钉住：
//   ① 返回长度必须恰好等于（裁剪后的）请求长度；
//   ② 失败必须 reject，不许静默返回全 0；
//   ③ 同一段正在飞就复用，不重复读。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampRange,
  planRanges,
  makeByteLru,
  createRangeSource,
  toU8,
  copyBuffer,
  formatBytesShort,
  formatReadStats,
  classifyProbe,
  parseContentRange,
  MIN_RANGE_BYTES,
  DEFAULT_LRU_BYTES,
} from '../src/components/map-view/range-source.js'

// ===== parseContentRange：整包大小只能从这里拿（灰空白 bug 的回归钉） =====

test('parseContentRange：206 的真实头部 → 取到整包大小', () => {
  // 真机/浏览器实测的 206 头：Content-Length 只有 16，整包大小在斜杠后面
  assert.deepEqual(parseContentRange('bytes 0-15/22466112'), { start: 0, end: 15, total: 22466112 })
  assert.deepEqual(parseContentRange('bytes 0-16383/35996813'), { start: 0, end: 16383, total: 35996813 })
})

test('parseContentRange：未知总大小（*）→ total 0', () => {
  assert.deepEqual(parseContentRange('bytes 0-15/*'), { start: 0, end: 15, total: 0 })
})

test('parseContentRange：大小写/多余空格/垃圾输入都不炸', () => {
  assert.equal(parseContentRange('Bytes 10-19/1000').total, 1000)
  assert.equal(parseContentRange('bytes  0-15/1000').total, 1000)
  assert.equal(parseContentRange(''), null)
  assert.equal(parseContentRange(null), null)
  assert.equal(parseContentRange('garbage'), null)
})

test('★ 回归：若把分片长度（16）误当整包大小，后续每个请求都会被截成 0', () => {
  // 这就是「Range 模式地图纯灰空白」的根因指纹：
  const bogus = clampRange(0, 16384, 16)
  assert.equal(bogus.length, 16, 'header 只能读到 16 字节 → pmtiles 解析失败')
  assert.equal(clampRange(22466112 - 100, 50, 16).length, 0, '连末尾请求都被截成 0')
  // 用 Content-Range 拿到真大小后就正常了
  const real = clampRange(0, 16384, 22466112)
  assert.equal(real.length, 16384)
})

test('MIN_RANGE_BYTES：门槛值是 1 KB（小于它一律不认，宁可退回整包）', () => {
  assert.equal(MIN_RANGE_BYTES, 1024)
})

// ===== classifyProbe：R1 探测结论判定（Lead 要求的「能在 node 里复现降级判定」） =====

test('classifyProbe：206 + 魔数对 → range-206 可用', () => {
  const r = classifyProbe({ status: 206, byteLength: 16, contentLength: 16, magicOk: true })
  assert.deepEqual(r, { ok: true, kind: 'range-206', detail: '206 ✓' })
})

test('classifyProbe：200 但只给了请求的那点字节 → range-head 可用（等效 Range）', () => {
  const r = classifyProbe({ status: 200, byteLength: 16, contentLength: -1, magicOk: true })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'range-head')
})

test('classifyProbe：200 却返回整个文件（忽略 Range）→ 必须放弃，绝不入内存', () => {
  // 这是最容易把 36 MB 拉进内存的那条路径
  const big = classifyProbe({ status: 200, byteLength: 22466112, contentLength: 22466112, magicOk: true })
  assert.equal(big.ok, false)
  assert.equal(big.kind, 'whole-file')
  // 即使 Content-Length 缺失，只要实际字节数远超请求量也得放弃
  const big2 = classifyProbe({ status: 200, byteLength: 999999, magicOk: true })
  assert.equal(big2.ok, false)
  assert.equal(big2.kind, 'whole-file')
})

test('classifyProbe：超时 / HTTP 错误 / 字节太少 / 魔数不对 都要能区分', () => {
  assert.equal(classifyProbe({ timedOut: true }).kind, 'timeout')
  assert.equal(classifyProbe({ status: 404, byteLength: 0 }).kind, 'http-404')
  assert.equal(classifyProbe({ status: 200, byteLength: 3, magicOk: false }).kind, 'short')
  assert.equal(classifyProbe({ status: 206, byteLength: 16, magicOk: false }).kind, 'bad-magic')
  assert.equal(classifyProbe({ status: 0, byteLength: 0 }).ok, false)
  assert.equal(classifyProbe(null).ok, false)
})

// ===== clampRange =====

test('clampRange：文件内部的请求原样放行', () => {
  assert.deepEqual(clampRange(100, 50, 1000), { offset: 100, length: 50, truncated: false })
})

test('clampRange：超出文件末尾要截断（pmtiles 固定要 16384，小包不足）', () => {
  // 22 MB 的包请求前 16 KB 正常；但 100 字节的小包只能给 100
  const r = clampRange(0, 16384, 100)
  assert.equal(r.offset, 0)
  assert.equal(r.length, 100)
  assert.equal(r.truncated, true)
  // 从 90 开始要 16384 → 只能给 10
  const r2 = clampRange(90, 16384, 100)
  assert.deepEqual(r2, { offset: 90, length: 10, truncated: true })
})

test('clampRange：offset 越界 → 空请求', () => {
  assert.deepEqual(clampRange(2000, 16, 1000), { offset: 1000, length: 0, truncated: true })
})

test('clampRange：负数 / NaN / 字符串都要被规整', () => {
  assert.deepEqual(clampRange(-5, 10, 1000), { offset: 0, length: 10, truncated: false })
  assert.deepEqual(clampRange('100', '50', 1000), { offset: 100, length: 50, truncated: false })
  const r = clampRange(NaN, NaN, 1000)
  assert.equal(r.offset, 0)
  assert.equal(r.length, 0)
})

test('clampRange：size 未知（≤0）时按原请求放行，交给调用方校验长度', () => {
  assert.deepEqual(clampRange(100, 50, 0), { offset: 100, length: 50, truncated: false })
})

// ===== planRanges =====

test('planRanges：空输入 / 非法长度都要被丢掉', () => {
  assert.deepEqual(planRanges([]), [])
  assert.deepEqual(planRanges(null), [])
  assert.deepEqual(planRanges([{ offset: 0, length: 0 }, { offset: 10, length: -5 }]), [])
  assert.deepEqual(planRanges([{}]), [])
})

test('planRanges：按 offset 升序输出', () => {
  const out = planRanges([
    { offset: 500, length: 10 },
    { offset: 100, length: 10 },
    { offset: 300, length: 10 },
  ])
  assert.deepEqual(out.map((r) => r.offset), [100, 300, 500])
})

test('planRanges：完全重复的请求只留一份', () => {
  const out = planRanges([
    { offset: 100, length: 10 },
    { offset: 100, length: 10 },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], { offset: 100, length: 10 })
})

test('planRanges：相邻（尾=头）合并成一段', () => {
  const out = planRanges([
    { offset: 0, length: 10 },
    { offset: 10, length: 10 },
  ])
  assert.deepEqual(out, [{ offset: 0, length: 20 }])
})

test('planRanges：重叠区间合并（取并集，不重复计数）', () => {
  const out = planRanges([
    { offset: 0, length: 100 },
    { offset: 50, length: 100 },
    { offset: 140, length: 20 },
  ])
  assert.deepEqual(out, [{ offset: 0, length: 160 }])
})

test('planRanges：隔得远的段不合并', () => {
  const out = planRanges([
    { offset: 0, length: 10 },
    { offset: 1000, length: 10 },
  ])
  assert.equal(out.length, 2)
})

test('planRanges：mergeGap 允许把小间隙并起来（换往返次数用）', () => {
  const reqs = [
    { offset: 0, length: 10 },
    { offset: 12, length: 10 },
  ]
  assert.equal(planRanges(reqs).length, 2, '默认 gap=0 不合并')
  assert.deepEqual(planRanges(reqs, { mergeGap: 4 }), [{ offset: 0, length: 22 }])
})

test('planRanges：被完全包含的小段不会撑长区间', () => {
  const out = planRanges([
    { offset: 0, length: 100 },
    { offset: 20, length: 10 },
  ])
  assert.deepEqual(out, [{ offset: 0, length: 100 }])
})

// ===== makeByteLru =====

test('makeByteLru：存入后能取到，且标记命中/未命中', () => {
  const lru = makeByteLru(1024)
  assert.equal(lru.get(0, 10), null)
  assert.equal(lru.set(0, 10, new Uint8Array(10)), true)
  const got = lru.get(0, 10)
  assert.ok(got instanceof Uint8Array)
  assert.equal(got.byteLength, 10)
  const st = lru.stats()
  assert.equal(st.hits, 1)
  assert.equal(st.misses, 1)
  assert.equal(st.entries, 1)
})

test('makeByteLru：超出字节上限时淘汰最久未用的', () => {
  const lru = makeByteLru(100)
  lru.set(0, 40, new Uint8Array(40))
  lru.set(100, 40, new Uint8Array(40))
  lru.get(0, 40) // 0 号变成最近使用
  lru.set(200, 40, new Uint8Array(40)) // 必须淘汰一个
  assert.equal(lru.get(0, 40) !== null, true, '最近用过的要留着')
  assert.equal(lru.get(100, 40), null, '最久未用的应被淘汰')
  assert.ok(lru.stats().evicted >= 1)
})

test('makeByteLru：单条大于整个缓存就不收（否则会把缓存冲空）', () => {
  const lru = makeByteLru(100)
  assert.equal(lru.set(0, 200, new Uint8Array(200)), false)
  assert.equal(lru.stats().entries, 0)
})

test('makeByteLru：默认上限是 8 MB，clear 后归零', () => {
  const lru = makeByteLru()
  assert.equal(lru.maxBytes, DEFAULT_LRU_BYTES)
  lru.set(0, 10, new Uint8Array(10))
  lru.clear()
  assert.equal(lru.stats().entries, 0)
  assert.equal(lru.stats().usedBytes, 0)
})

test('makeByteLru：同键重复写不会重复计字节', () => {
  const lru = makeByteLru(1024)
  lru.set(0, 10, new Uint8Array(10))
  lru.set(0, 10, new Uint8Array(10))
  assert.equal(lru.stats().usedBytes, 10)
  assert.equal(lru.stats().entries, 1)
})

// ===== toU8 / copyBuffer / 格式化 =====

test('toU8：ArrayBuffer / TypedArray 视图 / DataView 都认', () => {
  const ab = new Uint8Array([1, 2, 3]).buffer
  assert.equal(toU8(ab).byteLength, 3)
  const big = new Uint8Array([0, 1, 2, 3, 4])
  assert.equal(toU8(big.subarray(1, 3)).byteLength, 2)
  assert.equal(toU8(new DataView(ab)).byteLength, 3)
  assert.equal(toU8(null), null)
})

test('copyBuffer：返回长度相等且互不影响的独立 ArrayBuffer', () => {
  const src = new Uint8Array([1, 2, 3])
  const buf = copyBuffer(src)
  assert.equal(buf.byteLength, 3)
  src[0] = 9
  assert.equal(new Uint8Array(buf)[0], 1, '必须是拷贝，不能共享')
})

test('formatBytesShort / formatReadStats：诊断行口径', () => {
  assert.equal(formatBytesShort(512), '512B')
  assert.equal(formatBytesShort(2048), '2KB')
  assert.equal(formatBytesShort(2 * 1024 * 1024), '2.0MB')
  assert.equal(formatReadStats({ requests: 38, hits: 21, bytes: 2202009, errors: 0 }, 26), 'rd:38/21/2.1MB/26ms/0err')
  assert.equal(formatReadStats({ requests: 1, hits: 0, bytes: 0, errors: 0 }), 'rd:1/0/0B/0err')
  assert.equal(formatReadStats(null), 'rd:0/0/0B/0err')
})

// ===== createRangeSource =====

/** 造一个假文件：按 offset/length 从 buffer 里切 */
function fakeFile(totalBytes) {
  const data = new Uint8Array(totalBytes)
  for (let i = 0; i < totalBytes; i++) data[i] = i & 0xff
  const calls = []
  const reader = (offset, length) => {
    calls.push({ offset, length })
    return Promise.resolve(data.slice(offset, offset + length).buffer)
  }
  return { data, reader, calls }
}

test('createRangeSource：正常读，返回恰好请求长度的 ArrayBuffer', async () => {
  const f = fakeFile(1000)
  const src = createRangeSource({ key: 'a.pmtiles', size: 1000, reader: f.reader })
  assert.equal(src.getKey(), 'a.pmtiles')
  const res = await src.getBytes(10, 20)
  assert.ok(res.data instanceof ArrayBuffer)
  assert.equal(res.data.byteLength, 20)
  assert.deepEqual(Array.from(new Uint8Array(res.data)), Array.from(f.data.slice(10, 30)))
  assert.equal(f.calls.length, 1)
})

test('createRangeSource：请求越过末尾时截断到文件长度（短返回是合法的）', async () => {
  const f = fakeFile(100)
  const src = createRangeSource({ key: 'a', size: 100, reader: f.reader })
  const res = await src.getBytes(0, 16384)
  assert.equal(res.data.byteLength, 100)
  assert.equal(f.calls[0].length, 100, 'reader 只该被要 100 字节')
})

test('createRangeSource：越界请求返回空 buffer，且不调 reader', async () => {
  const f = fakeFile(100)
  const src = createRangeSource({ key: 'a', size: 100, reader: f.reader })
  const res = await src.getBytes(500, 10)
  assert.equal(res.data.byteLength, 0)
  assert.equal(f.calls.length, 0)
})

test('createRangeSource：reader 返回长度不符必须 reject（不许静默给错数据）', async () => {
  const src = createRangeSource({
    key: 'a',
    size: 1000,
    reader: () => Promise.resolve(new ArrayBuffer(7)),
  })
  await assert.rejects(() => src.getBytes(0, 10), (e) => {
    assert.equal(e.code, 'RANGE_LENGTH_MISMATCH')
    return true
  })
  assert.equal(src.stats().errors, 1)
})

test('createRangeSource：reader 抛错要原样 reject', async () => {
  const src = createRangeSource({
    key: 'a',
    size: 1000,
    reader: () => Promise.reject(new Error('桥断了')),
  })
  await assert.rejects(() => src.getBytes(0, 10), /桥断了/)
  assert.equal(src.stats().errors, 1)
})

test('createRangeSource：没有 reader 时明确报错，而不是静默空数据', async () => {
  const src = createRangeSource({ key: 'a', size: 1000 })
  await assert.rejects(() => src.getBytes(0, 10), /没有 reader/)
})

test('createRangeSource：接了 LRU 就命中缓存、不再调 reader', async () => {
  const f = fakeFile(1000)
  const cache = makeByteLru(1024)
  const src = createRangeSource({ key: 'a', size: 1000, reader: f.reader, cache })
  await src.getBytes(0, 16)
  const second = await src.getBytes(0, 16)
  assert.equal(f.calls.length, 1, '第二次应命中缓存')
  assert.equal(second.data.byteLength, 16)
  assert.equal(src.stats().hits, 1)
  assert.equal(src.stats().reads, 1)
})

test('createRangeSource：缓存返回的是拷贝，调用方改了不影响缓存', async () => {
  const f = fakeFile(1000)
  const cache = makeByteLru(1024)
  const src = createRangeSource({ key: 'a', size: 1000, reader: f.reader, cache })
  const r1 = await src.getBytes(0, 4)
  new Uint8Array(r1.data)[0] = 99
  const r2 = await src.getBytes(0, 4)
  assert.equal(new Uint8Array(r2.data)[0], f.data[0], '缓存内容不能被上次的返回值污染')
})

test('createRangeSource：同一段并发请求只读一次（飞行中去重）', async () => {
  let calls = 0
  const reader = (offset, length) => {
    calls++
    return new Promise((r) => setTimeout(() => r(new ArrayBuffer(length)), 5))
  }
  const src = createRangeSource({ key: 'a', size: 1000, reader })
  const all = await Promise.all([src.getBytes(0, 16), src.getBytes(0, 16), src.getBytes(0, 16)])
  assert.equal(calls, 1, '三个并发同段请求只该真正读一次')
  all.forEach((r) => assert.equal(r.data.byteLength, 16))
  assert.ok(src.stats().coalesced >= 2)
  assert.equal(src.stats().inflight, 0, '飞行表必须清空')
})

test('createRangeSource：一次失败不会把后续同段请求挂死', async () => {
  let n = 0
  const src = createRangeSource({
    key: 'a',
    size: 1000,
    reader: (offset, length) => {
      n++
      if (n === 1) return Promise.reject(new Error('第一次失败'))
      return Promise.resolve(new ArrayBuffer(length))
    },
  })
  await assert.rejects(() => src.getBytes(0, 16), /第一次失败/)
  const ok = await src.getBytes(0, 16)
  assert.equal(ok.data.byteLength, 16)
  assert.equal(src.stats().inflight, 0)
})

test('createRangeSource：stats 统计请求/读取/字节/错误', async () => {
  const f = fakeFile(1000)
  const src = createRangeSource({ key: 'a', size: 1000, reader: f.reader })
  await src.getBytes(0, 10)
  await src.getBytes(20, 10)
  const st = src.stats()
  assert.equal(st.requests, 2)
  assert.equal(st.reads, 2)
  assert.equal(st.bytes, 20)
  assert.equal(st.errors, 0)
  assert.equal(st.hits, 0)
})

test('createRangeSource：被截断的请求计入 stats.clamped（size 取错的指纹）', async () => {
  const reader = (o, l) => Promise.resolve(new ArrayBuffer(l))
  const src = createRangeSource({ key: 'a', size: 100, reader })
  const r = await src.getBytes(0, 16384) // 被截到 100
  assert.equal(r.data.byteLength, 100)
  assert.equal(src.stats().clamped, 1, 'clamped 计数要能被诊断看到')
  // 正常范围内不该有截断
  const src2 = createRangeSource({ key: 'b', size: 100000, reader })
  await src2.getBytes(0, 16384)
  assert.equal(src2.stats().clamped, 0)
})

test('createRangeSource：size 未知时按原请求读（并仍校验长度）', async () => {
  const reader = (offset, length) => Promise.resolve(new ArrayBuffer(length))
  const src = createRangeSource({ key: 'a', size: 0, reader })
  const r = await src.getBytes(100, 32)
  assert.equal(r.data.byteLength, 32)
})
