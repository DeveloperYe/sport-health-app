/**
 * 跨层 Range 读取的「请求-响应通道」（**纯逻辑，不引 uni / plus / DOM**，可 node 单测）。
 *
 * 为什么需要它：
 *   App 端视图层（renderjs）能建图但读不了应用私有目录里的 .pmtiles；
 *   逻辑层（v8）能读文件，却没有 fetch/XHR 也建不了图。
 *   于是「视图层发请求 → 逻辑层 file.slice 读一段 → base64 回推」成了 R2 路径。
 *
 * 这一层负责所有容易出错的簿记：
 *   - reqId 分配与应答配对（回推乱序、重复、未知 reqId 都要能扛）
 *   - 并发上限（默认 4）与排队（避免一次把 30 个瓦片请求全压过去）
 *   - 单请求超时（默认 3 s）：超时只让**那一个**请求失败，不影响其它瓦片
 *   - 统计：请求数 / 完成数 / 平均延迟 / 超时数 / 错误数 / 峰值并发
 *
 * 与 map-view.vue 的关系：
 *   send 由视图层提供（内部走 `$ownerInstance.callMethod('mwReadRange', …)`），
 *   逻辑层读完后把 `{ reqId, b64 }` 通过现有 `:mvchunk` 通道推回来，视图层调 `accept()`。
 */
export const DEFAULT_TIMEOUT_MS = 3000
export const DEFAULT_MAX_CONCURRENT = 4

/** base64 → Uint8Array（WebView 与 node 都有 atob） */
export function b64ToBytes(b64) {
  const s = String(b64 || '')
  if (!s) return null
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch (e) {
    return null
  }
}

/**
 * @param {object} opts
 * @param {(payload:{reqId:number, offset:number, length:number})=>void} opts.send 发请求（视图层提供）
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxConcurrent]
 * @param {()=>number} [opts.now] 便于测试注入时钟
 * @param {string} [opts.prefix] reqId 前缀（多档案时区分来源，便于日志排查）
 */
export function createBridgeReader(opts) {
  const o = opts || {}
  const send = typeof o.send === 'function' ? o.send : null
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS
  const maxConcurrent = Number(o.maxConcurrent) > 0 ? Number(o.maxConcurrent) : DEFAULT_MAX_CONCURRENT
  const now = typeof o.now === 'function' ? o.now : () => Date.now()
  const prefix = String(o.prefix || 'r')

  const pending = new Map() // reqId -> { offset, length, t0, timer, resolve, reject }
  const queue = [] // [{ offset, length, resolve, reject }]
  const stats = { requests: 0, done: 0, timeouts: 0, errors: 0, unknown: 0, totalMs: 0, maxActive: 0, active: 0, queued: 0 }
  let seq = 0
  let destroyed = false

  function nextId() {
    seq++
    return prefix + seq
  }

  function release(rec, err, bytes, kind) {
    // 注意：这里必须拿到 pending 里的**记录**（它带 reqId），
    // 早期版本误把排队 job 传进来做 key，导致 accept 时匹配不上、请求干等到超时。
    if (!rec || !rec.reqId) return
    if (!pending.has(rec.reqId)) return
    pending.delete(rec.reqId)
    if (rec.timer) clearTimeout(rec.timer)
    stats.active = Math.max(0, stats.active - 1)
    if (err) {
      if (kind === 'timeout') stats.timeouts++
      else stats.errors++
      rec.reject(err)
    } else {
      stats.done++
      stats.totalMs += Math.max(0, now() - rec.t0)
      rec.resolve(bytes)
    }
    pump()
  }

  function start(job) {
    stats.active++
    if (stats.active > stats.maxActive) stats.maxActive = stats.active
    const reqId = nextId()
    const rec = {
      reqId: reqId,
      offset: job.offset,
      length: job.length,
      t0: now(),
      timer: null,
      resolve: job.resolve,
      reject: job.reject,
    }
    rec.timer = setTimeout(() => {
      const err = new Error('range 桥接超时（' + timeoutMs + 'ms）@' + job.offset + '+' + job.length)
      err.code = 'RANGE_TIMEOUT'
      release(rec, err, null, 'timeout')
    }, timeoutMs)
    pending.set(reqId, rec)
    try {
      if (!send) throw new Error('桥接没有 send 实现')
      send({ reqId: reqId, offset: job.offset, length: job.length })
    } catch (e) {
      release(rec, e, null, 'error')
    }
  }

  function pump() {
    while (!destroyed && stats.active < maxConcurrent && queue.length) {
      start(queue.shift())
    }
    stats.queued = queue.length
  }

  return {
    /**
     * 请求一段字节。@returns {Promise<Uint8Array>}
     */
    request(offset, length) {
      const off = Math.max(0, Math.floor(Number(offset) || 0))
      const len = Math.max(0, Math.floor(Number(length) || 0))
      if (!(len > 0)) return Promise.resolve(new Uint8Array(0))
      if (destroyed) return Promise.reject(new Error('bridge 已销毁'))
      stats.requests++
      return new Promise((resolve, reject) => {
        queue.push({ offset: off, length: len, resolve, reject })
        pump()
      })
    },
    /**
     * 逻辑层回推应答。未知/重复的 reqId 只记一次 unknown，不算错误（乱序、迟到都正常）。
     * @param {{reqId:(string|number), b64?:string, bytes?:Uint8Array, err?:string}} resp
     * @returns {boolean} 是否被一个在等的请求消费
     */
    accept(resp) {
      const r = resp || {}
      const reqId = r.reqId
      const job = pending.get(reqId)
      if (!job) {
        stats.unknown++
        return false
      }
      if (r.err) {
        release(job, new Error(String(r.err)), null, 'error')
        return true
      }
      const bytes = r.bytes instanceof Uint8Array ? r.bytes : b64ToBytes(r.b64)
      if (!bytes) {
        release(job, new Error('桥接应答无法解码（reqId=' + reqId + '）'), null, 'error')
        return true
      }
      // 长度是硬契约：短了/长了都当失败处理，绝不把错误数据喂给 pmtiles
      if (bytes.byteLength !== job.length) {
        const err = new Error('桥接应答长度不符（reqId=' + reqId + '）：期望 ' + job.length + '，实际 ' + bytes.byteLength)
        err.code = 'RANGE_LENGTH_MISMATCH'
        release(job, err, null, 'error')
        return true
      }
      release(job, null, bytes, 'ok')
      return true
    },
    stats() {
      const done = stats.done || 0
      return {
        requests: stats.requests,
        done: done,
        timeouts: stats.timeouts,
        errors: stats.errors,
        unknown: stats.unknown,
        avgMs: done ? Math.round(stats.totalMs / done) : 0,
        active: stats.active,
        queued: queue.length,
        maxActive: stats.maxActive,
        maxConcurrent: maxConcurrent,
      }
    },
    /** 销毁：所有在等/排队的请求一律 reject，别再让上层干等 */
    destroy(reason) {
      if (destroyed) return
      destroyed = true
      const err = new Error(reason || 'bridge 已销毁')
      pending.forEach((rec) => {
        if (rec.timer) clearTimeout(rec.timer)
        rec.reject(err)
      })
      pending.clear()
      while (queue.length) queue.shift().reject(err)
      stats.active = 0
    },
  }
}
