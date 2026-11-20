// task-1 第二批：跨层 Range 桥接通道（reqId / 并发上限 / 超时 / 统计）。
// 纯逻辑层，不碰 uni/plus，可在 node 里直接测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBridgeReader, b64ToBytes, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT } from '../src/components/map-view/range-bridge.js'

/** 造一个可控的发送端：把发出去的请求记录下来，由测试决定何时应答 */
function harness(opts) {
  const sent = []
  const reader = createBridgeReader(
    Object.assign(
      {
        send: (p) => sent.push(p),
        prefix: 'r',
      },
      opts || {}
    )
  )
  return { reader, sent }
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0))

test('b64ToBytes：正常解码；空/非法输入返回 null 不抛', () => {
  // "PMTiles" 的 base64（7 字节）
  const u8 = b64ToBytes('UE1UaWxlcw==')
  assert.ok(u8 instanceof Uint8Array)
  assert.equal(u8.byteLength, 7)
  assert.equal(String.fromCharCode.apply(null, Array.from(u8)), 'PMTiles')
  assert.equal(b64ToBytes(''), null)
  assert.equal(b64ToBytes(null), null)
  assert.equal(b64ToBytes('这不是base64@@@'), null)
})

test('默认参数：超时 3 s、并发 4', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 3000)
  assert.equal(DEFAULT_MAX_CONCURRENT, 4)
  const { reader } = harness()
  const st = reader.stats()
  assert.equal(st.maxConcurrent, 4)
})

test('request → 逻辑层应答 → resolve 出字节', async () => {
  const { reader, sent } = harness()
  const p = reader.request(100, 4)
  assert.equal(sent.length, 1)
  assert.deepEqual({ offset: sent[0].offset, length: sent[0].length }, { offset: 100, length: 4 })
  reader.accept({ reqId: sent[0].reqId, bytes: new Uint8Array([1, 2, 3, 4]) })
  const bytes = await p
  assert.deepEqual(Array.from(bytes), [1, 2, 3, 4])
  const st = reader.stats()
  assert.equal(st.requests, 1)
  assert.equal(st.done, 1)
  assert.equal(st.active, 0)
})

test('accept 支持 base64 应答', async () => {
  const { reader, sent } = harness()
  const p = reader.request(0, 3)
  reader.accept({ reqId: sent[0].reqId, b64: 'AQID' }) // 1,2,3
  const bytes = await p
  assert.deepEqual(Array.from(bytes), [1, 2, 3])
})

test('并发上限：同时只发出 maxConcurrent 个，其余排队', async () => {
  const { reader, sent } = harness({ maxConcurrent: 2 })
  const ps = [reader.request(0, 1), reader.request(1, 1), reader.request(2, 1)]
  assert.equal(sent.length, 2, '第 3 个应排队')
  assert.equal(reader.stats().queued, 1)
  reader.accept({ reqId: sent[0].reqId, bytes: new Uint8Array([0]) })
  await tick()
  assert.equal(sent.length, 3, '释放一个槽位后要自动补发')
  reader.accept({ reqId: sent[1].reqId, bytes: new Uint8Array([1]) })
  reader.accept({ reqId: sent[2].reqId, bytes: new Uint8Array([2]) })
  const out = await Promise.all(ps)
  assert.equal(out.length, 3)
})

test('超时：只让那一个请求失败，其它请求不受影响', async () => {
  const { reader, sent } = harness({ maxConcurrent: 4, timeoutMs: 20 })
  const bad = reader.request(0, 4)
  const good = reader.request(10, 4)
  reader.accept({ reqId: sent[1].reqId, bytes: new Uint8Array([9, 9, 9, 9]) })
  const goodBytes = await good
  assert.equal(goodBytes.byteLength, 4)
  await assert.rejects(() => bad, (e) => {
    assert.equal(e.code, 'RANGE_TIMEOUT')
    return true
  })
  const st = reader.stats()
  assert.equal(st.timeouts, 1)
  assert.equal(st.done, 1)
})

test('超时后迟到的应答被当成未知 reqId，不炸也不重复 resolve', async () => {
  const { reader, sent } = harness({ timeoutMs: 10 })
  const p = reader.request(0, 2)
  await assert.rejects(() => p, /超时/)
  const ok = reader.accept({ reqId: sent[0].reqId, bytes: new Uint8Array([1, 2]) })
  assert.equal(ok, false)
  assert.equal(reader.stats().unknown, 1)
})

test('应答长度不符必须 reject（不许把错误数据喂给 pmtiles）', async () => {
  const { reader, sent } = harness()
  const p = reader.request(0, 10)
  reader.accept({ reqId: sent[0].reqId, bytes: new Uint8Array(7) })
  await assert.rejects(() => p, (e) => {
    assert.equal(e.code, 'RANGE_LENGTH_MISMATCH')
    return true
  })
  assert.equal(reader.stats().errors, 1)
})

test('逻辑层回传错误：对应请求 reject', async () => {
  const { reader, sent } = harness()
  const p = reader.request(0, 4)
  reader.accept({ reqId: sent[0].reqId, err: '打不开文件' })
  await assert.rejects(() => p, /打不开文件/)
})

test('未知 reqId / 空应答都不炸，只计 unknown', () => {
  const { reader } = harness()
  assert.equal(reader.accept({ reqId: 'nope', bytes: new Uint8Array(1) }), false)
  assert.equal(reader.accept(null), false)
  assert.equal(reader.stats().unknown, 2)
})

test('空请求（length<=0）直接返回空，不发不排队', async () => {
  const { reader, sent } = harness()
  const b = await reader.request(0, 0)
  assert.equal(b.byteLength, 0)
  assert.equal(sent.length, 0)
  assert.equal(reader.stats().requests, 0)
})

test('send 抛异常：该请求 reject，槽位要释放（不能永久卡住）', async () => {
  const reader = createBridgeReader({
    send: () => {
      throw new Error('callMethod 挂了')
    },
    maxConcurrent: 1,
  })
  await assert.rejects(() => reader.request(0, 4), /callMethod 挂了/)
  assert.equal(reader.stats().active, 0)
})

test('没有 send 实现：明确 reject', async () => {
  const reader = createBridgeReader({})
  await assert.rejects(() => reader.request(0, 4), /没有 send/)
})

test('destroy：在等与排队的请求全部 reject，之后再请求也被拒', async () => {
  const { reader } = harness({ maxConcurrent: 1, timeoutMs: 5000 })
  const p1 = reader.request(0, 2)
  const p2 = reader.request(2, 2)
  reader.destroy('切城市了')
  await assert.rejects(() => p1, /切城市了/)
  await assert.rejects(() => p2, /切城市了/)
  await assert.rejects(() => reader.request(4, 2), /已销毁/)
  assert.equal(reader.stats().active, 0)
})

test('stats：平均延迟按完成的请求算，峰值并发不超上限', async () => {
  let fake = 0
  const sent = []
  const reader = createBridgeReader({
    send: (p) => sent.push(p),
    maxConcurrent: 2,
    now: () => fake,
  })
  const a = reader.request(0, 1)
  const b = reader.request(1, 1)
  const c = reader.request(2, 1) // 排队
  fake = 40
  reader.accept({ reqId: sent[0].reqId, bytes: new Uint8Array([1]) })
  reader.accept({ reqId: sent[1].reqId, bytes: new Uint8Array([2]) })
  await tick()
  fake = 60
  reader.accept({ reqId: sent[2].reqId, bytes: new Uint8Array([3]) })
  await Promise.all([a, b, c])
  const st = reader.stats()
  assert.equal(st.requests, 3)
  assert.equal(st.done, 3)
  assert.equal(st.maxActive, 2, '峰值并发不得超过上限')
  assert.ok(st.avgMs > 0, 'avgMs=' + st.avgMs)
})

test('乱序应答也能正确配对', async () => {
  const { reader, sent } = harness({ maxConcurrent: 4 })
  const p1 = reader.request(0, 2)
  const p2 = reader.request(100, 2)
  // 先回答第二个
  reader.accept({ reqId: sent[1].reqId, bytes: new Uint8Array([7, 7]) })
  reader.accept({ reqId: sent[0].reqId, bytes: new Uint8Array([3, 3]) })
  const [b1, b2] = await Promise.all([p1, p2])
  assert.deepEqual(Array.from(b1), [3, 3])
  assert.deepEqual(Array.from(b2), [7, 7])
})
