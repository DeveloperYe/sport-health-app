/**
 * 本场步数计算（纯函数，便于单测）。
 *
 * 背景：Android 有两路计步数据
 *   - TYPE_STEP_COUNTER：开机累计值，精度高，但**很多机型息屏后会冻在旧值**；
 *   - TYPE_STEP_DETECTOR：每落一步发一个事件，实时，但可能漏计。
 * health.js 原本把两路先合并成 max(计步器增量, 检测器累计) 再减会话基线，
 * 结果一旦「数值较大的那一路卡住」，另一路的增量就被 max 整块吞掉 ——
 * 真机现象是走了 71 步、界面上步数恒为 0（测试版 47 的实测数据）。
 *
 * 正确做法：两路各记各的会话基线，再对**增量**取 max。
 * counter / det 用 -1 表示"该路不可用"。
 */

/** 单路增量：不可用、或读数回退（重启/传感器归零）时返回 -1 */
export function branchDelta(cur, base) {
  if (!Number.isFinite(cur) || !Number.isFinite(base)) return -1
  if (cur < 0 || base < 0) return -1
  if (cur < base) return -1 // 读数回退 → 该路本次不可信，交给另一路
  return cur - base
}

/**
 * 本场步数 = max(计步器增量, 检测器增量)。
 * @param {{counter:number, det:number}} cur  当前两路读数
 * @param {{counter:number, det:number}} base 会话开始时的两路基线
 * @returns {number} 步数；两路都不可用时返回 -1（调用方应保留上一次读数，别归零）
 */
export function sessionSteps(cur, base) {
  const c = cur || {}
  const b = base || {}
  const dc = branchDelta(c.counter, b.counter)
  const dd = branchDelta(c.det, b.det)
  if (dc < 0 && dd < 0) return -1
  return Math.max(dc, dd)
}

/** 基线是否可用于计算（任一路有效即可） */
export function baseUsable(base) {
  const b = base || {}
  return (Number.isFinite(b.counter) && b.counter >= 0) || (Number.isFinite(b.det) && b.det >= 0)
}


/**
 * 今日步数解算（纯函数）—— 把原来 health.js 里两个边界 bug 修掉。
 *
 * 修掉的两个 bug：
 *   ① 跨天时手机重启过 → 旧实现直接 base=昨日末值（例如 8000），而重启后 counter 只有 120，
 *      (counter - base) 恒为负 → counterDelta 一直是 0，今日步数长时间显示 0，只剩 detector 兜底。
 *   ② 隔了好几天没开 App → 旧实现同样 base=昨日末值，把这几天的步数全算成"今天"，严重虚增。
 *
 * 现在的规则（跨天分支）：
 *   首装（没有历史记录）      → base = 0（开机累计全额算今天）
 *   传感器暂无读数            → base = 上次末值
 *   隔了 >1 天                → base = 当前读数（从此刻起算，绝不把几天算成今天）
 *   隔 1 天（含手机重启过）    → base = min(上次末值, 当前读数)
 *
 * @param {object|null} rec 上次落盘的记录 {date, base, detBase, lastRaw, offset}
 * @param {{counter:number, det:number}} cur 当前两路读数（counter=-1 表示未就绪）
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{rec:object, steps:number}} steps=-1 表示两路都不可用
 */
export function resolveTodaySteps(rec, cur, today) {
  const c = Number(cur && cur.counter)
  const d0 = Number(cur && cur.det)
  const counter = Number.isFinite(c) ? c : -1
  const det = Number.isFinite(d0) ? d0 : 0
  const prev = rec && typeof rec === 'object' ? rec : null
  const sameDay = !!(prev && prev.date === today)

  let base
  let detBase
  let lastRaw
  let offset

  if (!sameDay) {
    const prevLast =
      prev && typeof prev.lastRaw === 'number'
        ? prev.lastRaw
        : prev && typeof prev.base === 'number'
          ? prev.base
          : null
    const gap = prev && prev.date ? daysBetween(prev.date, today) : 999
    if (prevLast === null || prevLast < 0) base = 0
    else if (counter < 0) base = prevLast
    else if (gap > 1) base = counter
    else base = Math.min(prevLast, counter)
    detBase = det
    offset = 0
    lastRaw = counter >= 0 ? counter : prevLast === null ? -1 : prevLast
  } else {
    base = typeof prev.base === 'number' ? prev.base : 0
    detBase = typeof prev.detBase === 'number' ? prev.detBase : 0
    lastRaw = typeof prev.lastRaw === 'number' ? prev.lastRaw : base
    offset = typeof prev.offset === 'number' ? prev.offset : 0
    // 同一天内手机重启：counter 归零，把重启前的量补回来
    if (counter >= 0 && lastRaw >= 0 && counter < lastRaw) offset += lastRaw
    if (counter >= 0) lastRaw = counter
    // 检测器计数回退（进程/系统清零）→ 重设基线
    if (det < detBase) detBase = det
  }

  const nextRec = { date: today, base, detBase, lastRaw, offset }
  if (counter < 0 && det <= 0) return { rec: nextRec, steps: -1 }

  const cDelta = offset + (counter >= base ? counter - base : 0)
  const dDelta = det >= detBase ? det - detBase : 0
  return { rec: nextRec, steps: Math.max(cDelta, dDelta) }
}

/** 'YYYY-MM-DD' 相差天数；解析失败返回 1（按"隔一天"最保守） */
export function daysBetween(from, to) {
  const p = String(from || '').split('-')
  const q = String(to || '').split('-')
  if (p.length !== 3 || q.length !== 3) return 1
  const a = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
  const b = Date.UTC(Number(q[0]), Number(q[1]) - 1, Number(q[2]))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1
  const days = Math.round((b - a) / 86400000)
  return days < 0 ? 1 : days
}
