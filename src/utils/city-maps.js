/**
 * 城市离线底图包管理：清单、下载、多加速线路测速、校验、本地存储、当前城市。
 *
 * 数据来源：DeveloperYe/china-offline-basemaps（370 个城市，PMTiles z0–15）。
 * 清单已内置在 src/data/cities-index.json（精简后 116 KB），不依赖网络。
 *
 * 关键设计：
 *  1. **先测速再下载**：每个加速线路探 512 KB，取最快的用；测速失败的一律不用。
 *  2. **下载中掉速自动换线**：低于阈值就中止，换下一条更快的线路重下。
 *  3. **三重校验**：字节数 == 清单里的 bytes；头部是 PMTiles 魔数；全量 sha256 == 清单里的 sha256。
 *  4. 平台分流：App 用 uni.downloadFile 落到 _doc/maps/；H5 用 XHR 存 IndexedDB。
 */

import citiesIndex from '@/data/cities-index.json'
import { Sha256 } from './sha256.js'
import { idbPut, idbGet, idbDelete, idbKeys } from './idb-tiles.js'

// ===== 存储键 =====
const K_INSTALLED = 'fh_map_installed' // { [adcode]: {adcode,name,bytes,sha256,at} }
const K_CURRENT = 'fh_map_current' // adcode 字符串
const K_MIRROR = 'fh_map_mirror_v1' // { at, best, list:[{prefix,bps}] }

// ===== 加速线路（都指向同一个 GitHub Release 直链）=====
// 顺序只是"没测出结果时的兜底顺序"，实际用测速结果排序。
export const MIRRORS = [
  { id: 'v6', prefix: 'https://v6.gh-proxy.org/', label: 'v6 加速' },
  { id: 'ghx', prefix: 'https://gh-proxy.org/', label: 'gh-proxy' },
  { id: 'cdn', prefix: 'https://cdn.gh-proxy.org/', label: 'cdn 加速' },
  { id: 'axis', prefix: 'https://axisnow.gh-proxy.org/', label: 'axisnow' },
  // 直连只在 App 端有意义：浏览器页面直连 github.com 必被 CORS 拦，
  // 探测只会白等 6 秒并往控制台丢两条红字。
  { id: 'direct', prefix: '', label: 'GitHub 直连', appOnly: true },
]

function isAppRuntime() {
  try {
    return typeof plus !== 'undefined' && !!plus.io
  } catch (e) {
    return false
  }
}

/** 当前运行环境下真正可用的线路（H5 排除直连） */
export function usableMirrors() {
  const app = isAppRuntime()
  return MIRRORS.filter((m) => !m.appOnly || app)
}

/** 低于这个速度（字节/秒）就认为"下载速度不够"，换下一条线路 */
const SLOW_BPS = 120 * 1024
/** 测速缓存有效期：30 分钟 */
const MIRROR_TTL = 30 * 60 * 1000
/** 测速探测字节数 */
export const PROBE_BYTES = 512 * 1024

// ===== 清单 =====
export const CITIES = (citiesIndex.cities || []).map((c) => ({
  adcode: c.a,
  name: c.n,
  province: c.p,
  kind: c.k,
  center: c.c,
  bbox: c.b,
  bytes: c.s,
  sha256: c.h,
  url: c.u,
}))

export const INDEX_META = {
  source: citiesIndex.source,
  count: citiesIndex.count,
  totalBytes: citiesIndex.totalBytes,
  generatedAt: citiesIndex.generatedAt,
}

export function getCity(adcode) {
  const a = String(adcode || '')
  for (let i = 0; i < CITIES.length; i++) if (CITIES[i].adcode === a) return CITIES[i]
  return null
}

/** 按关键字搜索（城市名/省份/adcode 都能命中），限制返回条数 */
export function searchCities(keyword, limit) {
  const kw = String(keyword || '').trim()
  if (!kw) return CITIES.slice(0, limit || 20)
  const out = []
  for (let i = 0; i < CITIES.length; i++) {
    const c = CITIES[i]
    if (c.name.indexOf(kw) >= 0 || c.province.indexOf(kw) >= 0 || c.adcode.indexOf(kw) >= 0) {
      out.push(c)
      if (out.length >= (limit || 20)) break
    }
  }
  return out
}

export function formatBytes(n) {
  const v = Number(n) || 0
  if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
  if (v >= 1024) return Math.round(v / 1024) + ' KB'
  return Math.round(v) + ' B'
}

export function formatSpeed(bps) {
  const v = Number(bps) || 0
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB/s'
  return Math.round(v / 1024) + ' KB/s'
}

// ===== 本地状态 =====
function readJson(key, dflt) {
  try {
    const raw = uni.getStorageSync(key)
    if (!raw) return dflt
    if (typeof raw === 'string') {
      // 只解析「看着像 JSON 容器」的字符串。纯数字字符串（城市 adcode 就是 6 位数字）
      // 被 JSON.parse 会变成 number，上层按 string 判断就会拿到空值 —— 这个坑踩过一次。
      const s = raw.trim()
      if (s.charAt(0) !== '{' && s.charAt(0) !== '[') return raw
      try {
        return JSON.parse(s)
      } catch (e) {
        return raw
      }
    }
    return raw
  } catch (e) {
    return dflt
  }
}

function writeJson(key, val) {
  try {
    uni.setStorageSync(key, val)
  } catch (e) {
    /* ignore */
  }
}

export function getInstalled() {
  const o = readJson(K_INSTALLED, {})
  return o && typeof o === 'object' ? o : {}
}

export function isInstalled(adcode) {
  return !!getInstalled()[String(adcode)]
}

export function getCurrent() {
  const a = readJson(K_CURRENT, '')
  if (a === '' || a === null || a === undefined) return ''
  // 兼容历史脏数据（曾经被 JSON.parse 成数字的情况）
  return String(a)
}

export function setCurrent(adcode) {
  const a = String(adcode || '')
  if (a && !isInstalled(a)) return false
  writeJson(K_CURRENT, a)
  return true
}

export function markInstalled(city) {
  const all = getInstalled()
  all[city.adcode] = {
    adcode: city.adcode,
    name: city.name,
    province: city.province,
    bytes: city.bytes,
    sha256: city.sha256,
    at: Date.now(),
  }
  writeJson(K_INSTALLED, all)
}

export function unmarkInstalled(adcode) {
  const all = getInstalled()
  delete all[String(adcode)]
  writeJson(K_INSTALLED, all)
  if (getCurrent() === String(adcode)) writeJson(K_CURRENT, '')
}

// ===== 平台：文件路径 =====
/** App：下载后的包存放目录（plus.io 相对路径） */
export const APP_MAP_DIR = '_doc/maps/'

export function appMapPath(adcode) {
  return APP_MAP_DIR + String(adcode) + '.pmtiles'
}

function isApp() {
  try {
    return typeof plus !== 'undefined' && !!plus.io
  } catch (e) {
    return false
  }
}

// ===== 测速 =====
//
// 同一个探测逻辑要跑在三种环境里，能力完全不同：
//  - H5：浏览器，有 window.XMLHttpRequest，可设 Range、可 onprogress、可 abort；
//  - App 逻辑层（v8）：**没有 XMLHttpRequest / fetch**（那都是 DOM/浏览器 API，
//    页面脚本在 v8 里跑，拿不到 —— 这就是当初地图必须走 renderjs 的原因）。
//    但有 plus.net.XMLHttpRequest（5+ 原生 XHR，绕过 WebView 的 CORS），
//    拿不到时退化到 uni.downloadFile + Range 把头一段字节拉下来再 abort。
//
// 之前只写了 `new XMLHttpRequest()`，App 里直接 ReferenceError，被 catch 成
// 「网络错误」→ 页面一直显示"所有线路未测通"。
const PROBE_TIMEOUT_MS = 8000
/** App 端探测字节数小一点：手机流量 + 原生下载器启动开销 */
const PROBE_BYTES_APP = 256 * 1024

/** 用某个 XHR 实现探测（window.XMLHttpRequest 或 plus.net.XMLHttpRequest 通用） */
function probeViaXhr(Ctor, mirror, url, opts) {
  const bytes = (opts && opts.bytes) || PROBE_BYTES
  const timeoutMs = (opts && opts.timeoutMs) || PROBE_TIMEOUT_MS
  const full = mirror.prefix + url
  return new Promise((resolve) => {
    let settled = false
    let got = 0
    let t0 = 0
    let xhr = null
    const finish = (r) => {
      if (settled) return
      settled = true
      try {
        if (xhr) xhr.abort()
      } catch (e) {
        /* ignore */
      }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, err: '超时', prefix: mirror.prefix, id: mirror.id }), timeoutMs)
    try {
      xhr = new Ctor()
      xhr.open('GET', full, true)
      xhr.responseType = 'arraybuffer'
      try {
        xhr.setRequestHeader('Range', 'bytes=0-' + (bytes - 1))
      } catch (e) {
        /* Range 被拒就走整段，靠 onprogress 截断 */
      }
      xhr.onprogress = (e) => {
        if (!t0) t0 = Date.now()
        got = (e && e.loaded) || 0
        if (got >= bytes) {
          const ms = Math.max(1, Date.now() - t0)
          clearTimeout(timer)
          finish({ ok: true, bps: (got * 1000) / ms, prefix: mirror.prefix, id: mirror.id, probeBytes: got })
        }
      }
      xhr.onload = () => {
        const sz = xhr.response ? xhr.response.byteLength : 0
        // 206 分片或整包都算成功，用字节数/耗时算速率
        if (sz > 0) {
          const ms = Math.max(1, Date.now() - (t0 || Date.now() - 1))
          clearTimeout(timer)
          finish({ ok: true, bps: (sz * 1000) / ms, prefix: mirror.prefix, id: mirror.id, probeBytes: sz })
        } else {
          clearTimeout(timer)
          finish({ ok: false, err: '空响应', prefix: mirror.prefix, id: mirror.id })
        }
      }
      xhr.onerror = () => {
        clearTimeout(timer)
        finish({ ok: false, err: '网络错误', prefix: mirror.prefix, id: mirror.id })
      }
      xhr.send()
    } catch (e) {
      clearTimeout(timer)
      finish({ ok: false, err: (e && e.message) || String(e), prefix: mirror.prefix, id: mirror.id })
    }
  })
}

/** App 兜底探测：原生下载器拉头一段，够了就 abort */
function probeViaDownload(mirror, url, opts) {
  const bytes = (opts && opts.bytes) || PROBE_BYTES_APP
  const timeoutMs = (opts && opts.timeoutMs) || PROBE_TIMEOUT_MS
  const full = mirror.prefix + url
  return new Promise((resolve) => {
    let settled = false
    let t0 = Date.now()
    let task = null
    const finish = (r) => {
      if (settled) return
      settled = true
      try {
        if (task && task.abort) task.abort()
      } catch (e) {
        /* ignore */
      }
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ ok: false, err: '超时', prefix: mirror.prefix, id: mirror.id }),
      timeoutMs
    )
    try {
      task = uni.downloadFile({
        url: full,
        header: { Range: 'bytes=0-' + (bytes - 1) },
        success: () => {
          clearTimeout(timer)
          const ms = Math.max(1, Date.now() - t0)
          // 走到 success 说明服务器没理会 Range（给了整包），但连通性已证明
          finish({ ok: true, bps: (bytes * 1000) / ms, prefix: mirror.prefix, id: mirror.id, probeBytes: bytes, note: 'native-full' })
        },
        fail: (e) => {
          clearTimeout(timer)
          finish({ ok: false, err: (e && e.errMsg) || '下载失败', prefix: mirror.prefix, id: mirror.id })
        },
      })
      if (task && task.onProgressUpdate) {
        task.onProgressUpdate((p) => {
          const got = (p && p.totalBytesWritten) || 0
          if (got >= bytes) {
            clearTimeout(timer)
            const ms = Math.max(1, Date.now() - t0)
            finish({ ok: true, bps: (got * 1000) / ms, prefix: mirror.prefix, id: mirror.id, probeBytes: got, note: 'native-abort' })
          }
        })
      }
    } catch (e) {
      clearTimeout(timer)
      finish({ ok: false, err: (e && e.message) || String(e), prefix: mirror.prefix, id: mirror.id })
    }
  })
}

function probeOne(mirror, url, opts) {
  if (isApp()) {
    // 1) 5+ 原生 XHR：不受 WebView CORS 限制，支持 Range/onprogress/abort
    const PX = (() => {
      try {
        return plus.net && plus.net.XMLHttpRequest ? plus.net.XMLHttpRequest : null
      } catch (e) {
        return null
      }
    })()
    if (PX) return probeViaXhr(PX, mirror, url, { bytes: PROBE_BYTES_APP, timeoutMs: PROBE_TIMEOUT_MS, ...(opts || {}) })
    // 2) 兜底：原生下载器 + Range + abort
    return probeViaDownload(mirror, url, opts)
  }
  if (typeof XMLHttpRequest === 'undefined') {
    return Promise.resolve({ ok: false, err: '环境无 XMLHttpRequest', prefix: mirror.prefix, id: mirror.id })
  }
  return probeViaXhr(XMLHttpRequest, mirror, url, opts)
}

/**
 * 并行测所有线路，返回按速度从快到慢的列表。
 * @returns {Promise<{list: Array<{prefix:string,id:string,bps:number}>, failed: Array<{id:string,err:string}>}>}
 */
export async function measureMirrors(url, opts) {
  const results = await Promise.all(usableMirrors().map((m) => probeOne(m, url, opts)))
  const list = results.filter((r) => r.ok).sort((a, b) => b.bps - a.bps)
  const failed = results.filter((r) => !r.ok).map((r) => ({ id: r.id, err: r.err }))
  const best = list.length ? list[0] : null
  if (best) {
    writeJson(K_MIRROR, { at: Date.now(), best: best, list: list.slice(0, 4) })
  }
  return { list, failed }
}

/** 读缓存的测速结果（30 分钟内有效） */
export function cachedMirrors() {
  const c = readJson(K_MIRROR, null)
  if (!c || !c.at || Date.now() - c.at > MIRROR_TTL) return null
  return c
}

/**
 * 得到本次下载要用的候选线路顺序：最快在前，直连垫底。
 * 用缓存会快，但缓存过期或有新失败时重新测。
 */
export async function resolveMirrors(url, onProgress) {
  const cached = cachedMirrors()
  if (cached && cached.list && cached.list.length) {
    const order = cached.list.map((x) => x.prefix)
    usableMirrors().forEach((m) => {
      if (order.indexOf(m.prefix) < 0) order.push(m.prefix)
    })
    return { order, best: cached.list[0], fromCache: true }
  }
  if (onProgress) onProgress('正在测速选线路…')
  const r = await measureMirrors(url)
  if (!r.list.length) {
    // 测速全失败也要能下载：按可用线路顺序逐条试（哪条通就走哪条）。
    // 早先这里只退 [直连, v6]，手机上直连 GitHub 基本不通，等于只剩一条路。
    const order = usableMirrors().map((m) => m.prefix)
    return { order, best: null, fromCache: false, failed: r.failed }
  }
  const order = r.list.map((x) => x.prefix)
  usableMirrors().forEach((m) => {
    if (order.indexOf(m.prefix) < 0) order.push(m.prefix)
  })
  return { order, best: r.list[0], fromCache: false, failed: r.failed }
}

/** 当前运行环境下探测测速用的通道名（真机排障用，会显示在 UI 上） */
export function probeTransportName() {
  if (isApp()) {
    let hasPx = false
    try {
      hasPx = !!(plus.net && plus.net.XMLHttpRequest)
    } catch (e) {
      hasPx = false
    }
    return hasPx ? 'plus.net.XMLHttpRequest' : 'uni.downloadFile（兜底）'
  }
  return typeof XMLHttpRequest !== 'undefined' ? 'window.XMLHttpRequest' : '环境无 XHR'
}

export function mirrorLabel(prefix) {
  const m = MIRRORS.filter((x) => x.prefix === prefix)[0]
  return m ? m.label : prefix || '直连'
}
