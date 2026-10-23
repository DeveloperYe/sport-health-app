// 轨迹几何：纯函数，不依赖 uni / plus，可直接用 node 单测
//
// 坐标系：全项目统一 wgs84（GPS 原始坐标）。
// 为什么是 wgs84：App 端 uni.startLocationUpdate({ type: 'wgs84' }) 会被运行时透传为
// plus.geolocation.watchPosition({ coordsType: 'wgs84' })，走 Android 系统定位，
// 不需要任何地图厂商 key。注意不传 type 时运行时会默认成 gcj02，那条路需要三方
// 定位 SDK + key，所以调用处必须显式写 wgs84。
//
// 投影：等距圆柱（equirectangular），经度按轨迹中心纬度做 cos 修正。
// 城市尺度（几公里~几十公里）内误差远小于 GPS 自身精度，且零依赖。

const EARTH_R = 6371008.8 // 地球平均半径（米）
const MIN_SPAN = 20 // 投影包围盒最小边长（米）：单点/原地轨迹不至于把比例尺拉到无穷

const rad = (deg) => (deg * Math.PI) / 180

// 两点球面距离（米），Haversine
export function haversine(a, b) {
  const lat1 = rad(a.lat)
  const lat2 = rad(b.lat)
  const dLat = lat2 - lat1
  const dLng = rad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

// 轨迹累计距离（米）
export function trackDistance(points) {
  let d = 0
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i])
  return d
}

// 经纬包围盒；空轨迹返回 null
export function bounds(points) {
  if (!points || !points.length) return null
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lng < minLng) minLng = p.lng
    if (p.lng > maxLng) maxLng = p.lng
  }
  return { minLat, maxLat, minLng, maxLng }
}

// 经纬度 -> 以 center 为原点的本地平面米坐标（x 向东，y 向北）
export function toLocalMeters(points, center) {
  const kx = Math.cos(rad(center.lat))
  return points.map((p) => ({
    x: (p.lng - center.lng) * kx * (Math.PI / 180) * EARTH_R,
    y: (p.lat - center.lat) * (Math.PI / 180) * EARTH_R,
  }))
}

// 把轨迹投到 width×height 的画布像素坐标（画布 y 轴向下，北在上）
// 返回 { points: [{x, y}], pxPerMeter, spanMeters, center }
export function project(points, width, height, padding = 18) {
  const b = bounds(points)
  if (!b) return { points: [], pxPerMeter: 0, spanMeters: { x: 0, y: 0 }, center: null }

  const center = { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 }
  const local = toLocalMeters(points, center)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of local) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  const spanX = Math.max(maxX - minX, MIN_SPAN)
  const spanY = Math.max(maxY - minY, MIN_SPAN)
  const availW = Math.max(width - padding * 2, 1)
  const availH = Math.max(height - padding * 2, 1)
  const pxPerMeter = Math.min(availW / spanX, availH / spanY)

  const drawW = spanX * pxPerMeter
  const drawH = spanY * pxPerMeter
  const offX = (width - drawW) / 2
  const offY = (height - drawH) / 2

  return {
    points: local.map((p) => ({
      x: offX + (p.x - minX) * pxPerMeter,
      y: offY + (maxY - p.y) * pxPerMeter,
    })),
    pxPerMeter,
    spanMeters: { x: spanX, y: spanY },
    center,
  }
}

// 抽稀：Douglas-Peucker，tolerance 单位米。用于存储/上传时压缩轨迹点数。
export function simplify(points, tolerance = 5) {
  if (!points || points.length <= 2) return (points || []).slice()
  const b = bounds(points)
  const center = { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 }
  const xy = toLocalMeters(points, center)

  const keep = new Array(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    if (last - first < 2) continue
    const ax = xy[first].x
    const ay = xy[first].y
    const dx = xy[last].x - ax
    const dy = xy[last].y - ay
    const segLen = Math.hypot(dx, dy)
    let maxD = -1
    let idx = -1
    for (let i = first + 1; i < last; i++) {
      const px = xy[i].x - ax
      const py = xy[i].y - ay
      const d = segLen === 0 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / segLen
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = true
      stack.push([first, idx], [idx, last])
    }
  }
  return points.filter((_, i) => keep[i])
}

// 「456 米」/「1.23 公里」
export function formatDistance(meters) {
  const m = Number(meters) || 0
  if (m < 1000) return `${Math.round(m)} 米`
  return `${(m / 1000).toFixed(2)} 公里`
}

// 每公里配速「5'30"」；距离过短返回 '--'（避免用 3 个点算出离谱配速）
export function formatPace(seconds, meters) {
  const m = Number(meters) || 0
  if (m < 20) return '--'
  const secPerKm = (Number(seconds) || 0) / (m / 1000)
  if (!Number.isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return '--'
  return `${Math.floor(secPerKm / 60)}'${String(Math.round(secPerKm % 60)).padStart(2, '0')}"`
}

// 「12:34」/「1:02:03」
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}
