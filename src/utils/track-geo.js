/**
 * 轨迹 → GeoJSON（按「段」输出，跨中断不连线）。
 *
 * 为什么不是一条 LineString：
 *   切页面/切后台/进隧道之后 GPS 会断一段时间，回来看第一个点如果直接和前一点连起来，
 *   画面上就是一条根本没走过的直线。这里按点的 `seg` 字段分组：
 *   同一段内连成 LineString，多段用 MultiLineString 表示，MapLibre 的 line 图层天然支持。
 *
 * 纯函数：不依赖 maplibre，可直接单测。
 */

/** 取点的经纬度（兼容 {lat,lng} 与 {lat,lon}） */
function lngLat(p) {
  const lng = Number(p.lng !== undefined ? p.lng : p.lon)
  const lat = Number(p.lat)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return [lng, lat]
}

/** 按 seg 字段把点分成若干段（缺省 seg 视为同一段 0） */
export function splitSegments(points) {
  const list = Array.isArray(points) ? points : []
  const segments = []
  let cur = null
  let curKey = null
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    const c = lngLat(p || {})
    if (!c) continue
    const key = p && p.seg !== undefined ? p.seg : 0
    if (!cur || key !== curKey) {
      cur = []
      segments.push(cur)
      curKey = key
    }
    cur.push(c)
  }
  return segments
}

/** 所有点的经纬度（扁平，供 bbox / 越界判断用） */
export function collectCoords(points) {
  const list = Array.isArray(points) ? points : []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const c = lngLat(list[i] || {})
    if (c) out.push(c)
  }
  return out
}

/**
 * 轨迹 GeoJSON。
 * 线段：按段输出 LineString / MultiLineString（只有 1 个点的段不画线）
 * 端点：起点用全部点里的第一个，终点用最后一个（便于地图上标"起/终"）
 */
export function trackGeoJSON(points) {
  const coords = collectCoords(points)
  const all = splitSegments(points) // 含只有 1 个点的段（用来接断档虚线）
  const segments = all.filter((s) => s.length >= 2)
  const features = []

  if (segments.length === 1) {
    features.push({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: segments[0] },
    })
  } else if (segments.length > 1) {
    features.push({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'MultiLineString', coordinates: segments },
    })
  }

  // 断档连接线：上一段末点 → 下一段首点。
  // 单独标 kind:'gap'，由地图用**虚线**渲染 —— 用户一眼能看出"这段是信号中断，不是走过的路"。
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1]
    const cur = all[i]
    if (!prev.length || !cur.length) continue
    features.push({
      type: 'Feature',
      properties: { kind: 'gap' },
      geometry: {
        type: 'LineString',
        coordinates: [prev[prev.length - 1], cur[0]],
      },
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

/** 段数（UI 上可以提示"轨迹有 N 段，蓝色缺口代表 GPS 中断"） */
export function segmentCount(points) {
  return splitSegments(points).filter((s) => s.length >= 2).length
}
