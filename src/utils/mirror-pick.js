/**
 * 加速线路的纯决策逻辑（不碰网络、不碰 DOM，方便单测）。
 *
 * 两条规则来自需求：
 *  1. 下载前测速，选最快的线路；
 *  2. 下载中如果速度不够，自动换下一条更快的线路重下。
 */

/** 低于这个速度算"速度不够"（字节/秒），默认 120 KB/s */
export const SLOW_BPS = 120 * 1024
/** 观察窗口：跑够这么久才允许判定掉速，避免刚起步误判 */
export const SLOW_WINDOW_MS = 6000

/**
 * 把测速结果排序：只有成功的（bps > 0）参与排序，按速度降序。
 * @param {Array<{prefix:string, bps:number, ok?:boolean}>} probes
 */
export function rankMirrors(probes) {
  const ok = (probes || []).filter((p) => p && p.ok !== false && Number(p.bps) > 0)
  return ok.slice().sort((a, b) => Number(b.bps) - Number(a.bps))
}

/** 最快的线路；全失败返回 null */
export function pickBest(probes) {
  const r = rankMirrors(probes)
  return r.length ? r[0] : null
}

/**
 * 要不要因为"太慢"而换线。
 * @param {object} s
 * @param {number} s.elapsedMs       本次下载已用时
 * @param {number} s.bps             最近一次测得的速度（字节/秒），未知时传 0
 * @param {number} s.loadedBytes     已下字节
 * @param {number} s.totalBytes      总字节（未知传 0）
 * @param {boolean} s.hasNextMirror  后面还有线路可换
 * @param {number} [s.slowBps]       低速阈值
 * @param {number} [s.windowMs]      观察窗口
 */
export function shouldSwitchMirror(s) {
  const o = s || {}
  if (!o.hasNextMirror) return false
  if (Number(o.elapsedMs) < (o.windowMs || SLOW_WINDOW_MS)) return false
  const bps = Number(o.bps) || 0
  if (bps <= 0) return false // 还没测出速度，别瞎换
  if (bps >= (o.slowBps || SLOW_BPS)) return false
  const total = Number(o.totalBytes) || 0
  const loaded = Number(o.loadedBytes) || 0
  // 已经下了九成以上就别换了，重下更亏
  if (total > 0 && loaded >= total * 0.9) return false
  return true
}

/** 从测速结果生成下载尝试顺序：快的在前，失败/未测的按原顺序垫后 */
export function buildAttemptOrder(probes, allPrefixes) {
  const ranked = rankMirrors(probes).map((p) => p.prefix)
  const order = ranked.slice()
  ;(allPrefixes || []).forEach((p) => {
    if (order.indexOf(p) < 0) order.push(p)
  })
  return order
}
