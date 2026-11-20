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

/** 物理上不可能的速度上限（超过就判为测量假象） */
export const SANE_BPS = 80 * 1024 * 1024

/**
 * 把测出来的速度钳进可信范围。
 * 背景：某条线路如果没 fire 进度事件就直接完成，耗时会被算成接近 0，
 * 速度就成了几百 MB/s，会让它排到第一 —— 必须兜住。
 */
export function saneBps(bps, got, ms, maxBps) {
  const cap = maxBps || SANE_BPS
  const v = Number(bps) || 0
  if (!(v > 0)) return 0
  if (v <= cap) return v
  const g = Number(got) || 0
  const m = Number(ms) || 0
  return g > 0 ? (g * 1000) / Math.max(50, m || 50) : cap
}

/** 取速度最快的前 n 名（用于第二轮复测） */
export function pickTopN(list, n) {
  const arr = (list || []).slice()
  arr.sort((a, b) => (Number(b && b.bps) || 0) - (Number(a && a.bps) || 0))
  return arr.slice(0, n || 2)
}

/** 测速取样窗口（毫秒）。注意与 SLOW_WINDOW_MS（掉速判定窗口 6 秒）是两个概念 */
export const SPEED_WINDOW_MS = 1500

/**
 * 增量窗口测速器：喂「累计已下载字节 + 当前时间」，吐出窗口速率。
 *
 * 为什么必须抽成共用的一份：
 *   App 分支（uni.downloadFile）一直是对的（`windowBytes += written - prev`），
 *   而 H5 分支（XHR）写成了 `windowBytes = e.loaded`——`loaded` 是**累计值**，
 *   于是第 n 个窗口算的是「从开始到现在一共下了多少 / 1.5 秒」，
 *   随下载时长线性虚高（下 30 秒后虚高约 20 倍），
 *   掉速换线（shouldSwitchMirror）永远看到"很快"，阈值形同虚设。
 *   两个分支各写一遍必然再分叉，所以统一走这里，并有单测钉住。
 *
 * @param {{windowMs?:number}} [opts]
 * @returns {{push:(loadedBytes:number, now:number)=>{bps:number, windowBps:number, overallBps:number, loaded:number}}}
 */
export function makeSpeedMeter(opts) {
  const o = opts || {}
  const wMs = Number(o.windowMs) > 0 ? Number(o.windowMs) : SPEED_WINDOW_MS
  let start = -1 // 整体速率起点（首个事件时间）
  let winStart = -1 // 当前窗口起点
  let prev = 0 // 上一次的累计字节
  let winBytes = 0 // 当前窗口内的增量
  let winBps = 0 // 上一个完整窗口的速率
  let totalBps = 0

  function push(loadedBytes, now) {
    const got = Math.max(0, Number(loadedBytes) || 0)
    const t = Number(now) || 0
    if (start < 0) {
      start = t
      winStart = t
      // 首个事件里已经带了多少字节不算进窗口：那时候还没流逝时间，
      // 把它记进去会让第一个窗口的速率偏高一个采样（实测 +10%）。
      prev = got
      winBytes = 0
    }
    // 累计值回退（换线重下、服务器改 Content-Length）：窗口重开，别算成负增量
    if (got < prev) {
      prev = 0
      winBytes = 0
      winStart = t
    }
    winBytes += got - prev
    prev = got
    const winElapsed = t - winStart
    if (winElapsed >= wMs) {
      winBps = (winBytes * 1000) / Math.max(1, winElapsed)
      winStart = t
      winBytes = 0
    }
    const totalElapsed = t - start
    totalBps = totalElapsed > 0 ? (got * 1000) / totalElapsed : 0
    // 首个完整窗口出来之前退回整体速率：否则一开始 bps=0，
    // shouldSwitchMirror 会一直判"速度未知，别瞎换"，换线要白等一个窗口。
    return { bps: winBps || totalBps, windowBps: winBps, overallBps: totalBps, loaded: got }
  }

  return { push }
}
