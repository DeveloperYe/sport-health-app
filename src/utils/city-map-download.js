/**
 * 城市底图包的下载执行层：多线路自动择优 + 掉速换线 + 三重校验 + 落地。
 *
 * 与 city-maps.js 的分工：
 *  - city-maps.js 管清单/状态/线路清单与测速；
 *  - 这里管"真的把字节弄下来并验证"。
 *
 * 平台差异：
 *  - App：uni.downloadFile（有原生进度、落临时文件），再 moveTo 到 _doc/maps/；
 *  - H5：XHR + onprogress（能中途掐断），字节存 IndexedDB。
 */

import {
  getCity,
  resolveMirrors,
  mirrorLabel,
  formatSpeed,
  formatBytes,
  APP_MAP_DIR,
  markInstalled,
  unmarkInstalled,
  getInstalled,
  setInstalledVerify,
  markDownloadBusy,
} from './city-maps.js'
import { Sha256 } from './sha256.js'
import { idbPut, idbGet, idbDelete, idbKeys } from './idb-tiles.js'
import { shouldSwitchMirror, SLOW_WINDOW_MS } from './mirror-pick.js'
import { checkPmtilesStructure } from './pmtiles-check.js'
import { readAny, fileReaderRead, nativeReadBase64, toBytes, getReadStrategy } from './native-file.js'

const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73] // PMTiles
// 低速阈值与观察窗口都在 mirror-pick.js 里，这里只用 shouldSwitchMirror 判断

export function isAppRuntime() {
  try {
    return typeof plus !== 'undefined' && !!plus.io
  } catch (e) {
    return false
  }
}

export function magicOk(u8) {
  if (!u8 || u8.length < 16) return false
  for (let i = 0; i < MAGIC.length; i++) if (u8[i] !== MAGIC[i]) return false
  return true
}

function hexOfMagic(u8) {
  let s = ''
  for (let i = 0; i < Math.min(12, u8 ? u8.length : 0); i++) {
    const c = u8[i]
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
  }
  return s
}

// ================= App：plus.io 文件操作 =================

function plusResolve(path) {
  return new Promise((resolve, reject) => {
    try {
      plus.io.resolveLocalFileSystemURL(path, (e) => resolve(e), (e) => reject(new Error('resolve(' + path + '): ' + ((e && e.message) || '找不到'))))
    } catch (e) {
      reject(e)
    }
  })
}

function plusDir(path, create) {
  return new Promise((resolve, reject) => {
    try {
      plus.io.resolveLocalFileSystemURL(
        path,
        (dirEntry) => {
          if (!create) return resolve(dirEntry)
          dirEntry.getDirectory(
            'maps',
            { create: true },
            (d) => resolve(d),
            (e) => reject(new Error('getDirectory: ' + ((e && e.message) || '失败')))
          )
        },
        (e) => reject(new Error('resolve(' + path + '): ' + ((e && e.message) || '失败')))
      )
    } catch (e) {
      reject(e)
    }
  })
}

/** 确保 <base>/maps 目录存在 */
function ensureMapsDir(base) {
  return new Promise((resolve, reject) => {
    try {
      plus.io.resolveLocalFileSystemURL(
        base,
        (root) => {
          root.getDirectory(
            'maps',
            { create: true },
            (d) => resolve(d),
            (e) => reject(new Error('getDirectory: ' + ((e && e.message) || '失败')))
          )
        },
        (e) => reject(new Error('resolve(' + base + '): ' + ((e && e.message) || '失败')))
      )
    } catch (e) {
      reject(e)
    }
  })
}

function moveIntoDir(srcEntry, dirEntry, name) {
  return new Promise((resolve, reject) => {
    const doMove = () => {
      srcEntry.moveTo(
        dirEntry,
        name,
        (e) => resolve((e && e.fullPath) || ''),
        (err) => reject(new Error('moveTo: ' + ((err && err.message) || '失败')))
      )
    }
    try {
      // 同名旧文件先删掉，否则 moveTo 可能因已存在而失败
      dirEntry.getFile(
        name,
        { create: false },
        (old) => old.remove(doMove, doMove),
        doMove
      )
    } catch (e) {
      doMove()
    }
  })
}

/**
 * 保存下载好的包。
 * 主路径 _doc/maps/（应用私有目录，任何 Android 版本都不需要存储权限）；
 * 万一写不进去（个别 ROM 会限制），退到 _downloads/maps/；
 * 再不行就把临时文件本身当包（记录路径，地图照样能加载），并如实回报尝试过程。
 * @returns {Promise<{ok:boolean, path:string, full?:string, fallbackTemp?:boolean, tried:string[]}>}
 */
export async function saveAppPack(tempPath, adcode) {
  const tried = []
  let srcEntry = null
  try {
    srcEntry = await plusResolve(tempPath)
  } catch (e) {
    tried.push('打不开临时文件: ' + ((e && e.message) || e))
    return { ok: false, path: '', tried }
  }
  for (const base of ['_doc/', '_downloads/']) {
    try {
      const dir = await ensureMapsDir(base)
      const full = await moveIntoDir(srcEntry, dir, adcode + '.pmtiles')
      return { ok: true, path: base + 'maps/' + adcode + '.pmtiles', full: full, tried: tried }
    } catch (e) {
      tried.push(base + ' → ' + ((e && e.message) || e))
    }
  }
  return { ok: true, path: tempPath, fallbackTemp: true, tried: tried }
}

/** 临时文件 → _doc/maps/<adcode>.pmtiles */
function moveToMapsDir(tempPath, adcode) {
  return new Promise(async (resolve, reject) => {
    try {
      const srcEntry = await plusResolve(tempPath)
      const mapsDir = await plusDir('_doc/', true)
      // 先删同名旧文件，避免 moveTo 因已存在而失败
      try {
        mapsDir.getFile(
          adcode + '.pmtiles',
          { create: false },
          (old) => old.remove(() => {}, () => {}),
          () => {}
        )
      } catch (e) {
        /* ignore */
      }
      srcEntry.moveTo(
        mapsDir,
        adcode + '.pmtiles',
        (e) => resolve(e.fullPath || APP_MAP_DIR + adcode + '.pmtiles'),
        (err) => reject(new Error('moveTo: ' + ((err && err.message) || '失败')))
      )
    } catch (e) {
      reject(e)
    }
  })
}

function fileSize(path) {
  // 统一走 openAppFile（内部带 6 秒硬超时），避免这里成为新的卡死点
  return openAppFile(path, 6000).then((f) => (f && f.size) || 0)
}

/**
 * App 端读文件：分块 → 字节。**每一步都有硬超时**。
 *
 * 之前这里没有超时，plus.io.FileReader 对 Blob 不响应时 Promise 永不 settle，
 * 表现就是下载到 100% 后永远卡在"校验 SHA-256…"。现在任何一步拿不到就返回 null，
 * 由调用方退化为「字节数 + 头尾魔数」校验，绝不阻塞用户。
 */
function b64ToBytes$app(raw) {
  if (raw && raw.byteLength !== undefined && typeof raw.byteLength === 'number') return new Uint8Array(raw)
  const s = typeof raw === 'string' ? raw : String((raw && (raw.data || raw)) || '')
  const i = s.indexOf(',')
  const b64 = i >= 0 ? s.slice(i + 1) : s
  if (!b64) return null
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k)
  return u8
}

/** 打开文件条目（带超时） */
function openAppFile(path, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => {
      if (!done) {
        done = true
        resolve(null)
      }
    }, timeoutMs || 6000)
    try {
      plus.io.resolveLocalFileSystemURL(
        path,
        (entry) => {
          entry.file(
            (file) => {
              if (done) return
              done = true
              clearTimeout(t)
              resolve(file)
            },
            () => {
              if (done) return
              done = true
              clearTimeout(t)
              resolve(null)
            }
          )
        },
        () => {
          if (done) return
          done = true
          clearTimeout(t)
          resolve(null)
        }
      )
    } catch (e) {
      if (!done) {
        done = true
        clearTimeout(t)
        resolve(null)
      }
    }
  })
}

/**
 * 读 file 的 [start,end) 区间。
 * 走 native-file.js 的多路径：FileReader（整文件 / 分块、arraybuffer / dataurl）→
 * Native.js（RandomAccessFile + Base64）。
 * 真机上 FileReader 会读出空内容（实测），那时必须靠 Native 兜底，否则功能整条不可用。
 */
function readBlobPart(file, start, end, timeoutMs, absPath) {
  return readAny(file, {
    start: start,
    end: end,
    timeoutMs: timeoutMs || 6000,
    absPath: absPath || '',
  }).then((r) => (r && r.ok && r.bytes ? r.bytes : null))
}

/**
 * 分块算 SHA-256。
 * @param {string} path 绝对路径
 * @param {(done:number,total:number)=>void} [onProgress]
 * @param {number} [budgetMs] 总时间预算，超了就放弃（返回 ok:false）
 */
export async function hashAppFile(path, onProgress, budgetMs) {
  const budget = budgetMs || 25000
  const startedAt = Date.now()
  const file = await openAppFile(path, 6000)
  if (!file) return { ok: false, err: '打不开文件条目' }
  const total = file.size || 0
  if (!total) return { ok: false, err: '文件为空' }
  if (typeof file.slice !== 'function') return { ok: false, err: '此环境 File 不支持 slice' }

  const CH = 1024 * 1024
  const h = new Sha256()
  let off = 0
  while (off < total) {
    if (Date.now() - startedAt > budget) return { ok: false, err: '超出时间预算', partial: off, total }
    const end = Math.min(off + CH, total)
    const u8 = await readBlobPart(file, off, end, 8000, absPathOf(path))
    if (!u8) return { ok: false, err: '读分块失败 @' + off, partial: off, total }
    h.update(u8)
    off = end
    if (onProgress) onProgress(off, total)
  }
  return { ok: true, hex: h.digest(), mode: 'slice' }
}

/**
 * App 端组合校验：字节数 → 头尾魔数 → 全量 SHA-256（有时间预算）。
 * 全量摘要算不出来时退化为结构校验，并在 level 里如实标注，绝不卡住。
 * PMTiles v3 文件头与「末尾 127 字节的 trailer」都以 "PMTiles" 魔数开头，
 * 所以头尾都对 = 文件没被截断、也没拿到错误页。
 * @returns {Promise<{ok:boolean, level:string, hex?:string, size?:number, err?:string}>}
 */
/**
 * 原生 SHA-256（Android Native.js → Java MessageDigest）。
 *
 * 为什么要它：纯 JS 实现实测约 48 MB/s（bg1 的 V8；手机更慢 3–5 倍），
 * 而慢的大头其实是"读文件"（FileReader 走 base64，JS 逐字符解码）。
 * 走 Java 侧 readAllBytes + MessageDigest，两个问题一起绕开，
 * 36 MB 包理论 0.1–0.3 s。
 *
 * 失败一律返回 null，由调用方退回 JS 实现 —— 绝不因为原生不可用而不校验。
 * 大包（>128 MB）不读进内存，也返回 null。
 */
function nativeSha256Hex(absPath, size) {
  try {
    if (typeof plus === 'undefined' || !plus.android) return null
    if (!absPath) return null
    if (size && size > 128 * 1024 * 1024) return null
    const Files = plus.android.importClass('java.nio.file.Files')
    const Paths = plus.android.importClass('java.nio.file.Paths')
    const MessageDigest = plus.android.importClass('java.security.MessageDigest')
    const Base64 = plus.android.importClass('android.util.Base64')
    const bytes = Files.readAllBytes(Paths.get(absPath))
    const md = MessageDigest.getInstance('SHA-256')
    const dig = md.digest(bytes)
    // digest 是 32 字节，转 Base64（NO_WRAP=2）再在 JS 里翻成 hex，最省事且不依赖数组桥接
    const b64 = Base64.encodeToString(dig, 2)
    const bin = atob(String(b64))
    let hex = ''
    for (let i = 0; i < bin.length; i++) hex += ('0' + bin.charCodeAt(i).toString(16)).slice(-2)
    return hex.length === 64 ? hex : null
  } catch (e) {
    return null
  }
}

/** 绝对路径（Native.js 需要真实文件系统路径） */
function absPathOf(relPath) {
  try {
    if (typeof plus !== 'undefined' && plus.io && plus.io.convertLocalFileSystemURL) {
      return plus.io.convertLocalFileSystemURL(relPath) || ''
    }
  } catch (e) {
    /* ignore */
  }
  return ''
}

/**
 * 只做第一层校验：字节数 + PMTiles 结构自洽（读 128 字节，毫秒级）。
 * 下载刚结束用它先给出结论，让用户立刻能用地图。
 */
export async function quickCheckAppFile(path, city) {
  // 结构校验必须"要么很快，要么明确失败"：整体 5 秒封顶。
  // 之前这里没有总上限，加上 FileReader 每条 6 秒的超时，实际能拖到 30 秒。
  const work = (async () => {
    const file = await openAppFile(path, 5000)
    if (!file) return { ok: false, err: '打不开下载后的文件' }
    const size = file.size || 0
    const head = await readBlobPart(file, 0, 128, 2000, absPathOf(path))
    if (!head) return { ok: false, err: '读不出文件头（FileReader 与 Native 都不可用）', size: size }
    const st = checkPmtilesStructure(head, size, city.bytes)
    if (!st.ok) return { ok: false, err: st.reason, size: size }
    return { ok: true, size: size, via: getReadStrategy() || '' }
  })()
  const cap = new Promise((resolve) => setTimeout(() => resolve({ ok: false, err: '结构校验超时（5 秒）' }), 5000))
  return Promise.race([work, cap])
}

export async function verifyAppFile(path, city) {
  const file = await openAppFile(path, 6000)
  if (!file) return { ok: false, level: '', err: '打不开下载后的文件' }
  const size = file.size || 0

  // 第一层：字节数 + PMTiles 结构自洽
  // 头能解析、版本 3、且 tileDataOffset+tileDataLength 必须**正好等于**文件长度
  // —— 截断、补零、HTML 错误页、别的城市的包都会被这一层挡掉，
  // 而它只需要读 128 字节，不依赖 FileReader 能把整个文件读下来。
  const head = await readBlobPart(file, 0, 128, 2000, absPathOf(path))
  if (!head) return { ok: false, level: 'struct', size: size, err: '读不出文件头' }
  const st = checkPmtilesStructure(head, size, city.bytes)
  if (!st.ok) return { ok: false, level: 'struct', size: size, err: st.reason }

  // 第二层：全量 SHA-256（有时间预算；算不出来就退化为结构校验，绝不卡住用户）
  const h = await hashAppFile(path, null, 25000)
  if (h.ok) {
    if (city.sha256 && String(h.hex).toLowerCase() !== String(city.sha256).toLowerCase()) {
      return { ok: false, level: 'sha256', hex: h.hex, err: 'SHA-256 不符（得到 ' + String(h.hex).slice(0, 12) + '…）' }
    }
    return { ok: true, level: 'SHA-256', hex: h.hex, size: size }
  }
  return { ok: true, level: '字节数+结构', size: size, note: h.err || '摘要未计算' }
}

/** 读 _doc/maps/<adcode>.pmtiles 的头部若干字节（判断魔数用） */
export async function readAppHead(adcode, n) {
  const want = n || 16
  const rel = APP_MAP_DIR + adcode + '.pmtiles'
  const file = await openAppFile(rel, 6000)
  if (!file) return null
  return readBlobPart(file, 0, want, 6000, absPathOf(rel))
}

// ================= H5：XHR 下载到 IndexedDB =================

function xhrDownload(url, opts) {
  const onProgress = (opts && opts.onProgress) || function () {}
  const shouldAbort = (opts && opts.shouldAbort) || function () {
    return false
  }
  return new Promise((resolve) => {
    let xhr = null
    let got = 0
    let total = 0
    let t0 = Date.now()
    let windowStart = Date.now()
    let windowBytes = 0
    let lastBps = 0
    const close = (r) => {
      try {
        if (xhr) xhr.abort()
      } catch (e) {
        /* ignore */
      }
      resolve(r)
    }
    try {
      xhr = new XMLHttpRequest()
      xhr.open('GET', url, true)
      xhr.responseType = 'arraybuffer'
      xhr.timeout = 0
      xhr.onprogress = (e) => {
        if (!total) t0 = Date.now()
        got = (e && e.loaded) || 0
        total = (e && e.total) || 0
        windowBytes = got
        const now = Date.now()
        if (now - windowStart >= 1500) {
          lastBps = (windowBytes * 1000) / Math.max(1, now - windowStart)
          windowStart = now
          windowBytes = 0
        }
        onProgress(got, total, lastBps)
        if (shouldAbort(lastBps, got, total)) close({ ok: false, abort: true, err: '速度过低已中止', got })
      }
      xhr.onload = () => {
        const ab = xhr.response
        if (!ab || !ab.byteLength) return close({ ok: false, err: 'HTTP ' + xhr.status + ' 空响应' })
        const u8 = new Uint8Array(ab)
        close({ ok: true, bytes: u8, bps: (u8.length * 1000) / Math.max(1, Date.now() - t0) })
      }
      xhr.onerror = () => close({ ok: false, err: '网络错误' })
      xhr.ontimeout = () => close({ ok: false, err: '超时' })
      xhr.send()
    } catch (e) {
      close({ ok: false, err: (e && e.message) || String(e) })
    }
  })
}

function uniDownload(url, opts) {
  const onProgress = (opts && opts.onProgress) || function () {}
  const onSlow = (opts && opts.hasNextMirror) || null
  return new Promise((resolve) => {
    let task = null
    let t0 = 0
    let windowStart = 0
    let windowBytes = 0
    let lastBps = 0
    let stallTimer = null
    // App 端必须自己兜超时：uni.downloadFile 不设超时会一直挂着，
    // 那"掉速换线"就永远等不到——手机上一卡住表现为永远下载中。
    const touchStall = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        try {
          if (task && task.abort) task.abort()
        } catch (e) {
          /* ignore */
        }
        resolve({ ok: false, err: '长时间无进度（20s）' })
      }, 20000)
    }
    try {
      task = uni.downloadFile({
        url: url,
        success: (res) => {
          if (stallTimer) clearTimeout(stallTimer)
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400 && res.tempFilePath) {
            resolve({ ok: true, tempFilePath: res.tempFilePath })
          } else {
            resolve({ ok: false, err: 'HTTP ' + res.statusCode })
          }
        },
        fail: (err) => {
          if (stallTimer) clearTimeout(stallTimer)
          resolve({ ok: false, err: (err && err.errMsg) || '下载失败' })
        },
      })
      touchStall()
      if (task && task.onProgressUpdate) {
        let prev = 0
        task.onProgressUpdate((p) => {
          touchStall()
          const written = p.totalBytesWritten || 0
          const now = Date.now()
          if (!t0) {
            t0 = now
            windowStart = now
          }
          windowBytes += Math.max(0, written - prev)
          prev = written
          if (now - windowStart >= 1500) {
            lastBps = (windowBytes * 1000) / Math.max(1, now - windowStart)
            windowStart = now
            windowBytes = 0
          }
          const overall = (written * 1000) / Math.max(1, now - t0)
          onProgress(written, p.totalBytesExpectedToWrite || 0, lastBps || overall)
          if (
            onSlow &&
            shouldSwitchMirror({
              elapsedMs: now - t0,
              bps: lastBps || overall,
              loadedBytes: written,
              totalBytes: p.totalBytesExpectedToWrite || 0,
              hasNextMirror: onSlow(),
            })
          ) {
            clearTimeout(stallTimer)
            try {
              task.abort && task.abort()
            } catch (e) {
              /* ignore */
            }
            resolve({ ok: false, abort: true, err: '速度过低已中止，换线重下' })
          }
        })
      }
    } catch (e) {
      if (stallTimer) clearTimeout(stallTimer)
      resolve({ ok: false, err: (e && e.message) || String(e) })
    }
  })
}

// ================= 对外：下载一个城市 =================

/**
 * @param {string} adcode
 * @param {{onProgress?:Function, onLog?:Function}} [opts]
 *   onProgress({phase,loaded,total,bps,mirror,note})
 *   phase: 'probe' | 'download' | 'verify' | 'save' | 'done'
 * @returns {Promise<{ok:boolean, err?:string, mirror?:string, bps?:number, verified?:string}>}
 */
export async function downloadCity(adcode, opts) {
  const city = getCity(adcode)
  if (!city) return { ok: false, err: '清单里没有这个城市: ' + adcode }
  const onProgress = (opts && opts.onProgress) || function () {}
  const onLog = (opts && opts.onLog) || function () {}

  // 1) 选线路（用户手动指定过就先用它，绕过测速）
  let r = null
  const prefer = (opts && opts.preferPrefix) || ''
  if (prefer !== '') {
    onLog('手动指定线路：' + mirrorLabel(prefer))
    r = { order: [prefer], best: null, fromCache: false, failed: [] }
  } else {
    onProgress({ phase: 'probe', note: '测速中…' })
    r = await resolveMirrors(city.url, (msg) => onProgress({ phase: 'probe', note: msg }))
  }
  if (r.best) {
    onLog('用线路：' + mirrorLabel(r.best.prefix) + ' ' + formatSpeed(r.best.bps) + (r.fromCache ? '（缓存结果）' : r.partial ? '（测速未完成，先用当前最优）' : ''))
  } else if (r.startedMeasure || r.partial) {
    onLog('按默认线路开始下载（后台测速中，太慢会自动换线）')
  } else {
    onLog('测速全部失败，按兜底顺序逐条尝试')
  }

  // 2) 逐条线路尝试
  markDownloadBusy(true)
  try {
  let attempt = 0
  for (let mi = 0; mi < r.order.length; mi++) {
    const prefix = r.order[mi]
    const label = mirrorLabel(prefix)
    const url = prefix + city.url
    attempt++
    onLog('第 ' + attempt + ' 次尝试：' + label)
    let res = null

    if (isAppRuntime()) {
      res = await uniDownload(url, {
        onProgress: (loaded, total, bps) =>
          onProgress({ phase: 'download', loaded, total, bps, mirror: label, note: label }),
        // 还有后备线路时，允许"掉速自动换线"（之前只有 H5 分支有）
        hasNextMirror: () => mi < r.order.length - 1,
      })
      if (res.ok) {
        const sz = await fileSize(res.tempFilePath)
        if (city.bytes && sz !== city.bytes) {
          onLog('字节数不符（' + sz + ' ≠ ' + city.bytes + '），换线重下')
          res = { ok: false, err: 'size mismatch' }
        }
      }
    } else {
      let lastBps = 0
      let startTs = Date.now()
      res = await xhrDownload(url, {
        onProgress: (loaded, total, bps) => {
          lastBps = bps
          onProgress({ phase: 'download', loaded, total, bps, mirror: label, note: label })
        },
        // 掉速换线：跑过 6 秒、速度低于阈值、且还有下一条线路可用
        shouldAbort: (bps, loaded) =>
          shouldSwitchMirror({
            elapsedMs: Date.now() - startTs,
            bps: bps,
            loadedBytes: loaded,
            totalBytes: city.bytes,
            hasNextMirror: mi < r.order.length - 1,
          }),
      })
      if (res.ok && city.bytes && res.bytes.length !== city.bytes) {
        onLog('字节数不符（' + res.bytes.length + ' ≠ ' + city.bytes + '），换线重下')
        res = { ok: false, err: 'size mismatch' }
      }
    }

    if (!res || !res.ok) {
      onLog('失败：' + ((res && res.err) || '未知'))
      continue
    }

    // 3) 校验
    onProgress({ phase: 'verify', note: '校验中…' })
    let hex = ''
    let mode = ''
    let hashLater = false
    if (isAppRuntime()) {
      // App：先做毫秒级的结构校验（字节数 + 头/索引/长度自洽），
      // 小包当场算完全量摘要；大包先落地、摘要放后台核对，
      // 让「下载完成」不被十几秒的哈希拖住。
      onProgress({ phase: 'verify', note: '校验文件结构…' })
      const q = await quickCheckAppFile(res.tempFilePath, city)
      if (!q.ok) {
        // 读不出内容属于"本机读取通道不可用"，换线路也没用 —— 直接停，别白耗 4 条线
        const readFail = /读不出|超时/.test(q.err || '')
        if (readFail) {
          return {
            ok: false,
            err:
              '下载成功（' + formatBytes(city.bytes) + '），但本机读不出文件内容：' +
              (q.err || '') +
              '。请到「诊断 → 存储自检」看哪条读取通道可用并反馈。',
          }
        }
        onLog('结构校验失败：' + q.err + '，换线重下')
        continue
      }
      const small = (city.bytes || 0) <= 8 * 1024 * 1024
      if (small) {
        // 小包：全量摘要能在一两秒内算完，直接同步做完，结论最硬
        const v = await verifyAppFile(res.tempFilePath, city)
        if (!v.ok) {
          onLog('校验失败：' + (v.err || v.level) + '，换线重下')
          continue
        }
        hex = v.hex || ''
        mode = v.level
      } else {
        mode = '字节数+结构'
        hashLater = true
      }
    } else {
      if (!magicOk(res.bytes)) {
        onLog('不是 PMTiles（头部 "' + hexOfMagic(res.bytes) + '"），换线重下')
        continue
      }
      hex = new Sha256().update(res.bytes).digest()
      mode = 'SHA-256'
    }

    // 只有拿到全量摘要才比对 sha256；退化为结构校验时跳过这一步
    if (mode === 'SHA-256' && city.sha256 && String(hex).toLowerCase() !== String(city.sha256).toLowerCase()) {
      onLog('SHA-256 不符（得到 ' + String(hex).slice(0, 12) + '…），换线重下')
      continue
    }

    // 4) 落地
    onProgress({ phase: 'save', note: '保存中…' })
    let savedPath = ''
    if (isAppRuntime()) {
      let sv = null
      try {
        // 移动可能不回调，20 秒拿不到结果就当失败，免得永远停在「保存中」
        sv = await Promise.race([
          saveAppPack(res.tempFilePath, city.adcode),
          new Promise((_, rej) => setTimeout(() => rej(new Error('移动超时（20s）')), 20000)),
        ])
      } catch (e) {
        return { ok: false, err: '保存失败: ' + ((e && e.message) || e) }
      }
      if (!sv || !sv.ok) {
        return { ok: false, err: '保存失败: ' + ((sv && sv.tried && sv.tried.join(' | ')) || '未知原因') }
      }
      savedPath = sv.path || ''
      if (sv.tried && sv.tried.length) onLog('保存目录有退路：' + sv.tried.join(' | '))
      if (sv.fallbackTemp) onLog('提示：未能移动到正式目录，暂用临时文件（重启后可能失效）')
    } else {
      await idbPut(city.adcode, res.bytes)
    }

    markInstalled(city, { path: savedPath || undefined })
    if (hashLater) {
      // 摘要后台跑：先让用户能立刻切城市，算完再把状态写进已装记录
      setInstalledVerify(city.adcode, 'pending', '')
      verifyCityBackground(city.adcode, {
        onMismatch: (c) => {
          try {
            uni.showModal({
              title: '离线包校验失败',
              content: '「' + c.name + '」的包内容与官方摘要不一致，已自动删除，请重新下载。',
              showCancel: false,
            })
          } catch (e) {
            /* ignore */
          }
        },
      })
      onLog('完成：' + label + '，' + formatBytes(city.bytes) + '，结构校验通过（SHA-256 后台核对中）')
    } else {
      setInstalledVerify(city.adcode, mode === 'SHA-256' ? 'SHA-256' : '字节数+结构', hex)
      onLog('完成：' + label + '，' + formatBytes(city.bytes) + '，' + mode + ' 校验通过')
    }
    onProgress({ phase: 'done', loaded: city.bytes, total: city.bytes, note: '已完成' })
    return { ok: true, mirror: label, verified: hex, verifyPending: hashLater }
  }

  return { ok: false, err: '所有线路都失败了（共 ' + r.order.length + ' 条）' }
  } finally {
    markDownloadBusy(false)
  }
}

// ================= 后台校验（不阻塞用户） =================
// 大包（> 8 MB）下载完成后先把包标记为"可用（结构已校验）"，全量 SHA-256 排队在后台算。
// 好处：用户不用等十几秒哈希就能切城市；坏包算出来再自动删掉并提示。

const verifyQueue = []
let verifyRunning = false

/**
 * 排队给某个已装城市做全量摘要核对。
 * @param {string} adcode
 * @param {{onDone?:Function, onMismatch?:Function}} [opts]
 */
export function verifyCityBackground(adcode, opts) {
  verifyQueue.push({ adcode: String(adcode), opts: opts || {} })
  runVerifyQueue()
}

async function runVerifyQueue() {
  if (verifyRunning) return
  verifyRunning = true
  try {
    while (verifyQueue.length) {
      const job = verifyQueue.shift()
      try {
        await verifyOneCity(job.adcode, job.opts)
      } catch (e) {
        /* 单个失败不影响队列 */
      }
    }
  } finally {
    verifyRunning = false
  }
}

async function verifyOneCity(adcode, opts) {
  const city = getCity(adcode)
  const rec = getInstalled()[adcode]
  if (!city || !rec) return
  // 已经做过全量摘要就别重复算
  if (rec.verify === 'SHA-256') return

  let hex = ''
  if (isAppRuntime()) {
    const rel = APP_MAP_DIR + adcode + '.pmtiles'
    hex = nativeSha256Hex(absPathOf(rel), rec.bytes || 0) || ''
    if (!hex) {
      // 原生不可用就退回 JS 分块（后台跑，预算放宽到 60 秒，用户感觉不到）
      const h = await hashAppFile(rel, null, 60000)
      if (h.ok) hex = h.hex
    }
    if (!hex) {
      setInstalledVerify(adcode, '字节数+结构', '')
      if (opts.onDone) opts.onDone('字节数+结构')
      return
    }
  } else {
    const bytes = await idbGet(adcode)
    if (!bytes) return
    hex = new Sha256().update(bytes).digest()
  }

  if (city.sha256 && String(hex).toLowerCase() !== String(city.sha256).toLowerCase()) {
    await deleteCity(adcode)
    if (opts.onMismatch) opts.onMismatch(city)
    return
  }
  setInstalledVerify(adcode, 'SHA-256', hex)
  if (opts.onDone) opts.onDone('SHA-256')
}

/** 存储自检：把「能不能写／读／删」和真实路径摊开，交给诊断卡一键运行 */
export async function storageSelfTest() {
  const lines = []
  if (!isAppRuntime()) {
    const keys = await idbKeys()
    lines.push('运行时 H5，用 IndexedDB 存包')
    lines.push('已存 ' + keys.length + ' 个包' + (keys.length ? '：' + keys.join(', ') : ''))
    return { lines }
  }
  lines.push('运行时 App')
  lines.push('_doc 路径: ' + (absPathOf('_doc/') || '(取不到)'))
  lines.push('_downloads 路径: ' + (absPathOf('_downloads/') || '(取不到)'))
  const rel = '_doc/maps/__selftest__.txt'
  // 1) 建目录 + 写文件
  const dir = await ensureMapsDir('_doc/').catch((e) => null)
  if (!dir) {
    lines.push('❌ 无法创建 _doc/maps 目录')
    return { lines }
  }
  lines.push('✅ _doc/maps 目录可创建')
  const body = 'ok-' + Date.now()
  const w = await new Promise((resolve) => {
    dir.getFile(
      '__selftest__.txt',
      { create: true },
      (fe) => {
        fe.createWriter(
          (writer) => {
            writer.onwrite = () => resolve(true)
            writer.onerror = (e) => resolve('写失败: ' + ((e && e.message) || ''))
            try {
              writer.write(body)
            } catch (e) {
              resolve('写异常: ' + ((e && e.message) || e))
            }
          },
          (e) => resolve('createWriter 失败: ' + ((e && e.message) || ''))
        )
      },
      (e) => resolve('getFile 失败: ' + ((e && e.message) || ''))
    )
  })
  lines.push((w === true ? '✅' : '❌') + ' 写测试文件: ' + (w === true ? rel : w))
  // 2) 逐个读取方式试一遍 —— 用户机上 FileReader 能写能删却读不出内容，
  //    必须让 App 自己报出"哪条路能用"，否则只能瞎猜。
  const f2 = await openAppFile(rel, 5000)
  const absRel = absPathOf(rel) || ''
  if (!f2) {
    lines.push('❌ 拿不到文件对象（entry.file 失败）')
  } else {
    const probes = [
      ['FileReader 整文件 readAsArrayBuffer', { asArrayBuffer: true }],
      ['FileReader 整文件 readAsDataURL', { asArrayBuffer: false }],
      ['FileReader 分块 readAsArrayBuffer', { asArrayBuffer: true, start: 0, end: body.length }],
      ['FileReader 分块 readAsDataURL', { asArrayBuffer: false, start: 0, end: body.length }],
    ]
    for (let i = 0; i < probes.length; i++) {
      const name = probes[i][0]
      const opt = probes[i][1]
      const r = await fileReaderRead(f2, {
        asArrayBuffer: opt.asArrayBuffer,
        start: opt.start,
        end: opt.end,
        timeoutMs: 4000,
      })
      if (r && r.ok) {
        const u8 = r.bytes || toBytes(r.b64) || new Uint8Array(0)
        const txt = u8.length ? String.fromCharCode.apply(null, Array.from(u8)) : ''
        lines.push('✅ ' + name + ' → ' + JSON.stringify(txt) + (txt === body ? '' : '（内容不符）'))
      } else {
        lines.push('❌ ' + name + '（' + ((r && r.err) || '未知') + '）')
      }
    }
    // Native.js 两条路
    const nb = nativeReadBase64(absRel, 0, body.length)
    let ntxt = ''
    if (nb) {
      const u8 = toBytes(nb)
      ntxt = u8 && u8.length ? String.fromCharCode.apply(null, Array.from(u8)) : ''
    }
    lines.push((nb ? '✅' : '❌') + ' Native 分块 Base64' + (nb ? ' → ' + JSON.stringify(ntxt) : '（不可用）'))
    const nw = nativeReadBase64(absRel)
    lines.push((nw ? '✅' : '❌') + ' Native 整文件 Base64' + (nw ? '（' + nw.length + ' 字符）' : '（不可用）'))
    lines.push('当前选用读取方式: ' + (getReadStrategy() || '尚未确定'))
  }
  // 3) 删掉
  const del = await new Promise((resolve) => {
    plus.io.resolveLocalFileSystemURL(
      rel,
      (e) => e.remove(() => resolve(true), () => resolve(false)),
      () => resolve(false)
    )
  })
  lines.push((del ? '✅' : '❌') + ' 删除测试文件')
  // 4) 列出已装包
  const rec = getInstalled()
  const names = Object.keys(rec)
  if (!names.length) lines.push('还没有下载过城市包')
  else {
    names.forEach((k) => {
      lines.push('已装 ' + k + ' → ' + (rec[k].path || '(未记录路径)') + '，校验 ' + (rec[k].verify || '未校验'))
    })
  }
  return { lines }
}

/** 删除已下载的城市包 */
export async function deleteCity(adcode) {
  const a = String(adcode)
  if (isAppRuntime()) {
    // 路径可能被保存退路改过（_doc / _downloads / 临时文件），逐个按记录删
    const rec = getInstalled()[a] || {}
    const candidates = [rec.path, APP_MAP_DIR + a + '.pmtiles', '_downloads/maps/' + a + '.pmtiles']
    const seen = {}
    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i]
      if (!p || seen[p]) continue
      seen[p] = 1
      await new Promise((resolve) => {
        try {
          plus.io.resolveLocalFileSystemURL(
            p,
            (entry) => entry.remove(() => resolve(true), () => resolve(false)),
            () => resolve(false)
          )
        } catch (e) {
          resolve(false)
        }
      })
    }
  } else {
    try {
      await idbDelete(a)
    } catch (e) {
      /* ignore */
    }
  }
  unmarkInstalled(a)
  return true
}

/** 读已下载包的完整字节（H5 给地图加载用；App 走 plus.io 分块桥） */
export async function readPackedBytes(adcode) {
  if (isAppRuntime()) return null
  try {
    return await idbGet(String(adcode))
  } catch (e) {
    return null
  }
}