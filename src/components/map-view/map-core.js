/**
 * 离线底图 + 轨迹叠加：共用的建图逻辑。
 *
 * 为什么集中成一份：App 端只有 renderjs 能拿到 DOM，H5 端走普通 script。
 * 如果两端各写一份建图代码，MapLibre 的初始化、底图图层、轨迹图层、相机、
 * 外边界判断、诊断行立刻会分叉。这里把「建什么图、怎么叠轨迹」收成一份，
 * 两端只是外壳不同（谁提供 DOM 容器、谁负责取字节）。
 *
 * 几个不能忘的约束：
 *  1. 底图源必须是「内存里的 PMTiles」：App 端没有 HTTP 服务，PMTiles 走 URL
 *     就要 Range 请求，必然失败。做法是自定义 Source(getKey/getBytes) 交给
 *     new PMTiles(source)，再 add 进 Protocol，图层 URL 用 pmtiles://<getKey()>。
 *  2. 离线包不含字体包，basemaps 生成的 symbol 层（文字标注）会失败，必须过滤。
 *  3. maplibre-gl v6 是纯具名导出，没有 default，只能 `import * as maplibregl`。
 *  4. v6 的 worker URL 由 import.meta.url 推导，打包后（file:// / 非 http(s)）
 *     会拿到空串 → new Worker('') 必挂。必须显式 setWorkerUrl(blob URL)，
 *     把 worker 源码内联成 blob。这一条在 H5 构建产物里同样成立（worker 文件
 *     不会被 vite 一起产出到 chunk 旁边）。
 *  5. ODbL：界面必须显示 © OpenStreetMap（由组件右下角负责）。
 *  6. 依赖直接走 node_modules：vite.config.js 里 build.target 必须 ≥ es2020，
 *     否则 app-vue 视图层的 esbuild（默认 es6）编不过 maplibre v6 的 BigInt 字面量。
 *     注意 es2019 **也不够**——BigInt 字面量（0n/1n）是 ES2020 特性。
 *     worker 源码用 `?raw` 内联（不经过 esbuild，与 target 无关）。
 */
import * as maplibregl from 'maplibre-gl'
import { PMTiles, Protocol } from 'pmtiles'
import { layers as basemapLayers, namedFlavor } from '@protomaps/basemaps'
import { paletteFor } from './theme.js'
import { trackGeoJSON } from '../../utils/track-geo.js'
import { containerOk, describeValue } from './dom.js'
// worker 源码以原始字符串内联：?raw 不经过 esbuild，worker 里的 BigInt 与
// 打包 target 无关；运行时再由 ensureWorker() 转成 blob URL 交给 setWorkerUrl。
import workerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw'
import { makeMapStatus, formatMapStatus, trimStr } from './map-status.js'
import { toClassicWorkerSource as stripModuleSyntax, deriveSiblingUrl } from './worker-src.js'
// Protocol 注册表的回收：pmtiles 没有 remove API，只能直删它的 Map（见该文件顶部注释）
import { evictProtocolEntries } from './protocol-registry.js'
// 按需 Range 读取的数据源与字节缓存（纯函数层，不碰 DOM/plus）
import { createRangeSource, makeByteLru, formatReadStats, MIN_RANGE_BYTES } from './range-source.js'

// 诊断行的拼装与状态对象在 map-status.js（逻辑层也要用，但不能引这个文件）
export { makeMapStatus, formatMapStatus }

export const TRACK_COLOR = '#2bd45c'
export const TRACK_WIDTH = 4
export const ATTRIBUTION = '© OpenStreetMap'

/** 地图源在 style / protocol 里的 key，必须和 getKey() 完全一致 */
const SOURCE_KEY = 'qingdao.pmtiles'
const PROTOCOL_NAME = 'pmtiles'
/** 青岛离线包中心（五四广场附近），仅在拿不到档案头时兜底 */
const DEFAULT_CENTER = [120.3845, 36.0605]
const DEFAULT_ZOOM = 11
/** bbox 判定缓冲（度，约 170m），贴边抖动不算越界 */
const BOUNDS_EPS = 0.0015

// ===== 全局单例：Protocol 与 worker URL 只能注册一次 =====
let protocolInstance = null
let protocolRegistered = false
let workerUrl = ''
let workerUrlSet = false

// maplibre 的 worker.mjs 是 ES 模块，结尾有 `export{dC as default};`；
// 而它按「URL 是否 .mjs/.cjs」决定用 module worker，我们的 blob URL 没有后缀，
// 于是被当成 classic worker —— classic 脚本里出现 export 就是语法错误，真机报
//   Worker failed to load. Check that the worker URL is correct.
// 源码本身是自包含的（末尾 self.worker=new dC(self) 会自启动），所以剥掉模块语法即可。
export function toClassicWorkerSource(src) {
  return stripModuleSyntax(src)
}

/**
 * 把 worker 源码变成可用的 blob URL。
 * 预检只做**纯字符串**判断，不用 new Function：部分 WebView 禁 eval，
 * 且对 506KB 字符串做一次即时编译会拖慢首帧（真机上没必要）。
 */
function ensureWorker(status) {
  if (workerUrlSet) return workerUrl
  workerUrlSet = true
  const classic = toClassicWorkerSource(workerSource)
  const clean =
    classic.length > 1000 &&
    !/\bexport\s*\{/.test(classic) &&
    !/^[ \t]*import\s.*from\s*['"]/m.test(classic)
  try {
    workerUrl = URL.createObjectURL(new Blob([classic], { type: 'text/javascript' }))
    maplibregl.setWorkerUrl(workerUrl)
    if (status) status.worker = 'blob-classic(' + (clean ? 'ok' : 'dirty') + ')'
  } catch (e) {
    if (status) status.worker = 'default(' + ((e && e.message) || 'blob 失败') + ')'
  }
  return workerUrl
}

/** 同源静态 worker 目录（worker.js 与 probe.js 同放此处） */
const WORKER_DIR = 'static/maplibre/'
const WORKER_REL = WORKER_DIR + 'worker.js'
const PROBE_REL = WORKER_DIR + 'probe.js'

/**
 * 候选「目录」列表（不是文件）：probe 与 worker 同目录，探测一个就能推断另一个。
 * 最可靠的一条来自「已经读通的瓦片绝对地址」——它证明那个源可访问。
 */
export function workerDirCandidates(hintAbs) {
  const list = []
  const push = (d) => {
    if (d && list.indexOf(d) < 0) list.push(d)
  }
  const derived = deriveSiblingUrl(String(hintAbs || ''), 'static/tiles', WORKER_DIR)
  if (derived) push(derived)
  try {
    if (typeof document !== 'undefined' && document.baseURI) {
      push(new URL(WORKER_DIR, document.baseURI).href)
    }
  } catch (e) {
    /* ignore */
  }
  try {
    if (typeof location !== 'undefined' && location.href) {
      push(new URL(WORKER_DIR, location.href).href)
    }
  } catch (e) {
    /* ignore */
  }
  push(WORKER_DIR)
  return list
}

const tail2 = (u) => String(u).split('/').filter(Boolean).slice(-2).join('/')

/**
 * 用真实 Worker 握手探测一个 URL 能不能当 worker 源。
 * 为什么不用 fetch：真机实测带 `Range` 头的 fetch 会触发 CORS 预检而直接
 * "Failed to fetch"，而 **worker 加载并不走预检** —— 用 fetch 当探针会误判。
 * 这里直接建 worker 并等它回一句话，最贴近真实条件。
 */
export function probeWorker(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    let w = null
    try {
      w = new Worker(url)
    } catch (e) {
      // origin/CSP 违规在这一步同步抛出
      return done('W:' + String((e && e.message) || 'construct').slice(0, 28))
    }
    const t = setTimeout(() => {
      done('timeout')
      try {
        w.terminate()
      } catch (e) {
        /* ignore */
      }
    }, timeoutMs || 1200)
    w.onmessage = (ev) => {
      clearTimeout(t)
      done(ev && ev.data === 'ok' ? 'ok' : 'bad-msg')
      try {
        w.terminate()
      } catch (e) {
        /* ignore */
      }
    }
    w.onerror = (ev) => {
      clearTimeout(t)
      done('E:' + String((ev && ev.message) || 'load-error').slice(0, 28))
      try {
        w.terminate()
      } catch (e) {
        /* ignore */
      }
    }
  })
}

/**
 * 准备 worker 源。真机实测：`new Worker(blobURL)` 被 WebView 策略拦，而瓦片的
 * 同源静态文件能读 —— 说明 blob: 被禁、同源文件可访问。所以优先用同源静态文件，
 * 拿不到再退回 blob；每个候选的失败原因都累积，退回时保留，避免又被覆盖掉。
 *
 * 必须在 new maplibregl.Map() 之前完成，故 async、由调用方 await。
 */
export async function prepareWorker(status, hintAbs) {
  if (workerUrlSet) return workerUrl
  const reasons = []
  for (const dir of workerDirCandidates(hintAbs)) {
    const r = await probeWorker(dir + 'probe.js', 1200)
    if (r !== 'ok') {
      reasons.push(tail2(dir) + '!' + r)
      continue
    }
    workerUrl = dir + 'worker.js'
    maplibregl.setWorkerUrl(workerUrl)
    workerUrlSet = true
    if (status) status.worker = 'file:' + tail2(dir) + '/worker.js'
    return workerUrl
  }
  // 同源文件不可用才退回 blob；把原因拼进状态，别被覆盖
  const r2 = ensureWorker(status)
  if (status) {
    status.worker = 'no-file[' + reasons.slice(0, 2).join(' ') + ']->' + (status.worker || 'blob')
  }
  return r2
}

function ensureProtocol() {
  if (!protocolInstance) protocolInstance = new Protocol()
  if (!protocolRegistered) {
    try {
      maplibregl.addProtocol(PROTOCOL_NAME, protocolInstance.tile)
      protocolRegistered = true
    } catch (e) {
      // 已经注册过（HMR / 二次进入页面）——直接复用
      protocolRegistered = true
    }
  }
  return protocolInstance
}

// ===== 诊断：状态对象与格式化在 map-status.js（两端共用同一份格式） =====

/**
 * H5 端把「Protocol 注册表还剩几条」暴露给自动化脚本。
 *
 * 为什么需要：P0-2（切城市内存泄漏）的判据只能从注册表看 ——
 * 连续切 3 个城市后 `protocol.tiles.size` 不应一直增长。
 * 这是个只读探针，不参与任何业务逻辑；只在有 window 的环境挂，
 * 逻辑层（v8）/ 小程序的全局里没有 window，直接跳过。
 */
function exposeDebug() {
  try {
    if (typeof window === 'undefined') return
    const dbg = window.__mvDebug || (window.__mvDebug = {})
    dbg.protocolSize = () => (protocolInstance && protocolInstance.tiles ? protocolInstance.tiles.size : -1)
    dbg.protocolKeys = () => (protocolInstance && protocolInstance.tiles ? Array.from(protocolInstance.tiles.keys()) : [])
    dbg.workerUrl = () => workerUrl
    // 默认 0：whole 模式下没人会去累加它 —— e2e 正是靠「必须等于 0」证明新代码零进入。
    // （H5 的探测计数由 map-view 逻辑层覆盖成真计数器，这里只在它没设时兜底。）
    if (typeof dbg.rangeProbes !== 'function') dbg.rangeProbes = () => 0
  } catch (e) {
    /* ignore */
  }
}

/**
 * 建图完成后把「读取侧」的只读探针挂到 `window.__mvDebug`（e2e 判据用，不依赖 UI）。
 *   __mvDebug.sourceMode() -> 'range' | 'whole' | 'mixed'
 *   __mvDebug.readStats()  -> { mode, cache:{...}, sources:[{key, mode, stats}] }
 *   __mvDebug.status()     -> 当前诊断状态对象（tiles/err/srcMode/readStats 都在这）
 */
function exposeDebugReadApi(api) {
  try {
    if (typeof window === 'undefined' || !api) return
    const dbg = window.__mvDebug || (window.__mvDebug = {})
    dbg.sourceMode = () => api.getSourceMode()
    dbg.readStats = () => api.getReadStats()
    dbg.status = () => api.status
  } catch (e) {
    /* ignore */
  }
}

/** WebGL 探测：真机能不能跑 MapLibre 全看这一步 */
export function probeWebgl() {
  try {
    const c = document.createElement('canvas')
    const gl =
      c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')
    if (!gl) return false
    // 有的 WebView 会给一个「假 context」，再摸一下真实参数
    const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info')
    return !!(gl.getParameter && (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.VERSION))
  } catch (e) {
    return false
  }
}

// ===== 内存 PMTiles 源（whole 模式，**与旧实现逐字节等价，不许顺手优化**）=====
function memorySource(bytes, key) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return {
    getKey() {
      return key
    },
    getBytes(offset, length) {
      const start = u8.byteOffset + offset
      const end = Math.min(start + length, u8.byteOffset + u8.byteLength)
      return Promise.resolve({ data: u8.buffer.slice(start, end) })
    },
  }
}

/** 瓦片数据源默认策略：'auto' | 'range' | 'whole'（见 resolveSourceMode） */
export const DEFAULT_TILE_SOURCE_MODE = 'auto'

/**
 * **唯一**的数据源分派点（Lead 要求：三级分派集中在一处，
 * 这样「回滚 = 改一个常量」，新文件不被引用就不进包）。
 *
 * archive 两种形态：
 *   - 整包：`{ key, bytes }`            → memorySource（= 今天的行为）
 *   - 按需：`{ key, size, reader }`     → createRangeSource（reader 由 R1/R2 提供）
 *
 * @returns {{source:object, mode:'range'|'whole'}}
 */
export function makeSource(archive, opts) {
  const a = archive || {}
  const o = opts || {}
  const mode = o.mode === 'range' || o.mode === 'whole' ? o.mode : DEFAULT_TILE_SOURCE_MODE
  const key = a.key
  // 门槛：size 明显不可能（<1 KB）一律不认 —— 否则 clampRange 会把所有请求截成 0，
  // pmtiles 解析 header 失败后静默不请求，表现为「纯灰空白 + 0 错误」（真机已复现）。
  const canRange = typeof a.reader === 'function' && Number(a.size) >= MIN_RANGE_BYTES
  const canWhole = !!a.bytes

  if (mode === 'whole') {
    if (!canWhole) throw new Error('whole 模式缺少整包字节：' + key)
    return { source: memorySource(a.bytes, key), mode: 'whole' }
  }
  if (mode === 'range') {
    // 强制按需：能按需就按需；万一探测阶段失败、只拿到整包字节，
    // 也不能硬失败（那会让整张地图退回自绘层）——降级为整包并在诊断里如实显示。
    if (canRange) {
      return { source: createRangeSource({ key: key, size: a.size, reader: a.reader, cache: o.cache }), mode: 'range' }
    }
    if (canWhole) return { source: memorySource(a.bytes, key), mode: 'whole' }
    throw new Error('range 模式既无 reader 也无 bytes：' + key)
  }
  // auto：能按需就按需，否则退回整包
  if (canRange) {
    return { source: createRangeSource({ key: key, size: a.size, reader: a.reader, cache: o.cache }), mode: 'range' }
  }
  if (!canWhole) throw new Error('档案既没有 reader 也没有 bytes：' + key)
  return { source: memorySource(a.bytes, key), mode: 'whole' }
}

// ===== 轨迹 GeoJSON =====
function collectCoords(points) {
  const out = []
  const list = points || []
  for (let i = 0; i < list.length; i++) {
    const lng = Number(list[i] && list[i].lng)
    const lat = Number(list[i] && list[i].lat)
    if (isFinite(lng) && isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      out.push([lng, lat])
    }
  }
  return out
}

/** 轨迹是否有点落在离线包 bbox 之外（超出就回退自绘层） */
export function pointsOutsideBounds(points, b) {
  if (!b) return false
  const coords = collectCoords(points)
  for (let i = 0; i < coords.length; i++) {
    const lng = coords[i][0]
    const lat = coords[i][1]
    if (
      lng < b.minLon - BOUNDS_EPS ||
      lng > b.maxLon + BOUNDS_EPS ||
      lat < b.minLat - BOUNDS_EPS ||
      lat > b.maxLat + BOUNDS_EPS
    ) {
      return true
    }
  }
  return false
}

/** 容器没布局好时（宽高为 0）MapLibre 会建出一张 0×0 的图，必须等 */
export function waitForSize(el, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 6000)
  return new Promise((resolve) => {
    const tick = () => {
      const w = el && (el.clientWidth || el.offsetWidth)
      const h = el && (el.clientHeight || el.offsetHeight)
      if (w > 0 && h > 0) return resolve({ w, h })
      if (Date.now() > deadline) return resolve({ w: w || 0, h: h || 0, timeout: true })
      setTimeout(tick, 80)
    }
    tick()
  })
}

function fitToCoords(map, coords) {
  if (!coords.length) return
  if (coords.length === 1) {
    map.jumpTo({ center: coords[0], zoom: 15 })
    return
  }
  let minLng = coords[0][0]
  let maxLng = coords[0][0]
  let minLat = coords[0][1]
  let maxLat = coords[0][1]
  for (let i = 1; i < coords.length; i++) {
    if (coords[i][0] < minLng) minLng = coords[i][0]
    if (coords[i][0] > maxLng) maxLng = coords[i][0]
    if (coords[i][1] < minLat) minLat = coords[i][1]
    if (coords[i][1] > maxLat) maxLat = coords[i][1]
  }
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: 28, duration: 0, maxZoom: 16 }
  )
}

/**
 * 建图。
 * @param {object} opts
 * @param {HTMLElement} opts.container 已布局好的 DOM 容器
 * @param {Uint8Array}  opts.bytes     .pmtiles 全量字节（内存源，不走 HTTP）
 * @param {object}      opts.status    诊断状态对象（就地更新）
 * @param {Function}    [opts.onOutOfBounds] 轨迹越出 bbox 时回调
 * @param {Function}    [opts.onReady]  map load 后回调
 * @returns {object} 控制器
 */
export function createTrackMap(opts) {
  const container = opts.container
  const status = opts.status || makeMapStatus()
  const onOutOfBounds = typeof opts.onOutOfBounds === 'function' ? opts.onOutOfBounds : null

  // 档案集合：[{ key, bytes }]。多个档案 = 多个 source + 多组图层。
  // 为什么不用 merge 合成一个：pmtiles merge 要求输入严格不相交，而相邻区域在低缩放级
  // 必然共享同一批整瓦片（z0 一块瓦片就是整个地球），实测直接报
  // "2768 overlapping tiles, starting with 0 0 0. Inputs must be disjoint"。
  // 初始视野：优先用城市索引给的中心点。
  // 为什么不信包自带的 centerLon/centerLat：内置青岛包的中心落在胶州湾水面上，
  // 一进地图满屏是水，观感极差（实测截图确认）。索引里的 c 是人工挑的城区坐标。
  const fixedCenter =
    Array.isArray(opts.center) && Number.isFinite(opts.center[0]) && Number.isFinite(opts.center[1])
      ? [Number(opts.center[0]), Number(opts.center[1])]
      : null
  const fixedZoom = Number.isFinite(opts.zoom) ? Number(opts.zoom) : null

  // 两种档案形态都收：整包（bytes）或按需（size + reader）。分派在 makeSource 里。
  const archives = (opts.archives || []).filter(
    (a) => a && a.key && (a.bytes || (typeof a.reader === 'function' && Number(a.size) > 0))
  )
  if (!archives.length) throw new Error('没有可用的瓦片档案')

  ensureWorker(status)
  const protocol = ensureProtocol()
  exposeDebug()

  let bounds = null
  let fitted = false
  let lastPoints = opts.points || []
  let outOfBoundsFired = false
  let destroyed = false
  const tileKeys = {}
  const instances = []
  const sourceIds = {}
  // 本 core 登记进 Protocol 的键（destroy 时按它回收，见 protocol-registry.js）
  const archiveKeys = archives.map((a) => a.key)

  // 主题：'dark' | 'light'。图层不再只生成一次 —— 运行时要能原地换色标
  let themeName = opts.theme === 'light' ? 'light' : 'dark'

  // 按需读取用的共享字节缓存（多个档案共用一个）。
  // ★ whole 模式下**根本不创建**：这是「回退等价性」的一部分 —— 新代码连分配都不做。
  const rangeCache = opts.sourceMode === 'whole' ? null : makeByteLru(opts.byteCacheBytes)
  const sourceRefs = {}
  const sourceModes = {}
  for (let ai = 0; ai < archives.length; ai++) {
    const a = archives[ai]
    const built = makeSource(a, { mode: opts.sourceMode, cache: rangeCache })
    const inst = new PMTiles(built.source)
    protocol.add(inst)
    instances.push(inst)
    sourceIds[a.key] = 1
    sourceRefs[a.key] = built.source
    sourceModes[a.key] = built.mode
  }
  /** 本次建图实际用的数据源形态（诊断行与 e2e 判据都用它） */
  const effectiveMode = (() => {
    const vals = archives.map((a) => sourceModes[a.key])
    const hasRange = vals.indexOf('range') >= 0
    const hasWhole = vals.indexOf('whole') >= 0
    if (hasRange && hasWhole) return 'mixed'
    return hasRange ? 'range' : 'whole'
  })()
  status.srcMode = effectiveMode

  /**
   * 按当前主题生成底图图层。
   * 每个档案要有自己的图层组：basemaps 的 layers() 生成的是绑定到指定 source 名的图层，
   * 多个档案就得生成多份，并把 id 加前缀避免重复 id 报错。
   * 色标见 theme.js（暗/亮各自做过对比度校准，规则写在文件顶部）。
   */
  function buildBaseLayers() {
    const flavor = paletteFor(themeName, namedFlavor(themeName))
    const out = []
    for (let ai = 0; ai < archives.length; ai++) {
      const a = archives[ai]
      // 离线包没有字体包，symbol 层留着只会报错
      const ls = basemapLayers(a.key, flavor, { lang: 'zh' }).filter((l) => l.type !== 'symbol')
      for (let li = 0; li < ls.length; li++) {
        out.push(Object.assign({}, ls[li], { id: a.key + ':' + ls[li].id }))
      }
    }
    return out
  }

  const sources = { track: { type: 'geojson', data: trackGeoJSON(lastPoints) } }
  for (let ai = 0; ai < archives.length; ai++) {
    sources[archives[ai].key] = {
      type: 'vector',
      url: 'pmtiles://' + archives[ai].key,
      attribution: ATTRIBUTION,
    }
  }

  /** 轨迹图层：端点颜色跟随主题（亮色地图上要用深色端点才看得见） */
  function buildTrackLayers() {
    const startFill = themeName === 'light' ? '#ffffff' : '#15151a'
    const endFill = themeName === 'light' ? '#12b14a' : '#7cf29d'
    return [
      {
        id: 'track-line',
        type: 'line',
        source: 'track',
        filter: ['==', ['get', 'kind'], 'line'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': TRACK_COLOR, 'line-width': TRACK_WIDTH },
      },
      {
          id: 'track-gap',
          type: 'line',
          source: 'track',
          filter: ['==', ['get', 'kind'], 'gap'],
          layout: { 'line-join': 'round', 'line-cap': 'butt' },
          paint: {
            // 断档用虚线：明确表示"这段是信号中断的直线估算，不是走过的路"
            'line-color': themeName === 'light' ? '#8a95a5' : '#8b95a2',
            'line-width': 2,
            'line-dasharray': [2, 2],
            'line-opacity': 0.85,
          },
        },
        {
        id: 'track-start',
        type: 'circle',
        source: 'track',
        filter: ['==', ['get', 'kind'], 'start'],
        paint: {
          'circle-radius': 6,
          'circle-color': startFill,
          'circle-stroke-color': TRACK_COLOR,
          'circle-stroke-width': 2,
        },
      },
      {
        id: 'track-end',
        type: 'circle',
        source: 'track',
        filter: ['==', ['get', 'kind'], 'end'],
        paint: {
          'circle-radius': 6,
          'circle-color': endFill,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      },
    ]
  }

  /** 完整 style（切换主题时整体重建；瓦片不用动，矢量包本身不含颜色） */
  function buildStyle() {
    return {
      version: 8,
      sources: sources,
      layers: buildBaseLayers().concat(buildTrackLayers()),
    }
  }

  const style = buildStyle()

  // 容器校验：MapLibre 只接受选择器字符串或真实元素，否则抛
  // "Invalid type: 'container' must be a String or HTMLElement."。这里提前拦，
  // 把「实际拿到的是什么」写进错误消息，免得又在真机上猜。
  if (!containerOk(container)) {
    throw new Error('container 非法：' + describeValue(container) + '（需要 DOM 元素或选择器字符串）')
  }

  const map = new maplibregl.Map({
    container: container,
    style: style,
    center: fixedCenter || DEFAULT_CENTER,
    zoom: fixedZoom || DEFAULT_ZOOM,
    attributionControl: false, // 署名由组件右下角自己画（ODbL 要求必须显示）
    dragRotate: false,
    pitchWithRotate: false,
    fadeDuration: 0,
  })

  const setErr = (m) => {
    status.err = trimStr(m)
  }

  map.on('error', (e) => {
    const m = (e && e.error && e.error.message) || (e && e.message) || 'unknown'
    setErr('map:' + m)
  })

  map.on('sourcedata', (e) => {
    if (!e || !e.tile || !sourceIds[e.sourceId]) return
    try {
      const c = e.tile.tileID && e.tile.tileID.canonical
      if (!c) return
      const k = c.z + '/' + c.x + '/' + c.y
      if (e.tile.state === 'loaded') {
        if (!tileKeys[k]) {
          tileKeys[k] = 1
          status.tiles = Object.keys(tileKeys).length
        }
      }
    } catch (err) {
      /* ignore */
    }
  })

  /** 把各档案的读取统计汇总成诊断行里的一小段（rd:请求/命中/字节/错误） */
  function refreshReadStats() {
    try {
      const agg = { requests: 0, hits: 0, bytes: 0, errors: 0 }
      const keys = Object.keys(sourceRefs)
      for (let i = 0; i < keys.length; i++) {
        const src = sourceRefs[keys[i]]
        const s = src && typeof src.stats === 'function' ? src.stats() : null
        if (!s) continue
        agg.requests += s.requests || 0
        agg.hits += s.hits || 0
        agg.bytes += s.bytes || 0
        agg.errors += s.errors || 0
      }
      if (agg.requests) status.readStats = formatReadStats(agg, 0)
    } catch (e) {
      /* ignore */
    }
  }
  // idle 是「这一屏画完了」的时刻，正好拿来看这屏花了多少次按需读取
  map.on('idle', refreshReadStats)

  map.on('load', () => {
    status.maplibre = 'ok'
    status.err = ''
    if (typeof opts.onReady === 'function') opts.onReady(map)
  })

  // 档案头：bbox 取各档案并集（越界判断用），中心点取第一个档案（空轨迹时的取景）
  Promise.all(
    instances.map((p) =>
      p.getHeader().catch(() => null)
    )
  )
    .then((hs) => {
      const valid = hs.filter((h) => h && isFinite(h.minLon) && isFinite(h.maxLat))
      if (!valid.length) {
        // range 模式下 header 读不出来 = 之后一片空白且**没有任何报错**（pmtiles 会静默放弃）。
        // 这种"无声失败"必须在这里喊出来，否则用户只看到灰底、诊断行还是 tiles:0 err:-。
        if (effectiveMode === 'range' || effectiveMode === 'mixed') {
          const st = sourceRefs[archives[0].key]
          const rs = st && typeof st.stats === 'function' ? st.stats() : null
          setErr(
            'range:文件头读取失败' +
              (rs ? '（请求 ' + rs.requests + ' 次/共 ' + rs.bytes + ' 字节/截断 ' + (rs.clamped || 0) + ' 次）' : '')
          )
        }
        return
      }
      bounds = valid.reduce(
        (acc, h) => ({
          minLon: Math.min(acc.minLon, h.minLon),
          minLat: Math.min(acc.minLat, h.minLat),
          maxLon: Math.max(acc.maxLon, h.maxLon),
          maxLat: Math.max(acc.maxLat, h.maxLat),
        }),
        { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity }
      )
      const h0 = valid[0]
      // 有外部指定中心（城市索引）就不跳到包自带中心：
      // 内置青岛包的中心落在胶州湾水面，跳过去满屏是水。
      if (!fixedCenter && !collectCoords(lastPoints).length) {
        map.jumpTo({
          center: [h0.centerLon || DEFAULT_CENTER[0], h0.centerLat || DEFAULT_CENTER[1]],
          zoom: Math.min(h0.centerZoom || DEFAULT_ZOOM, 13),
        })
      }
      checkBounds()
    })
    .catch((e) => {
      setErr('header:' + ((e && e.message) || String(e)))
    })

  function checkBounds() {
    if (!bounds || outOfBoundsFired || destroyed) return
    if (pointsOutsideBounds(lastPoints, bounds)) {
      outOfBoundsFired = true
      if (onOutOfBounds) onOutOfBounds(trimStr(JSON.stringify(bounds), 120))
    }
  }

  // ===== 主题切换状态机 =====
  // map.setStyle 是异步的：新样式要等 style.load 才算生效。
  // 之前直接用 "themeName === 目标就跳过"，会出两个问题：
  //   ① 连点时第二次被当成"已生效"直接跳过 → 颜色停在中间态（用户看到"要再切一下才行"）
  //   ② 切换途中再次请求，两个 style.load 回调互相覆盖 → 最终色标不确定
  // 这里改成：正在切换时把目标挂起（pending），等 style.load 之后再补一次；
  // 同时给 style.load 兜一个超时，避免回调不触发导致此后永久卡在"切换中"。
  let switching = false
  let pendingTheme = null
  let switchTimer = null

  function doSwitch(next) {
    if (destroyed) return
    switching = true
    themeName = next
    if (switchTimer) clearTimeout(switchTimer)
    const done = (reason) => {
      if (switchTimer) {
        clearTimeout(switchTimer)
        switchTimer = null
      }
      switching = false
      if (destroyed) return
      if (reason === 'load') status.maplibre = 'ok'
      // 切完把轨迹数据补回去（setStyle 会重建所有 source）
      try {
        const src = map.getSource('track')
        if (src && src.setData) src.setData(trackGeoJSON(lastPoints || []))
      } catch (e) {
        /* ignore */
      }
      // 切换途中又有新请求：补切到最新目标
      const p = pendingTheme
      pendingTheme = null
      if (p && p !== themeName) doSwitch(p)
    }
    try {
      map.once('style.load', () => done('load'))
      map.setStyle(buildStyle(), { diff: false })
      // 兜底：style.load 没来也不能永久卡死
      switchTimer = setTimeout(() => done('timeout'), 4000)
    } catch (e) {
      setErr('theme:' + ((e && e.message) || String(e)))
      done('error')
    }
  }

  function requestTheme(t) {
    const next = t === 'light' ? 'light' : 'dark'
    if (destroyed) return themeName
    if (next === themeName && !switching) return themeName
    if (switching) {
      pendingTheme = next
      return themeName
    }
    doSwitch(next)
    return next
  }

  const api = {
    map: map,
    status: status,
    /** 运行时切换地图亮/暗色标：只重建 style，不重新下载瓦片 */
    setTheme(t) {
      return requestTheme(t)
    },
    getTheme() {
      return themeName
    },
    getBounds() {
      return bounds
    },
    /** 本次建图实际用的数据源形态：'range' | 'whole' | 'mixed' */
    getSourceMode() {
      return effectiveMode
    },
    /**
     * 读取统计（诊断行 + e2e 判据）：
     * `mode` 三级实际形态、`cache` LRU 统计、`sources` 每个档案的请求数/命中/字节/错误。
     */
    getReadStats() {
      const out = { mode: effectiveMode, cache: rangeCache ? rangeCache.stats() : null, sources: [] }
      for (let i = 0; i < archives.length; i++) {
        const key = archives[i].key
        const src = sourceRefs[key]
        out.sources.push({
          key: key,
          mode: sourceModes[key],
          stats: src && typeof src.stats === 'function' ? src.stats() : null,
        })
      }
      return out
    },
    setPoints(points) {
      if (destroyed) return
      lastPoints = points || []
      const src = map.getSource('track')
      const gj = trackGeoJSON(lastPoints)
      if (src && src.setData) src.setData(gj)
      const coords = collectCoords(lastPoints)
      if (coords.length) {
        const last = coords[coords.length - 1]
        let needFit = !fitted
        if (!needFit) {
          try {
            needFit = !map.getBounds().contains(last)
          } catch (e) {
            needFit = true
          }
        }
        if (needFit) {
          fitToCoords(map, coords)
          fitted = true
        }
      }
      checkBounds()
    },
    setVisible(v) {
      if (destroyed) return
      if (v) setTimeout(() => !destroyed && map.resize(), 30)
    },
    resize() {
      if (!destroyed) map.resize()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      try {
        map.remove()
      } catch (e) {
        /* ignore */
      }
      // 回收 Protocol 注册表里的条目。
      // pmtiles 的 Protocol 只有 add()/get()、没有 remove()，而它又是模块级单例，
      // 不删就会在切城市时把上一份整包 Uint8Array 永远攥住（青岛 22 MB / 重庆 198 MB）。
      // keysToEvict 只在「该键当前仍指向本实例」时才算可删，所以不会打断活着的地图。
      try {
        evictProtocolEntries(protocol, archiveKeys, instances)
      } catch (e) {
        /* ignore */
      }
      // 按需读取的读者（R1 fetch 的 AbortController / R2 桥接的在途请求）也要收尾，
      // 否则切城市后那些请求会一直挂着、把旧地图的错误打进新地图的诊断行。
      for (let i = 0; i < archives.length; i++) {
        const dispose = archives[i] && archives[i].dispose
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch (e) {
            /* ignore */
          }
        }
      }
      if (rangeCache) {
        try {
          rangeCache.clear()
        } catch (e) {
          /* ignore */
        }
      }
    },
  }

  if (lastPoints && lastPoints.length) api.setPoints(lastPoints)
  exposeDebugReadApi(api)
  return api
}
