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
import { buildAttemptOrder, saneBps, pickTopN } from './mirror-pick.js'

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

export function markInstalled(city, extra) {
  const all = getInstalled()
  all[city.adcode] = {
    adcode: city.adcode,
    name: city.name,
    province: city.province,
    bytes: city.bytes,
    sha256: city.sha256,
    at: Date.now(),
    // 实际落盘路径：_doc 写失败时会退到 _downloads，读的时候必须按记录走
    path: (extra && extra.path) || appMapPath(city.adcode),
  }
  writeJson(K_INSTALLED, all)
}

/** 已装包的实际路径（没有记录时退回默认 _doc/maps/） */
export function getInstalledPath(adcode) {
  const rec = getInstalled()[String(adcode)]
  return (rec && rec.path) || appMapPath(adcode)
}

/** 记录校验档位：'pending' | 'SHA-256' | '字节数+结构' | 'mismatch' */
export function setInstalledVerify(adcode, level, hex) {
  const all = getInstalled()
  const k = String(adcode)
  if (!all[k]) return
  all[k].verify = level
  all[k].verifiedHex = hex || ''
  all[k].verifiedAt = Date.now()
  writeJson(K_INSTALLED, all)
}

export function getInstalledVerify(adcode) {
  const all = getInstalled()
  const r = all[String(adcode)]
  return r ? r.verify || '' : ''
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
// 三种运行环境能力不同：
//  - H5：window.XMLHttpRequest，可设 Range、有 onprogress、可 abort；
//  - App 逻辑层（v8）：**没有 XMLHttpRequest/fetch**（DOM API，页面脚本在 v8 里跑不到），
//    但既有 uni.downloadFile（原生下载器，onProgressUpdate 可靠），
//    也有 plus.net.XMLHttpRequest（5+ 原生 XHR）。两者都要能测。
//
// 审下来修掉的四个问题（原实现）：
//  ① onload 里 `Date.now() - (t0 || Date.now() - 1)`：若服务器没 fire onprogress，
//     耗时会算成 1 ms → 速度被算成几百 MB/s，这条线路永远"最快"。现在 t0 在 send() 时记。
//  ② App 优先用 plus.net.XMLHttpRequest：万一它不 fire onprogress，就会把整个城市包
//     下完才回来（青岛 36 MB × 5 条线路 = 180 MB 流量）。改成优先用 uni.downloadFile，
//     它和真实下载同一个原生引擎，进度回调可靠，收够目标字节立刻 abort。
//  ③ 只测一轮 256/512 KB，噪声大（连 DNS/TLS 握手都算进去）。改成两轮：
//     全部线路并行 256 KB 初测 → 取前两名串行各测 1 MB 复测定位。
//  ④ 全失败时的兜底顺序和"排序"逻辑各写了一份，容易跑偏。统一用 mirror-pick.buildAttemptOrder。
const PROBE_TIMEOUT_MS = 8000
/** 测速总预算：用户要求 10 秒内必须出结果 */
export const MEASURE_BUDGET_MS = 10000
/** 第一轮每条线路的超时（并行） */
const ROUND1_TIMEOUT_MS = 4000
/** 第二轮复测的超时（前两名并行） */
const ROUND2_TIMEOUT_MS = 3500
/** App 端初测字节数（手机流量友好） */
const PROBE_BYTES_APP = 256 * 1024
/** 第二轮复测字节数 */
const PROBE_BYTES_ROUND2 = 1024 * 1024
// 速度钳制（saneBps）与"取前 N 名"（pickTopN）都在 mirror-pick.js 里，便于单测

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
          finish({ ok: true, bps: saneBps((got * 1000) / ms, got, ms), prefix: mirror.prefix, id: mirror.id, probeBytes: got, note: 'xhr-abort' })
        }
      }
      xhr.onload = () => {
        const sz = xhr.response ? xhr.response.byteLength : 0
        if (sz > 0) {
          // t0 在 send() 时就记下了，这里不会出现"耗时 1ms"的假速度
          const ms = Math.max(1, Date.now() - (t0 || Date.now()))
          clearTimeout(timer)
          finish({
            ok: true,
            bps: saneBps((sz * 1000) / ms, sz, ms),
            prefix: mirror.prefix,
            id: mirror.id,
            probeBytes: sz,
            note: sz > bytes * 4 ? 'ignored-range' : 'xhr-full',
          })
        } else {
          clearTimeout(timer)
          finish({ ok: false, err: '空响应', prefix: mirror.prefix, id: mirror.id })
        }
      }
      xhr.onerror = () => {
        clearTimeout(timer)
        finish({ ok: false, err: '网络错误', prefix: mirror.prefix, id: mirror.id })
      }
      t0 = Date.now()
      xhr.send()
    } catch (e) {
      clearTimeout(timer)
      finish({ ok: false, err: (e && e.message) || String(e), prefix: mirror.prefix, id: mirror.id })
    }
  })
}

/**
 * 原生下载器探测：拉 Range 头一段，够了就 abort。
 * 与真实下载同一个引擎，所以测出来的速度和真实下载最相关。
 */
function probeViaDownload(mirror, url, opts) {
  const bytes = (opts && opts.bytes) || PROBE_BYTES_APP
  const timeoutMs = (opts && opts.timeoutMs) || PROBE_TIMEOUT_MS
  const full = mirror.prefix + url
  return new Promise((resolve) => {
    let settled = false
    const t0 = Date.now()
    let task = null
    let maxSeen = 0
    let expected = 0
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
    const timer = setTimeout(() => finish({ ok: false, err: '超时', prefix: mirror.prefix, id: mirror.id }), timeoutMs)
    try {
      task = uni.downloadFile({
        url: full,
        header: { Range: 'bytes=0-' + (bytes - 1) },
        success: () => {
          clearTimeout(timer)
          const ms = Math.max(1, Date.now() - t0)
          // 走到 success 说明服务器没理会 Range（下的是整包）：
          // 用"已知总大小或已收字节"算速率，不要拿目标字节数糊弄（会把快线路算成慢线路）
          const used = expected || maxSeen || bytes
          finish({ ok: true, bps: saneBps((used * 1000) / ms, used, ms), prefix: mirror.prefix, id: mirror.id, probeBytes: used, note: 'native-full' })
        },
        fail: (e) => {
          clearTimeout(timer)
          finish({ ok: false, err: (e && e.errMsg) || '下载失败', prefix: mirror.prefix, id: mirror.id })
        },
      })
      if (task && task.onProgressUpdate) {
        task.onProgressUpdate((p) => {
          const got = (p && p.totalBytesWritten) || 0
          const exp = (p && p.totalBytesExpectedToWrite) || 0
          if (got > maxSeen) maxSeen = got
          if (exp > 0) expected = exp
          if (got >= bytes) {
            clearTimeout(timer)
            const ms = Math.max(1, Date.now() - t0)
            finish({ ok: true, bps: saneBps((got * 1000) / ms, got, ms), prefix: mirror.prefix, id: mirror.id, probeBytes: got, note: 'native-abort' })
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
    // App：优先原生下载器（进度回调可靠、和真实下载同引擎）
    if (typeof uni !== 'undefined' && uni.downloadFile) return probeViaDownload(mirror, url, opts)
    const PX = (() => {
      try {
        return plus.net && plus.net.XMLHttpRequest ? plus.net.XMLHttpRequest : null
      } catch (e) {
        return null
      }
    })()
    if (PX) return probeViaXhr(PX, mirror, url, opts)
    return Promise.resolve({ ok: false, err: 'App 端没有可用的探测通道', prefix: mirror.prefix, id: mirror.id })
  }
  if (typeof XMLHttpRequest === 'undefined') {
    return Promise.resolve({ ok: false, err: '环境无 XMLHttpRequest', prefix: mirror.prefix, id: mirror.id })
  }
  return probeViaXhr(XMLHttpRequest, mirror, url, opts)
}

/**
 * 测速（两轮）：
 *  第一轮：所有可用线路并行各测 256 KB，筛出成功者；
 *  第二轮：前两名串行各测 1 MB 复测，用复测速度定位（并行初测会被自己互相抢带宽）。
 * @param {string} url 原始 GitHub 直链
 * @param {{single?:boolean, onRound?:Function}} [opts] single=true 时只跑第一轮
 */
export async function measureMirrors(url, opts) {
  const o = opts || {}
  const budget = o.budgetMs || MEASURE_BUDGET_MS
  const startedAt = Date.now()
  const left = () => budget - (Date.now() - startedAt)
  const firstBytes = isApp() ? PROBE_BYTES_APP : PROBE_BYTES
  const mates = usableMirrors()

  // 第一轮：全部线路并行，超时按剩余预算收紧
  const r1Timeout = Math.max(800, Math.min(ROUND1_TIMEOUT_MS, left()))
  const first = await Promise.all(mates.map((m) => probeOne(m, url, { bytes: firstBytes, timeoutMs: r1Timeout })))
  let list = first.filter((r) => r.ok && r.bps > 0).sort((a, b) => b.bps - a.bps)
  const failed = first.filter((r) => !r.ok).map((r) => ({ id: r.id, err: r.err }))
  if (o.onRound) o.onRound(1, list)

  // 第二轮：前两名**并行**复测（串行会吃掉一倍预算，10 秒内跑不完）
  if (!o.single && list.length >= 2 && left() > 900) {
    const top = pickTopN(list, 2)
    const byId = {}
    mates.forEach((m) => {
      byId[m.id] = m
    })
    const r2Timeout = Math.max(700, Math.min(ROUND2_TIMEOUT_MS, left() - 300))
    const again = await Promise.all(
      top.map((t) => (byId[t.id] ? probeOne(byId[t.id], url, { bytes: PROBE_BYTES_ROUND2, timeoutMs: r2Timeout }) : null))
    )
    again.forEach((r, i) => {
      if (r && r.ok && r.bps > 0) {
        top[i].bps = r.bps
        top[i].probeBytes = r.probeBytes
        top[i].round2 = true
      }
    })
    top.sort((a, b) => b.bps - a.bps)
    list = top.concat(list.slice(top.length))
  }

  if (list.length) {
    writeJson(K_MIRROR, { at: Date.now(), best: list[0], list: list.slice(0, 4) })
  }
  return { list, failed, elapsedMs: Date.now() - startedAt }
}

// ===== 后台测速：页面一打开就跑，下载时直接用结果，绝不在下载时干等 =====
let measureJob = null
/** 下载进行中计数：边下边测会互相抢带宽，这时测出的速度不可信，不要写缓存 */
let downloadBusy = 0

export function markDownloadBusy(on) {
  downloadBusy = Math.max(0, downloadBusy + (on ? 1 : -1))
}

export function isDownloadBusy() {
  return downloadBusy > 0
}

function jobSnapshot() {
  if (!measureJob) return { running: false, done: false, list: [], failed: [], elapsedMs: 0, url: '' }
  return {
    running: !!measureJob.running,
    done: !!measureJob.done,
    list: measureJob.list || [],
    failed: measureJob.failed || [],
    elapsedMs: measureJob.startedAt ? Date.now() - measureJob.startedAt : 0,
    url: measureJob.url || '',
  }
}

/** 当前后台测速状态（UI 轮询用） */
export function measureState() {
  return jobSnapshot()
}

/**
 * 页面打开时调用：没有新鲜缓存就在后台测速。
 * 幂等：同一 URL 且结果还在有效期内不会重复测。
 * @param {string} url 任意城市的 GitHub 直链（测的是线路快慢，不是某个包）
 * @param {(st:object)=>void} [onUpdate] 每轮结束/整体完成时回调
 * @param {{force?:boolean}} [opts]
 */
export function startMeasureInBackground(url, onUpdate, opts) {
  const o = opts || {}
  if (!o.force) {
    const cached = cachedMirrors()
    if (cached && cached.list && cached.list.length) {
      measureJob = {
        url: url,
        running: false,
        done: true,
        list: cached.list,
        failed: [],
        startedAt: Date.now(),
        finishedAt: Date.now(),
      }
      if (onUpdate) onUpdate(jobSnapshot())
      return Promise.resolve({ list: cached.list, failed: [], fromCache: true })
    }
    if (
      measureJob &&
      measureJob.url === url &&
      (measureJob.running || (measureJob.finishedAt && Date.now() - measureJob.finishedAt < MIRROR_TTL))
    ) {
      if (onUpdate && measureJob.done) onUpdate(jobSnapshot())
      return measureJob.promise
    }
  }
  measureJob = { url: url, running: true, done: false, list: [], failed: [], startedAt: Date.now() }
  const job = measureJob
  job.promise = measureMirrors(url, {
    onRound: (n, list) => {
      job.list = list
      if (onUpdate) onUpdate(jobSnapshot())
    },
  })
    .then((r) => {
      job.list = r.list
      job.failed = r.failed
      job.running = false
      job.done = true
      job.finishedAt = Date.now()
      job.elapsedMs = r.elapsedMs
      if (onUpdate) onUpdate(jobSnapshot())
      return r
    })
    .catch((e) => {
      job.running = false
      job.done = true
      job.finishedAt = Date.now()
      job.failed = [{ id: 'job', err: (e && e.message) || String(e) }]
      if (onUpdate) onUpdate(jobSnapshot())
      return { list: [], failed: job.failed }
    })
  return job.promise
}

function currentJobPromise() {
  return measureJob && measureJob.promise ? measureJob.promise : null
}

/** 读缓存的测速结果（30 分钟内有效） */
export function cachedMirrors() {
  const c = readJson(K_MIRROR, null)
  if (!c || !c.at || Date.now() - c.at > MIRROR_TTL) return null
  return c
}

/**
 * 得到本次下载要用的候选线路顺序。
 * 缓存命中就用缓存（30 分钟），否则现场测；
 * 排序统一交给 mirror-pick.buildAttemptOrder，避免两处逻辑跑偏。
 */
export async function resolveMirrors(url, onProgress) {
  const allPrefixes = usableMirrors().map((m) => m.prefix)

  // 1) 有新鲜缓存（页面打开时后台测过了）：立刻用，零等待
  const cached = cachedMirrors()
  if (cached && cached.list && cached.list.length) {
    return { order: buildAttemptOrder(cached.list, allPrefixes), best: cached.list[0], fromCache: true, waitedMs: 0 }
  }

  // 2) 后台正在测：最多等 1.5 秒拿"已测出来的部分"，绝不在下载时长等
  if (measureJob && measureJob.running) {
    if (onProgress) onProgress('测速进行中，先按已出结果开始…')
    const t0 = Date.now()
    const p = currentJobPromise()
    await Promise.race([p || Promise.resolve(), new Promise((r) => setTimeout(r, 1500))])
    const st = measureState()
    if (st.list && st.list.length) {
      return {
        order: buildAttemptOrder(st.list, allPrefixes),
        best: st.list[0],
        fromCache: false,
        partial: !!st.running,
        waitedMs: Date.now() - t0,
      }
    }
    return { order: allPrefixes, best: null, fromCache: false, partial: true, waitedMs: Date.now() - t0 }
  }

  // 3) 从没测过：立刻开下（默认顺序 v6 优先），测速丢到后台；
  //    途中这条线路若太慢，"掉速换线"会接手。
  if (onProgress) onProgress('首次使用：先按默认线路下载，后台正在测速…')
  startMeasureInBackground(url)
  return { order: allPrefixes, best: null, fromCache: false, partial: true, startedMeasure: true, waitedMs: 0 }
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
