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
  try {
    if (!hasPlusIo()) return ''
    return plus.io.convertLocalFileSystemURL(p) || ''
  } catch (e) {
    return ''
  }
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
    list.push('file://' + (abs[0] === '/' ? abs : '/' + abs))
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
 * @returns {boolean} 是否成功发起
 */
export function readTilesViaPlusIo(file, onBase64, onError, absPath) {
  // absPath 给「已下载到 _doc/maps/ 的城市包」用；不传则读包内 _www/static/tiles/
  const www = absPath || tileWww(file)
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
  try {
    plus.io.resolveLocalFileSystemURL(
      www,
      (entry) => {
        entry.file(
          (file) => {
            const fr = new plus.io.FileReader()
            fr.onloadend = () => {
              const raw = (fr.result && (fr.result.data || fr.result)) || ''
              const s = typeof raw === 'string' ? raw : String(raw)
              const i = s.indexOf(',')
              const b64 = i >= 0 ? s.slice(i + 1) : s
              if (!b64) return fail('plus.io 读到空内容')
              onBase64 && onBase64(b64, file && file.size)
            }
            fr.onerror = (e) => fail('FileReader: ' + ((e && e.message) || '未知错误'))
            fr.readAsDataURL(file)
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

/** 视图层用：base64 -> Uint8Array（webview 里一定有 atob） */
export function base64ToBytes(b64) {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}
