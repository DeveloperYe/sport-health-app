/**
 * GPS 采样过滤 + 轨迹分段判定（纯函数，便于单测）。
 *
 * 为什么要单独抽出来：
 *   原来过滤逻辑写在 track.js 的 accept() 闭包里，而它有个后门 ——
 *   `if (gap < FORCE_KEEP_GAP)` 才做跳点检查，但距离**无条件**累加。
 *   于是"切页面 / 切后台一分钟再回来"时，第一个点被无条件接受：
 *     · 画面上与前一点连成一条大直线（根本没走过的路）
 *     · track.distance 凭空多出几百米
 *
 * 现在的规则：
 *   1. 精度差（accuracy > MAX_ACCURACY）→ 丢；
 *   2. 静止抖动（位移 < MIN_MOVE 且间隔不长）→ 丢；
 *   3. 跳点（隐含速度 > MAX_SPEED）→ 丢（对任意间隔都判，间隔大时用真实间隔算速度，
 *      所以正常走路不会被误杀）；
 *   4. 真中断（间隔 ≥ BREAK_GAP）→ 接受，但**开新段**、且跨段距离不计入总距离。
 *      页面上因此不会连出直线，数字也不会虚增。
 */

export const MAX_ACCURACY = 50 // 精度（米）差于此的点直接丢弃：飘移主要来源
export const MIN_MOVE = 3 // 与上一点距离小于此（米）视为静止抖动
export const MAX_SPEED = 12 // 瞬时速度上限（m/s ≈ 43km/h）：跑步不可能，视为跳点
export const BREAK_GAP = 20000 // 与上一点间隔超过此（ms）视为中断 → 开新段
export const FORCE_KEEP_GAP = 30000 // 间隔超过此（ms）时不再把"位移很小"当成抖动丢弃

/** 两点球面距离（米） */
function haversineMeters(a, b) {
  const R = 6371008.8
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const la1 = toRad(a.lat)
  const la2 = toRad(b.lat)
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * 判定一个新点该不该进轨迹，以及是否要开新段。
 * @param {object|null} last 上一个已接受的点 {lat,lng,ts}
 * @param {object} pt 新点 {lat,lng,ts,accuracy?}
 * @param {object} [opt] 覆盖阈值（单测用）
 * @returns {{accept:boolean, breakSeg:boolean, distance:number, reason:string}}
 *   reason: first | accept | resume（跨段） | jitter | teleport
 */
export function classifyPoint(last, pt, opt) {
  const o = opt || {}
  const minMove = o.minMove === undefined ? MIN_MOVE : o.minMove
  const maxSpeed = o.maxSpeed === undefined ? MAX_SPEED : o.maxSpeed
  const breakGap = o.breakGap === undefined ? BREAK_GAP : o.breakGap
  const forceKeepGap = o.forceKeepGap === undefined ? FORCE_KEEP_GAP : o.forceKeepGap

  if (!last) return { accept: true, breakSeg: false, distance: 0, reason: 'first' }

  const gap = pt.ts - last.ts
  const d = haversineMeters(last, pt)

  // 静止抖动：只有"间隔不长"时才允许用位移小来丢弃；
  // 间隔很久之后的点不能因此丢掉（那会把整段路的起点吃掉）
  if (gap < forceKeepGap && d < minMove) {
    return { accept: false, breakSeg: false, distance: 0, reason: 'jitter' }
  }

  // 跳点：用真实间隔算隐含速度，任意间隔都判
  if (gap > 0 && d / (gap / 1000) > maxSpeed) {
    return { accept: false, breakSeg: false, distance: 0, reason: 'teleport' }
  }

  // 真中断（切页面/切后台/隧道丢星）：接受该点但开新段，且跨段距离不计入
  if (gap >= breakGap) {
    return { accept: true, breakSeg: true, distance: 0, reason: 'resume' }
  }

  return { accept: true, breakSeg: false, distance: d, reason: 'accept' }
}

/** 精度太差直接丢（独立出来便于单测） */
export function accuracyOk(accuracy, max) {
  const a = Number(accuracy)
  if (!Number.isFinite(a) || a <= 0) return true // 0/未给：交由后续速度判据兜
  return a <= (max === undefined ? MAX_ACCURACY : max)
}
