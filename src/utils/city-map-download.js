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
  return new Promise((resolve) => {
    try {
      plus.io.resolveLocalFileSystemURL(
        path,
        (entry) => {
          entry.file((f) => resolve(f.size || 0), () => resolve(0))
        },
        () => resolve(0)
      )
    } catch (e) {
      resolve(0)
    }
  })
}

/**
 * 读 App 端文件并算 sha256。
 * 有 File.slice 就分块喂（内存友好）；没有就整包读（≤40MB 可接受）。
 */
export function hashAppFile(path, onProgress) {
  return new Promise((resolve) => {
    try {
      plus.io.resolveLocalFileSystemURL(
        path,
        (entry) => {
          entry.file(
            (file) => {
              const total = file.size || 0
              const trySlice = typeof file.slice === 'function'
              if (trySlice) {
                const CH = 2 * 1024 * 1024
                const h = new Sha256()
                let off = 0
                const step = () => {
                  if (off >= total) return resolve({ ok: true, hex: h.digest(), mode: 'slice' })
                  const end = Math.min(off + CH, total)
                  const blob = file.slice(off, end)
                  const fr = new plus.io.FileReader()
                  fr.onloadend = () => {
                    try {
                      const raw = fr.result
                      // plus 的 FileReader 对 blob 可能给 dataURL
                      let u8 = null
                      if (raw && raw.byteLength !== undefined) u8 = new Uint8Array(raw)
                      else {
                        const s = String(raw || '')
                        const i = s.indexOf(',')
                        const b64 = i >= 0 ? s.slice(i + 1) : s
                        const bin = atob(b64)
                        u8 = new Uint8Array(bin.length)
                        for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k)
                      }
                      h.update(u8)
                      off = end
                      if (onProgress) onProgress(off, total)
                      step()
                    } catch (e) {
                      resolve({ ok: false, err: (e && e.message) || String(e) })
                    }
                  }
                  fr.onerror = () => resolve({ ok: false, err: 'FileReader 读分块失败' })
                  try {
                    fr.readAsArrayBuffer
                      ? fr.readAsArrayBuffer(blob)
                      : fr.readAsDataURL(blob)
                  } catch (e) {
                    resolve({ ok: false, err: '读分块异常: ' + ((e && e.message) || String(e)) })
                  }
                }
                step()
              } else {
                const fr = new plus.io.FileReader()
                fr.onloadend = () => {
                  try {
                    const s = String((fr.result && (fr.result.data || fr.result)) || '')
                    const i = s.indexOf(',')
                    const b64 = i >= 0 ? s.slice(i + 1) : s
                    const bin = atob(b64)
                    const u8 = new Uint8Array(bin.length)
                    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k)
                    resolve({ ok: true, hex: new Sha256().update(u8).digest(), mode: 'whole' })
                  } catch (e) {
                    resolve({ ok: false, err: (e && e.message) || String(e) })
                  }
                }
                fr.onerror = () => resolve({ ok: false, err: 'FileReader 读整包失败' })
                fr.readAsDataURL(file)
              }
            },
            (e) => resolve({ ok: false, err: 'file(): ' + ((e && e.message) || '失败') })
          )
        },
        (e) => resolve({ ok: false, err: 'resolve(): ' + ((e && e.message) || '失败') })
      )
    } catch (e) {
      resolve({ ok: false, err: (e && e.message) || String(e) })
    }
  })
}

/** 读 _doc/maps/<adcode>.pmtiles 的头部若干字节（判断魔数用） */
export function readAppHead(adcode, n) {
  return new Promise((resolve) => {
    const want = n || 16
    try {
      const entryFind = (entry) => {
        entry.file((file) => {
          const fr = new plus.io.FileReader()
          fr.onloadend = () => {
            try {
              const s = String((fr.result && (fr.result.data || fr.result)) || '')
              const i = s.indexOf(',')
              const b64 = i >= 0 ? s.slice(i + 1) : s
              const bin = atob(b64)
              const u8 = new Uint8Array(Math.min(want, bin.length))
              for (let k = 0; k < u8.length; k++) u8[k] = bin.charCodeAt(k)
              resolve(u8)
            } catch (e) {
              resolve(null)
            }
          }
          fr.onerror = () => resolve(null)
          fr.readAsDataURL(file.slice ? file.slice(0, want) : file)
        }, () => resolve(null))
      }
      plus.io.resolveLocalFileSystemURL(
        APP_MAP_DIR + adcode + '.pmtiles',
        entryFind,
        () => resolve(null)
      )
    } catch (e) {
      resolve(null)
    }
  })
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
    try {
      task = uni.downloadFile({
        url: url,
        success: (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400 && res.tempFilePath) {
            resolve({ ok: true, tempFilePath: res.tempFilePath })
          } else {
            resolve({ ok: false, err: 'HTTP ' + res.statusCode })
          }
        },
        fail: (err) => resolve({ ok: false, err: (err && err.errMsg) || '下载失败' }),
      })
      if (task && task.onProgressUpdate) {
        let prev = 0
        task.onProgressUpdate((p) => {
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

  // 1) 选线路
  onProgress({ phase: 'probe', note: '测速中…' })
  const r = await resolveMirrors(city.url, (msg) => onProgress({ phase: 'probe', note: msg }))
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
      const h = await hashAppFile(res.tempFilePath, (done, total) =>
        onProgress({ phase: 'verify', loaded: done, total, note: '计算 SHA-256…' })
      )
      if (!h.ok) {
        onLog('摘要计算失败：' + h.err + '，换线重下')
        continue
      }
      hex = h.hex
      mode = h.mode
    } else {
      if (!magicOk(res.bytes)) {
        onLog('不是 PMTiles（头部 "' + hexOfMagic(res.bytes) + '"），换线重下')
        continue
      }
      hex = new Sha256().update(res.bytes).digest()
      mode = 'memory'
    }

    if (city.sha256 && hex.toLowerCase() !== String(city.sha256).toLowerCase()) {
      onLog('SHA-256 不符（得到 ' + hex.slice(0, 12) + '…），换线重下')
      continue
    }

    // 4) 落地
    onProgress({ phase: 'save', note: '保存中…' })
    if (isAppRuntime()) {
      try {
        await moveToMapsDir(res.tempFilePath, city.adcode)
      } catch (e) {
        return { ok: false, err: '保存失败: ' + ((e && e.message) || e) }
      }
    } else {
      await idbPut(city.adcode, res.bytes)
    }

    markInstalled(city)
    onLog('完成：' + label + '，' + formatBytes(city.bytes) + '，SHA-256 ' + (mode === 'slice' ? '分块' : '整包') + '校验通过')
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
