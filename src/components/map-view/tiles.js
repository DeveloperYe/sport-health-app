/**
 * 离线瓦片包的取字节工具（H5 / App 视图层 / App 逻辑层共用）。
 *
 * 设计要点：
 *  - 只做「拿到整个 .pmtiles 的字节」这一件事，不碰 MapLibre；
 *  - 每个候选来源都必须先过 PMTiles magic 校验，否则 404 的 HTML 页也会被
 *    当成瓦片包喂给解码器，最后只报一个看不懂的错；
 *  - App 端没有 HTTP Range 服务，所以走「整包读进内存」，不做 Range 请求；
 *  - plus.io 只在真机存在，全部用 typeof 探测，H5 打包进来也不会炸。
 */

import { nativeReadBase64, readAny } from '../../utils/native-file.js'
// 探测结论的判定与 base64 解码都在纯函数层，便于单测（见 range-source.js / range-bridge.js）
import { classifyProbe, parseContentRange } from './range-source.js'
import { b64ToBytes } from './range-bridge.js'

// PMTiles v3 档案头 7 字节魔数
const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73] // "PMTiles"

// 离线瓦片档案清单：一个档案 = 一个 .pmtiles 文件（放在 src/static/tiles/ 下）。
// 为什么是多档案而不是合并成一个：pmtiles merge 要求输入严格不相交，而相邻区域在
// 低缩放级必然共享同一批整瓦片（z0 一块瓦片就是整个地球），实测会被直接拒绝
// （"2768 overlapping tiles ... Inputs must be disjoint"）。
// 缺文件不致命：逐个加载，取到几个用几个，以后要加城市就往这个数组里加一项。
export const TILE_FILES = [
  // 主城 + 黄岛全区 + 城阳北，bbox 119.50-121.05 / 35.55-36.65，z0-15
  // 单档案：以前用「主城+黄岛」+「旧市区包」两个档案并存，二者约 95% 重叠
  // （旧包只有城阳北 36.35-36.45 那条独有），代价是内存翻倍、图层 57->114、
  // 重叠区双份解析与绘制、APK 多 11.3MB。已合并成一个零重叠的单包。
  'qingdao-all.pmtiles',
]

/** H5：相对构建产物根目录 */
export function tileRel(file) {
  return 'static/tiles/' + file
}
/** App：5+ 运行时里应用资源目录的前缀 */
export function tileWww(file) {
  return '_www/static/tiles/' + file
}

/** App：用户下载的城市包目录（运行时落盘，不进 APK） */
export const USER_MAP_DIR = '_doc/maps/'
export function tileUserPath(file) {
  return USER_MAP_DIR + file
}

/** 传进诊断行前把 URL 缩短，别把整条 file:// 路径塞满屏幕 */
export function shortUrl(u) {
  const s = String(u || '')
  const i = s.indexOf('/static/tiles/')
  return i >= 0 ? s.slice(i + 1) : s.length > 48 ? '…' + s.slice(-47) : s
}

export function pmtilesMagicOk(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0)
  if (u8.length < 127) return false
  for (let i = 0; i < MAGIC.length; i++) {
    if (u8[i] !== MAGIC[i]) return false
  }
  return true
}

export function headAsText(bytes, n) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0)
  let s = ''
  for (let i = 0; i < Math.min(n || 12, u8.length); i++) {
    const c = u8[i]
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
  }
  return s
}

/** plus.io 是否可用（真机才有；H5 / 小程序为 false） */
export function hasPlusIo() {
  try {
    return typeof plus !== 'undefined' && !!plus.io
  } catch (e) {
    return false
  }
}

/** _www/... -> 设备上的绝对路径（拿不到就返回空串） */
export function plusLocalPath(p) {
  const v = String(p || '')
  if (!v) return ''
  // 已经是设备绝对路径（下载退路可能给出 /storage/... ）就别再转换
  if (v.charAt(0) === '/') return v
  try {
    if (!hasPlusIo()) return ''
    return plus.io.convertLocalFileSystemURL(v) || ''
  } catch (e) {
    return ''
  }
}

/**
 * 把「相对路径 / 绝对路径 / file:// URL」统一成 plus.io 能接受的 URL。
 * 为什么要统一：plus.io.resolveLocalFileSystemURL 认 `_doc/...` 相对路径和 `file://`，
 * 但**不认** `/storage/emulated/0/...` 这种裸绝对路径 —— 而下载退路（_downloads 或临时目录）
 * 存下来的正是绝对路径，直接丢进去会解析失败，表现为「下载成功但地图加载不出来」。
 */
export function toPlusUrl(p) {
  const v = String(p || '')
  if (!v) return ''
  if (v.indexOf('file://') === 0) return v
  if (v.charAt(0) === '/') return 'file://' + v
  return v
}

/**
 * 候选 URL，按「最可能成功」排序。
 * 覆盖三种运行形态：
 *  1) H5 dev/build：相对路径 / 绝对路径
 *  2) App：相对路径、_www 前缀、plus 给出的绝对路径（+ file:// 形式）
 *  3) 兜底：让调用方再走 plus.io
 */
export function tileUrlCandidates(file) {
  const rel = tileRel(file)
  const www = tileWww(file)
  const list = []
  try {
    if (typeof location !== 'undefined' && location.href) {
      list.push(new URL(rel, location.href).href)
    }
  } catch (e) {
    /* ignore */
  }
  list.push(rel)
  list.push('/' + rel)
  list.push(www)
  const abs = plusLocalPath(www)
  if (abs) {
    list.push(abs)
    if (abs.indexOf('file://') === 0) list.push(abs.slice(7))
    else list.push('file://' + (abs[0] === '/' ? abs : '/' + abs))
  }
  const seen = {}
  return list.filter((u) => (u && !seen[u] ? ((seen[u] = 1), true) : false))
}

function tryFetch(url) {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => {
      if (!done) {
        done = true
        resolve(r)
      }
    }
    // 超时保护：file:// 下某些 WebView 的 fetch 会一直挂着
    const timer = setTimeout(() => finish({ err: 'fetch 超时' }), 25000)
    try {
      if (typeof fetch !== 'function') {
        clearTimeout(timer)
        return finish({ err: '无 fetch' })
      }
      fetch(url)
        .then((res) => {
          if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status))
          return res.arrayBuffer()
        })
        .then((ab) => {
          clearTimeout(timer)
          const u8 = new Uint8Array(ab)
          if (!pmtilesMagicOk(u8)) throw new Error('非 PMTiles（头部 "' + headAsText(u8) + '"）')
          finish({ bytes: u8 })
        })
        .catch((e) => {
          clearTimeout(timer)
          finish({ err: (e && e.message) || String(e) })
        })
    } catch (e) {
      clearTimeout(timer)
      finish({ err: (e && e.message) || String(e) })
    }
  })
}

function tryXhr(url) {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', url, true)
      xhr.responseType = 'arraybuffer'
      xhr.timeout = 30000
      xhr.onload = () => {
        // file:// 下 status 通常是 0
        const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)
        const ab = xhr.response
        if (!ok || !ab || !ab.byteLength) {
          return resolve({ err: 'HTTP ' + xhr.status + ' len=' + (ab ? ab.byteLength : 0) })
        }
        const u8 = new Uint8Array(ab)
        if (!pmtilesMagicOk(u8)) return resolve({ err: '非 PMTiles（头部 "' + headAsText(u8) + '"）' })
        resolve({ bytes: u8 })
      }
      xhr.onerror = () => resolve({ err: 'XHR 网络/权限错误(status=' + xhr.status + ')' })
      xhr.ontimeout = () => resolve({ err: 'XHR 超时' })
      xhr.send()
    } catch (e) {
      resolve({ err: (e && e.message) || String(e) })
    }
  })
}

/**
 * 依次试 fetch / XHR 读候选 URL。
 * @returns {Promise<{bytes: Uint8Array|null, src: string, err: string}>}
 */
export async function loadTilesFromUrls(urls) {
  const errs = []
  const list = urls && urls.length ? urls : tileUrlCandidates()
  // 把「真正读成功的那条 URL」解析成绝对地址返回出去：
  // App 端要据此推导同源 worker 地址（tiles 能读通，说明该源可访问）。
  const absOf = (u) => {
    try {
      const base = typeof location !== 'undefined' && location.href ? location.href : undefined
      return new URL(u, base).href
    } catch (e) {
      return u
    }
  }
  for (let i = 0; i < list.length; i++) {
    const url = list[i]
    const r1 = await tryFetch(url)
    if (r1.bytes) return { bytes: r1.bytes, src: 'fetch@' + shortUrl(url), err: '', url: url, abs: absOf(url) }
    errs.push('fetch(' + shortUrl(url) + '): ' + r1.err)
    const r2 = await tryXhr(url)
    if (r2.bytes) return { bytes: r2.bytes, src: 'xhr@' + shortUrl(url), err: '', url: url, abs: absOf(url) }
    errs.push('xhr(' + shortUrl(url) + '): ' + r2.err)
  }
  return { bytes: null, src: '', err: errs.slice(0, 4).join(' | '), url: '', abs: '' }
}

/**
 * 用 plus.io 读文件，回调 base64 正文（不含 data: 前缀）。
 * 逻辑层与视图层共用：视图层拿到 base64 自己 atob，逻辑层切成块过桥。
 *
 * 读取顺序（真机实测踩过坑，必须多路径）：
 *   1) Native.js 整文件 Base64 —— Java 侧读，最快最稳；
 *   2) Native.js 分块（3 MB/块，3 的倍数保证 base64 可直接拼接）—— 大文件用；
 *   3) plus.io.FileReader(readAsDataURL) —— 部分机型能写能删却**读空**，
 *      所以它只能当最后一道，且超时后要能继续退。
 * @returns {boolean} 是否成功发起
 */
export function readTilesViaPlusIo(file, onBase64, onError, absPath) {
  // absPath 给「已下载到 _doc/maps/ 的城市包」用；不传则读包内 _www/static/tiles/
  const www = toPlusUrl(absPath || tileWww(file))
  const fail = (m) => {
    try {
      onError && onError(m)
    } catch (e) {
      /* ignore */
    }
  }
  if (!hasPlusIo()) {
    fail('plus.io 不可用')
    return false
  }

  // base64("PMTiles") = "UE1UaWxlcw=="，取前 8 字符做廉价魔数校验。
  // 必须校验：真机上 Native 分块读取会返回"长度正确、内容全 0"的数据，
  // 不校验就会把一堆 0 喂给 PMTiles 解析器，最后报个看不懂的错。
  const MAGIC_B64 = 'UE1UaWxl'
  const looksPmtilesB64 = (b64) => typeof b64 === 'string' && b64.length >= 12 && b64.slice(0, 8) === MAGIC_B64

  // Native 兜底：整文件 → 分块（每块 3 MB，3 的倍数保证 base64 可拼接）
  const viaNative = (abs, size) => {
    if (!abs) return ''
    const whole = nativeReadBase64(abs)
    if (looksPmtilesB64(whole)) return whole
    if (size > 0) {
      const CH = 3 * 1024 * 1024
      const parts = []
      let off = 0
      while (off < size) {
        const end = Math.min(off + CH, size)
        const b = nativeReadBase64(abs, off, end)
        if (!b) {
          parts.length = 0
          break
        }
        parts.push(b)
        off = end
      }
      if (parts.length) {
        const joined = parts.join('')
        if (looksPmtilesB64(joined)) return joined
      }
    }
    return ''
  }

  try {
    plus.io.resolveLocalFileSystemURL(
      www,
      (entry) => {
        entry.file(
          (f) => {
            const size = (f && f.size) || 0
            const abs = plusLocalPath(www) || ''
            let done = false
            const fallbackNative = (msg) => {
              if (done) return
              done = true
              const nb = viaNative(abs, size)
              if (nb) {
                onBase64 && onBase64(nb, size)
                return
              }
              fail(msg)
            }
            // ① FileReader.readAsDataURL —— 真机实测唯一稳定可用的通道；
            //    大文件要等久一点（按 1.5 秒/MB 给，36 MB ≈ 54 秒）
            const waitMs = Math.max(15000, Math.ceil((size / (1024 * 1024)) * 1500))
            const timer = setTimeout(() => fallbackNative('FileReader 读取超时（' + Math.round(waitMs / 1000) + ' 秒）'), waitMs)
            const fr = new plus.io.FileReader()
            fr.onloadend = () => {
              if (done) return
              const raw = (fr.result && (fr.result.data || fr.result)) || ''
              const s = typeof raw === 'string' ? raw : String(raw)
              const i = s.indexOf(',')
              const b64 = i >= 0 ? s.slice(i + 1) : s
              if (!b64) {
                clearTimeout(timer)
                return fallbackNative('FileReader 读到空内容')
              }
              if (!looksPmtilesB64(b64)) {
                clearTimeout(timer)
                done = true
                return fail('读到的内容不是 PMTiles（base64 前 8 字符="' + b64.slice(0, 8) + '"）')
              }
              done = true
              clearTimeout(timer)
              onBase64 && onBase64(b64, size)
            }
            fr.onerror = (e) => {
              clearTimeout(timer)
              fallbackNative('FileReader: ' + ((e && e.message) || '未知错误'))
            }
            try {
              fr.readAsDataURL(f)
            } catch (e) {
              clearTimeout(timer)
              fallbackNative('readAsDataURL 异常: ' + ((e && e.message) || String(e)))
            }
          },
          (e) => fail('file(): ' + ((e && e.message) || '未知错误'))
        )
      },
      (e) => fail('resolve(' + www + '): ' + ((e && e.message) || '找不到文件'))
    )
    return true
  } catch (e) {
    fail('plus.io 异常: ' + ((e && e.message) || String(e)))
    return false
  }
}

/**
 * base64 内容的前 8 字符是否是 PMTiles 魔数。
 * 用在"从桥那边收到 base64 之后"的廉价校验上：
 * 真机 Native 分块读取会返回长度正确但内容全 0 的数据，不校验就会把 0 喂给解析器。
 */
export function isPmtilesBase64(b64) {
  return typeof b64 === 'string' && b64.length >= 12 && b64.slice(0, 8) === 'UE1UaWxl'
}

/** 视图层用：base64 -> Uint8Array（webview 里一定有 atob） */
export function base64ToBytes(b64) {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

// ===== 按需 Range 读取（task-1）=====
//
// 三件事：
//   1) `probeRangeRead()`  视图层：只读 16 字节，判断这个 URL 能不能按需读（R1 判据）
//   2) `fetchRange()`      视图层：真正按 Range 取一段字节（R1 的 reader）
//   3) `openRangeHandle()` / `readRangeB64()`  逻辑层：给 R2 桥接用（file.slice + FileReader）
//
// 为什么探测要单独写：`fetch` 对不支持 Range 的源会**把整个文件吐回来**，
// 22–374 MB 一进内存就白屏/闪退，所以探测必须先看状态码与 Content-Length，
// 判成"整包"时连 body 都不读，直接 cancel。

/** 前 7 字节是不是 PMTiles 魔数（探测只拿 16 字节，不能用要求 ≥127 的 pmtilesMagicOk） */
export function magic7Ok(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0)
  if (u8.length < 7) return false
  for (let i = 0; i < MAGIC.length; i++) if (u8[i] !== MAGIC[i]) return false
  return true
}

/** 纯 JS base64 编码（逻辑层 v8 里不保证有 btoa） */
export function bytesToB64(u8) {
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = u8 || new Uint8Array(0)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += CH[b0 >> 2]
    out += CH[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? CH[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? CH[b2 & 63] : '='
  }
  return out
}

/**
 * 视图层：探测「用 fetch + Range 能否按需读」。
 * 只请求 16 字节；判定交给纯函数 classifyProbe（可在 node 里复现）。
 * @returns {Promise<{ok:boolean, kind:string, detail:string, ms:number, size:number, url:string}>}
 */
export async function probeRangeRead(url, opts) {
  const o = opts || {}
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 400
  const t0 = Date.now()
  const done = (r) => Object.assign({ ms: Date.now() - t0, size: 0, url: url }, r)
  if (typeof fetch !== 'function') return done({ ok: false, kind: 'no-fetch', detail: '环境无 fetch' })
  const Ctl = typeof AbortController !== 'undefined' ? AbortController : null
  const ctl = Ctl ? new Ctl() : null
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      if (ctl) ctl.abort()
    } catch (e) {
      /* ignore */
    }
  }, timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-15' },
      signal: ctl ? ctl.signal : undefined,
    })
    clearTimeout(timer)
    if (!res) return done({ ok: false, kind: 'no-res', detail: '无响应' })
    const status = res.status
    const clenRaw = res.headers && res.headers.get ? res.headers.get('content-length') : null
    const clen = clenRaw === null || clenRaw === undefined || clenRaw === '' ? -1 : Number(clenRaw)
    // ★ 整包大小必须从 Content-Range 的斜杠后面取，**不能用 Content-Length**：
    //   206 响应的 Content-Length 只是这一段的长度（我们只要 16 字节，它就是 16），
    //   把它当成文件大小会让 clampRange 把后续每个请求都截成 0 字节
    //   → pmtiles 解析 header 失败后静默不再请求 → 地图纯灰空白（真机/浏览器已复现）。
    const crRaw = res.headers && res.headers.get ? res.headers.get('content-range') : null
    const cr = parseContentRange(crRaw)
    let totalSize = cr ? cr.total : 0
    if (!res.ok) {
      // 4xx/5xx：也可能是 file:// 的 status 0
      try {
        res.body && res.body.cancel && res.body.cancel()
      } catch (e) {
        /* ignore */
      }
      const j = classifyProbe({ status: status, byteLength: 0 })
      return done({ ok: false, kind: j.kind, detail: j.detail })
    }
    // 一旦判断"忽略 Range、要吐整包"，连 body 都不读，直接放弃（保护内存）
    if (status !== 206 && clen > 4096) {
      try {
        res.body && res.body.cancel && res.body.cancel()
      } catch (e) {
        /* ignore */
      }
      const j = classifyProbe({ status: status, byteLength: 0, contentLength: clen })
      return done({ ok: false, kind: j.kind, detail: j.detail })
    }
    // 正常：只读首块（最多 16 字节）然后取消，绝不把后面的数据拉进来
    let bytes = new Uint8Array(0)
    const rd = res.body && res.body.getReader ? res.body.getReader() : null
    if (rd) {
      const first = await rd.read()
      const v = first && first.value ? first.value : null
      bytes = v ? (v.byteLength > 16 ? v.slice(0, 16) : v) : new Uint8Array(0)
      try {
        await rd.cancel()
      } catch (e) {
        /* ignore */
      }
    } else {
      const ab = await res.arrayBuffer()
      const all = new Uint8Array(ab)
      bytes = all.byteLength > 16 ? all.slice(0, 16) : all
    }
    const j = classifyProbe({
      status: status,
      byteLength: bytes.byteLength,
      contentLength: clen,
      magicOk: magic7Ok(bytes),
    })
    // 200 且只给了 16 字节（WebView 自己裁剪）时，Content-Length 恰好就是总大小可能是巧合，
    // 但也可能是真总大小；206 一律以 Content-Range 为准。两者都拿不到就报 0（调用方会放弃按需）。
    if (!totalSize && status === 200 && clen > 16) totalSize = clen
    return done({
      ok: j.ok,
      kind: j.kind,
      detail: j.detail + (totalSize ? ' size=' + totalSize : ' size=?'),
      size: totalSize,
    })
  } catch (e) {
    clearTimeout(timer)
    if (timedOut) return done({ ok: false, kind: 'timeout', detail: '探测超时（' + timeoutMs + 'ms）' })
    return done({ ok: false, kind: 'error', detail: (e && e.message) || String(e) })
  }
}

/**
 * 视图层：真正按 Range 取一段字节（R1 的 reader）。
 * 契约与 pmtiles 一致：返回**恰好 length 字节**的 ArrayBuffer；拿不到就 throw（绝不返回空/零数据）。
 */
export async function fetchRange(url, offset, length, opts) {
  const o = opts || {}
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 8000
  const want = Math.max(0, Math.floor(Number(length) || 0))
  if (!(want > 0)) return new ArrayBuffer(0)
  if (typeof fetch !== 'function') throw new Error('环境无 fetch')
  const Ctl = typeof AbortController !== 'undefined' ? AbortController : null
  const ctl = Ctl ? new Ctl() : null
  const timer = setTimeout(() => {
    try {
      if (ctl) ctl.abort()
    } catch (e) {
      /* ignore */
    }
  }, timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=' + offset + '-' + (offset + want - 1) },
      signal: ctl ? ctl.signal : undefined,
    })
    clearTimeout(timer)
    if (!res || !res.ok) throw new Error('Range 请求失败：HTTP ' + (res && res.status))
    const clenRaw = res.headers && res.headers.get ? res.headers.get('content-length') : null
    const clen = clenRaw === null || clenRaw === undefined || clenRaw === '' ? -1 : Number(clenRaw)
    // 忽略 Range 返回整包：这种源我们不该走到这里（探测阶段已排除），但防一手
    if (res.status !== 206 && clen > want + 1024) {
      try {
        res.body && res.body.cancel && res.body.cancel()
      } catch (e) {
        /* ignore */
      }
      const err = new Error('Range 未生效（返回整包 ' + clen + ' 字节）')
      err.code = 'RANGE_IGNORED'
      throw err
    }
    const ab = await res.arrayBuffer()
    if (ab.byteLength !== want) {
      const err = new Error('Range 长度不符：期望 ' + want + '，实际 ' + ab.byteLength)
      err.code = 'RANGE_LENGTH_MISMATCH'
      throw err
    }
    return ab
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

/**
 * 逻辑层（v8）：打开一个 .pmtiles 文件句柄（R2 桥接用；调用方缓存它，别每次重建）。
 * @returns {Promise<File|null>} 拿不到返回 null（调用方据此回报错误）
 */
export function openRangeHandle(relPath, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 6000
    const fin = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => fin(null), ms)
    try {
      if (!hasPlusIo()) return fin(null)
      plus.io.resolveLocalFileSystemURL(
        toPlusUrl(relPath),
        (entry) => {
          entry.file((f) => fin(f || null), () => fin(null))
        },
        () => fin(null)
      )
    } catch (e) {
      fin(null)
    }
  })
}

/**
 * 逻辑层（v8）：读文件一段并回 base64（R2 桥接的应答）。
 * 走 native-file 的多路径梯子（真机实测 FileReader.readAsDataURL 是唯一稳定通道）。
 * @returns {Promise<{ok:boolean, b64?:string, err?:string, via?:string}>}
 */
export function readRangeB64(file, absPath, offset, length, timeoutMs) {
  const start = Math.max(0, Math.floor(Number(offset) || 0))
  const end = start + Math.max(0, Math.floor(Number(length) || 0))
  return readAny(file, {
    start: start,
    end: end,
    absPath: absPath || '',
    timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 4000,
  }).then((r) => {
    if (!r || !r.ok) return { ok: false, err: (r && r.err) || '读取失败' }
    if (typeof r.b64 === 'string' && r.b64) return { ok: true, b64: r.b64, via: r.via }
    if (r.bytes && r.bytes.byteLength) return { ok: true, b64: bytesToB64(r.bytes), via: r.via }
    return { ok: false, err: '读到的内容为空' }
  })
}

/** 视图层：base64（桥接应答）→ 字节 */
export function b64ToRangeBytes(b64) {
  return b64ToBytes(b64)
}
