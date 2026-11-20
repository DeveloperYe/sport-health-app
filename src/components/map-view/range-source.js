/**
 * PMTiles 按需 Range 读取的数据源层（**纯函数，不引 uni / plus / DOM / maplibre**）。
 *
 * 为什么需要这一层：
 *   现状是「整包读进内存」（`map-core.js` 的 memorySource 持有整个 Uint8Array），
 *   峰值内存 ≈ 3.6N（磁盘字节），可用包上限 40–50 MB；而索引里最大包 374 MB。
 *   pmtiles 的 `Source.getBytes(offset, length)` 契约本来就是异步的，
 *   它只会按需读三处：header 固定 0..16384、目录块、单个瓦片字节 ——
 *   所以只要换掉「数据从哪来」，就能把内存降到与包大小无关。
 *
 * 这一层只做三件事，全部可单测：
 *   1) `clampRange`  把请求裁到文件范围内（pmtiles 固定要 16384 字节，小包不足）
 *   2) `planRanges`  合并/去重请求（减少跨层往返次数）
 *   3) `createRangeSource` / `makeByteLru`  Source 实现 + 字节缓存
 *
 * 硬约束（Lead 定的，改的时候别破坏）：
 *   - `getBytes` 必须返回**恰好请求长度**的 ArrayBuffer（末尾截断到 size）；
 *   - 失败必须 reject，**绝不静默返回全 0**（真机 Native 分块踩过：看着成功、数据全错）；
 *   - 同一 (offset,length) 正在飞就复用，不重复读。
 */

/** 缓存默认上限：8 MB。目录块几乎全命中，瓦片按需淘汰 */
export const DEFAULT_LRU_BYTES = 8 * 1024 * 1024

/**
 * 按需读取能接受的最小文件长度（字节）。
 *
 * 为什么要这条门槛：`size` 是我们自己探测出来的，一旦探测取错（例如把 206 的
 * Content-Length=16 当成整包大小），`clampRange` 会把之后每个请求都截成 0 字节，
 * pmtiles 解析 header 失败后**静默不再请求** —— 表现是地图纯灰空白、零错误。
 * 真机/浏览器都踩过这个坑，所以在源头就把"明显不可能"的 size 挡掉，宁可退回整包。
 */
export const MIN_RANGE_BYTES = 1024

function num(v, dflt) {
  const n = Number(v)
  return isFinite(n) ? n : dflt
}

/** 任意「字节容器」→ Uint8Array（ArrayBuffer / TypedArray / DataView / 带 byteLength 的对象） */
export function toU8(v) {
  if (!v) return null
  try {
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return new Uint8Array(v)
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v)) {
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    }
    if (typeof v.byteLength === 'number') return new Uint8Array(v)
  } catch (e) {
    /* ignore */
  }
  return null
}

/** Uint8Array → 长度恰好相等的独立 ArrayBuffer（交给 pmtiles 后不会被我们复用篡改） */
export function copyBuffer(u8) {
  if (!u8) return new ArrayBuffer(0)
  const out = new Uint8Array(u8.byteLength)
  out.set(u8)
  return out.buffer
}

/**
 * 把请求裁剪到文件范围内。
 * - `offset` 越界 → 返回空（`length: 0`）
 * - 请求超过文件末尾 → 截断（pmtiles 允许短返回：header 只要前 127 字节）
 * - `size` 未知（≤0）时按原请求放行，长度校验交给调用方
 * @param {number} offset
 * @param {number} length
 * @param {number} size 文件总字节数
 * @returns {{offset:number, length:number, truncated:boolean}}
 */
export function clampRange(offset, length, size) {
  const off = Math.max(0, Math.floor(num(offset, 0)))
  const want = Math.max(0, Math.floor(num(length, 0)))
  const total = Math.floor(num(size, 0))
  if (total <= 0) return { offset: off, length: want, truncated: false }
  if (off >= total) return { offset: total, length: 0, truncated: want > 0 }
  const len = Math.min(want, total - off)
  return { offset: off, length: len, truncated: len < want }
}

/**
 * 合并 + 去重一组请求，减少往返次数。
 *
 * 规则：按 offset 升序；两段「重叠」或「间隙 ≤ mergeGap」就并成一段；完全重复的只留一份。
 * `mergeGap` 默认 0（只合并真正相邻/重叠的），想用小预取换往返次数时传 2048/4096 之类。
 *
 * @param {Array<{offset:number,length:number}>} requests
 * @param {{mergeGap?:number}} [opts]
 * @returns {Array<{offset:number,length:number}>}
 */
export function planRanges(requests, opts) {
  const o = opts || {}
  const gap = Math.max(0, Math.floor(num(o.mergeGap, 0)))
  const list = []
  const arr = Array.isArray(requests) ? requests : []
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i] || {}
    const off = Math.max(0, Math.floor(num(r.offset, 0)))
    const len = Math.floor(num(r.length, 0))
    if (len > 0) list.push({ offset: off, length: len })
  }
  if (!list.length) return []
  list.sort((a, b) => a.offset - b.offset || a.length - b.length)
  const out = [list[0]]
  for (let i = 1; i < list.length; i++) {
    const cur = out[out.length - 1]
    const next = list[i]
    const curEnd = cur.offset + cur.length
    if (next.offset <= curEnd + gap) {
      const nextEnd = next.offset + next.length
      if (nextEnd > curEnd) cur.length = nextEnd - cur.offset
    } else {
      out.push(next)
    }
  }
  return out
}

/**
 * 按「字节数」限额的 LRU 缓存。
 *
 * 为什么按字节而不是按条数：目录块可能 34 KB，瓦片可能 120 KB，
 * 按条数限额会让一个城市包吃出上百 MB。
 *
 * @param {number} [maxBytes]
 */
export function makeByteLru(maxBytes) {
  const cap = num(maxBytes, DEFAULT_LRU_BYTES) > 0 ? Math.floor(num(maxBytes, DEFAULT_LRU_BYTES)) : DEFAULT_LRU_BYTES
  const map = new Map() // key -> Uint8Array（Map 保持插入顺序，队首=最久未用）
  let used = 0
  let hits = 0
  let misses = 0
  let evicted = 0
  const keyOf = (offset, length) => offset + '+' + length

  return {
    maxBytes: cap,
    /** @returns {Uint8Array|null} */
    get(offset, length) {
      const k = keyOf(offset, length)
      const v = map.get(k)
      if (!v) {
        misses++
        return null
      }
      // 命中后挪到队尾，表示"最近用过"
      map.delete(k)
      map.set(k, v)
      hits++
      return v
    },
    /** @returns {boolean} 是否真的缓存了（超大条目会拒收，避免把缓存整段冲掉） */
    set(offset, length, bytes) {
      const u8 = toU8(bytes)
      if (!u8 || !u8.byteLength) return false
      if (u8.byteLength > cap) return false
      const k = keyOf(offset, length)
      const old = map.get(k)
      if (old) {
        used -= old.byteLength
        map.delete(k)
      }
      map.set(k, u8)
      used += u8.byteLength
      while (used > cap && map.size > 1) {
        const oldestKey = map.keys().next().value
        const oldest = map.get(oldestKey)
        map.delete(oldestKey)
        used -= oldest.byteLength
        evicted++
      }
      return true
    },
    stats() {
      return { entries: map.size, usedBytes: used, maxBytes: cap, hits, misses, evicted }
    },
    clear() {
      map.clear()
      used = 0
    },
  }
}

/**
 * 造一个 pmtiles 可用的 Source：`{ getKey(), getBytes(offset, length) }`。
 *
 * @param {object} opts
 * @param {string} opts.key  源键（必须与 style 里 `pmtiles://<key>` 完全一致）
 * @param {number} opts.size 文件总字节数（App 从 plus.io File.size 拿，H5 从 Content-Length / IDB 拿）
 * @param {(offset:number, length:number)=>Promise<ArrayBuffer|Uint8Array>} opts.reader 真正的随机读实现（R1/R2 提供）
 * @param {object} [opts.cache] makeByteLru() 的产物（多个档案可共用一个）
 */
export function createRangeSource(opts) {
  const o = opts || {}
  const key = String(o.key || 'pmtiles')
  const size = Math.floor(num(o.size, 0))
  const reader = typeof o.reader === 'function' ? o.reader : null
  const cache = o.cache || null
  const stats = { requests: 0, hits: 0, reads: 0, coalesced: 0, bytes: 0, errors: 0, clamped: 0 }
  const inflight = new Map() // 'offset+length' -> Promise<Uint8Array>

  function recordError(e) {
    stats.errors++
    return e
  }

  return {
    getKey() {
      return key
    },
    size() {
      return size
    },
    stats() {
      return Object.assign({}, stats, { inflight: inflight.size })
    },
    /**
     * pmtiles 的契约：返回 Promise<{data: ArrayBuffer}>，data 长度必须恰好等于（裁剪后的）请求长度。
     */
    getBytes(offset, length) {
      const r = clampRange(offset, length, size)
      stats.requests++
      // 记一笔"被截断"：正常包几乎不会发生；持续出现说明 size 可能取错了（早期灰空白 bug 的指纹）
      if (r.truncated) stats.clamped++
      // 越界或空请求：返回空 buffer（pmtiles 对空数据是安全的，不会当成"未命中"以外的语义）
      if (!(r.length > 0)) return Promise.resolve({ data: new ArrayBuffer(0) })
      if (!reader) {
        return Promise.reject(recordError(new Error('range source 没有 reader（键 ' + key + '）')))
      }

      if (cache) {
        const hit = cache.get(r.offset, r.length)
        if (hit) {
          stats.hits++
          stats.bytes += r.length
          return Promise.resolve({ data: copyBuffer(hit) })
        }
      }

      const k = r.offset + '+' + r.length
      const flying = inflight.get(k)
      if (flying) {
        stats.coalesced++
        return flying.then((u8) => ({ data: copyBuffer(u8) }))
      }

      const p = Promise.resolve()
        .then(() => reader(r.offset, r.length))
        .then((buf) => {
          const u8 = toU8(buf)
          if (!u8 || u8.byteLength !== r.length) {
            const err = new Error(
              'range 读到的长度不符（键 ' + key + ' @' + r.offset + '+' + r.length +
                '）：实际 ' + (u8 ? u8.byteLength : 'null')
            )
            err.code = 'RANGE_LENGTH_MISMATCH'
            throw err
          }
          stats.reads++
          stats.bytes += r.length
          if (cache) cache.set(r.offset, r.length, u8)
          return u8
        })
      // 无论成败都要把飞行表清掉，否则一次失败会把后续同段请求永久挂住
      const tracked = p.then(
        (u8) => {
          inflight.delete(k)
          return u8
        },
        (e) => {
          inflight.delete(k)
          throw recordError(e)
        }
      )
      inflight.set(k, tracked)
      return tracked.then((u8) => ({ data: copyBuffer(u8) }))
    },
  }
}

/**
 * 解析 `Content-Range: bytes 0-15/22466112`（纯函数）。
 *
 * 为什么单独抽出来：整包大小只能从这里拿。**不能用 Content-Length** ——
 * 206 响应的 Content-Length 只是这一段的长度（只要 16 字节时它就是 16），
 * 曾把它当整包大小 → `clampRange` 把后续所有请求截成 0 字节 → pmtiles 解析 header
 * 失败后静默不再请求 → 地图纯灰空白、零错误（真机上等价于"地图打不开"）。
 *
 * @returns {{start:number, end:number, total:number}|null} total 为 0 表示未知（`*`）
 */
export function parseContentRange(v) {
  const s = String(v || '')
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(s)
  if (!m) return null
  return {
    start: Number(m[1]) || 0,
    end: Number(m[2]) || 0,
    total: m[3] === '*' ? 0 : Number(m[3]) || 0,
  }
}

/** 人类可读字节数（诊断行用，避免依赖 uni 的 formatBytes） */
export function formatBytesShort(n) {
  const v = Math.max(0, num(n, 0))
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + 'MB'
  if (v >= 1024) return Math.round(v / 1024) + 'KB'
  return Math.round(v) + 'B'
}

/**
 * R1 探测结论的判定（纯函数，便于单测）。
 *
 * 探测只请求 16 字节，但 WebView 可能：
 *   ① 真按 Range 返回 206（最好）；
 *   ② 返回 200 且只给了我们要的那 16 字节（等效可用）；
 *   ③ 返回 200 却给了整个文件（忽略 Range）—— **必须放弃并降级**，否则 36 MB 直接进内存；
 *   ④ 超时 / 抛异常 / 被策略禁（file:// 常见）。
 * 另外不管哪种，前 7 字节必须是 "PMTiles" 才能证明「这段字节真的是这个包」。
 *
 * @param {object} p
 * @param {number} [p.status] HTTP 状态码（file:// 下可能是 0）
 * @param {number} [p.byteLength] 实际拿到的字节数
 * @param {number} [p.contentLength] 响应头 Content-Length（可能缺）
 * @param {boolean} [p.magicOk] 前 7 字节是否等于 PMTiles
 * @param {boolean} [p.timedOut]
 * @param {boolean} [p.rangeHeaderIgnored] 调用方明确观察到响应没有 content-range
 * @returns {{ok:boolean, kind:string, detail:string}}
 */
export function classifyProbe(p) {
  const o = p || {}
  const status = Math.floor(num(o.status, 0))
  const got = Math.floor(num(o.byteLength, 0))
  const clen = Math.floor(num(o.contentLength, -1))
  if (o.timedOut) return { ok: false, kind: 'timeout', detail: '探测超时' }
  if (status >= 400) return { ok: false, kind: 'http-' + status, detail: 'HTTP ' + status }
  if (!(got >= 7)) return { ok: false, kind: 'short', detail: '只拿到 ' + got + ' 字节' }
  // 忽略 Range 直接把整个文件吐回来：一旦入内存就白屏/闪退，必须放弃
  if (status !== 206 && clen > 4096) {
    return { ok: false, kind: 'whole-file', detail: '忽略 Range 返回整包（Content-Length ' + clen + ')' }
  }
  if (status !== 206 && got > 4096) {
    return { ok: false, kind: 'whole-file', detail: '忽略 Range 返回 ' + got + ' 字节' }
  }
  if (!o.magicOk) return { ok: false, kind: 'bad-magic', detail: '头部不是 PMTiles' }
  return { ok: true, kind: status === 206 ? 'range-206' : 'range-head', detail: status === 206 ? '206 ✓' : '200+裁剪 ✓' }
}

/**
 * 诊断行里的读取统计，形如 `rd:38/21/2.1MB/0err`：
 * 请求数 / 缓存命中 / 累计传输 / 错误数（有平均延迟时再补 `/26ms`）。
 * 纯函数，方便 e2e 直接断言字符串包含关系。
 */
export function formatReadStats(stats, avgMs) {
  const s = stats || {}
  const parts = [
    Math.floor(num(s.requests, 0)),
    Math.floor(num(s.hits, 0)),
    formatBytesShort(s.bytes),
  ]
  const ms = num(avgMs, 0)
  if (ms > 0) parts.push(Math.round(ms) + 'ms')
  parts.push(Math.floor(num(s.errors, 0)) + 'err')
  return 'rd:' + parts.join('/')
}
