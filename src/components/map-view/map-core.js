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
import { containerOk, describeValue } from './dom.js'
// worker 源码以原始字符串内联：?raw 不经过 esbuild，worker 里的 BigInt 与
// 打包 target 无关；运行时再由 ensureWorker() 转成 blob URL 交给 setWorkerUrl。
import workerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw'
import { makeMapStatus, formatMapStatus, trimStr } from './map-status.js'

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

function ensureWorker(status) {
  if (workerUrlSet) return workerUrl
  workerUrlSet = true
  try {
    workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
    maplibregl.setWorkerUrl(workerUrl)
    if (status) status.worker = 'blob'
  } catch (e) {
    if (status) status.worker = 'default(' + ((e && e.message) || 'blob 失败') + ')'
  }
  return workerUrl
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

// ===== 内存 PMTiles 源 =====
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

export function trackGeoJSON(points) {
  const coords = collectCoords(points)
  const features = []
  if (coords.length > 1) {
    features.push({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: coords },
    })
  }
  if (coords.length >= 1) {
    features.push({
      type: 'Feature',
      properties: { kind: 'start' },
      geometry: { type: 'Point', coordinates: coords[0] },
    })
    features.push({
      type: 'Feature',
      properties: { kind: 'end' },
      geometry: { type: 'Point', coordinates: coords[coords.length - 1] },
    })
  }
  return { type: 'FeatureCollection', features }
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
  const archives = (opts.archives || []).filter((a) => a && a.key && a.bytes)
  if (!archives.length) throw new Error('没有可用的瓦片档案')

  ensureWorker(status)
  const protocol = ensureProtocol()

  let bounds = null
  let fitted = false
  let lastPoints = opts.points || []
  let outOfBoundsFired = false
  let destroyed = false
  const tileKeys = {}
  const instances = []
  const sourceIds = {}
  let baseLayers = []

  for (let ai = 0; ai < archives.length; ai++) {
    const a = archives[ai]
    const inst = new PMTiles(memorySource(a.bytes, a.key))
    protocol.add(inst)
    instances.push(inst)
    sourceIds[a.key] = 1
    // 每个档案要有自己的图层组：basemaps 的 layers() 生成的是绑定到指定 source 名的图层，
    // 多个档案就得生成多份，并把 id 加前缀避免重复 id 报错。
    const ls = basemapLayers(a.key, namedFlavor('dark'), { lang: 'zh' }).filter(
      (l) => l.type !== 'symbol' // 离线包没有字体包
    )
    for (let li = 0; li < ls.length; li++) {
      baseLayers.push(Object.assign({}, ls[li], { id: a.key + ':' + ls[li].id }))
    }
  }

  const sources = { track: { type: 'geojson', data: trackGeoJSON(lastPoints) } }
  for (let ai = 0; ai < archives.length; ai++) {
    sources[archives[ai].key] = {
      type: 'vector',
      url: 'pmtiles://' + archives[ai].key,
      attribution: ATTRIBUTION,
    }
  }

  const style = {
    version: 8,
    sources: sources,
    layers: baseLayers.concat([
      {
        id: 'track-line',
        type: 'line',
        source: 'track',
        filter: ['==', ['get', 'kind'], 'line'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': TRACK_COLOR, 'line-width': TRACK_WIDTH },
      },
      {
        id: 'track-start',
        type: 'circle',
        source: 'track',
        filter: ['==', ['get', 'kind'], 'start'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#15151a',
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
          'circle-color': '#7cf29d',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      },
    ]),
  }

  // 容器校验：MapLibre 只接受选择器字符串或真实元素，否则抛
  // "Invalid type: 'container' must be a String or HTMLElement."。这里提前拦，
  // 把「实际拿到的是什么」写进错误消息，免得又在真机上猜。
  if (!containerOk(container)) {
    throw new Error('container 非法：' + describeValue(container) + '（需要 DOM 元素或选择器字符串）')
  }

  const map = new maplibregl.Map({
    container: container,
    style: style,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
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
      if (!valid.length) return
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
      if (!collectCoords(lastPoints).length) {
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

  const api = {
    map: map,
    status: status,
    getBounds() {
      return bounds
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
    },
  }

  if (lastPoints && lastPoints.length) api.setPoints(lastPoints)
  return api
}
