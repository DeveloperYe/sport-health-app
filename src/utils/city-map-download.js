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
} from './city-maps.js'
import { Sha256 } from './sha256.js'
import { idbPut, idbGet, idbDelete } from './idb-tiles.js'
import { shouldSwitchMirror, SLOW_WINDOW_MS } from './mirror-pick.js'
import { checkPmtilesStructure } from './pmtiles-check.js'

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

/** 读 file 的 [start,end) 区间；FileReader 单次操作也有超时 */
function readBlobPart(file, start, end, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => {
      if (!done) {
        done = true
        resolve(null)
      }
    }, timeoutMs || 6000)
    try {
      if (typeof file.slice !== 'function') {
        clearTimeout(t)
        return resolve(null)
      }
      const blob = file.slice(start, end)
      const fr = new plus.io.FileReader()
      fr.onloadend = () => {
        if (done) return
        done = true
        clearTimeout(t)
        try {
          resolve(b64ToBytes$app(fr.result))
        } catch (e) {
          resolve(null)
        }
      }
      fr.onerror = () => {
        if (done) return
        done = true
        clearTimeout(t)
        resolve(null)
      }
      try {
        if (fr.readAsArrayBuffer) fr.readAsArrayBuffer(blob)
        else fr.readAsDataURL(blob)
      } catch (e) {
        if (!done) {
          done = true
          clearTimeout(t)
          resolve(null)
        }
      }
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
    const u8 = await readBlobPart(file, off, end, 8000)
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
export async function verifyAppFile(path, city) {
  const file = await openAppFile(path, 6000)
  if (!file) return { ok: false, level: '', err: '打不开下载后的文件' }
  const size = file.size || 0

  // 第一层：字节数 + PMTiles 结构自洽
  // 头能解析、版本 3、且 tileDataOffset+tileDataLength 必须**正好等于**文件长度
  // —— 截断、补零、HTML 错误页、别的城市的包都会被这一层挡掉，
  // 而它只需要读 128 字节，不依赖 FileReader 能把整个文件读下来。
  const head = await readBlobPart(file, 0, 128, 6000)
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
  const file = await openAppFile(APP_MAP_DIR + adcode + '.pmtiles', 6000)
  if (!file) return null
  return readBlobPart(file, 0, want, 6000)
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
  if (r.best) onLog('最快线路 ' + mirrorLabel(r.best.prefix) + ' ' + formatSpeed(r.best.bps))
  else onLog('测速全部失败，按兜底顺序尝试')

  // 2) 逐条线路尝试
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
    if (isAppRuntime()) {
      // App：字节数 → 头尾魔数 → 全量 SHA-256（有时间预算，绝不卡死）
      onProgress({ phase: 'verify', note: '校验文件完整性…' })
      const v = await verifyAppFile(res.tempFilePath, city)
      if (!v.ok) {
        onLog('校验失败：' + (v.err || v.level) + '，换线重下')
        continue
      }
      hex = v.hex || ''
      mode = v.level
      if (v.level !== 'SHA-256') {
        onLog('提示：全量摘要未算出（' + (v.note || '原因未知') + '），已用「' + v.level + '」校验')
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
    if (isAppRuntime()) {
      try {
        // moveTo 也可能不回调，20 秒拿不到结果就当失败，免得永远停在「保存中」
        await Promise.race([
          moveToMapsDir(res.tempFilePath, city.adcode),
          new Promise((_, rej) => setTimeout(() => rej(new Error('移动超时（20s）')), 20000)),
        ])
      } catch (e) {
        return { ok: false, err: '保存失败: ' + ((e && e.message) || e) }
      }
    } else {
      await idbPut(city.adcode, res.bytes)
    }

    markInstalled(city)
    onLog('完成：' + label + '，' + formatBytes(city.bytes) + '，' + mode + ' 校验通过')
    onProgress({ phase: 'done', loaded: city.bytes, total: city.bytes, note: '已完成' })
    return { ok: true, mirror: label, verified: hex }
  }

  return { ok: false, err: '所有线路都失败了（共 ' + r.order.length + ' 条）' }
}

/** 删除已下载的城市包 */
export async function deleteCity(adcode) {
  const a = String(adcode)
  if (isAppRuntime()) {
    await new Promise((resolve) => {
      try {
        plus.io.resolveLocalFileSystemURL(
          APP_MAP_DIR + a + '.pmtiles',
          (entry) => entry.remove(() => resolve(true), () => resolve(false)),
          () => resolve(false)
        )
      } catch (e) {
        resolve(false)
      }
    })
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
