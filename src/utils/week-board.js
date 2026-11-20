/**
 * 近 7 天数据看板（三环口径：步数 / 热量消耗 / 饮水）。
 *
 * 形态：**一张图**，横向 7 天，每天一组 3 根细柱（步数 / 消耗 / 饮水）。
 * 单位不同（步、kcal、杯）不能直接比高度，所以统一换算成「占目标百分比」再画，
 * 这样 100% 那条虚线对三根柱子都成立 —— 这是三序列共用一张图唯一站得住的口径。
 *
 * 没记录的日子不能当 0：当 0 会画成一根不存在的矮柱，还会把日均拉低。
 * 所以每天带 hasAny，空日子不画柱、不计入日均。
 */

/** 超过目标只画到 100%，但保留真实数值，避免把 150% 画成比 100% 高一截导致满屏柱子顶天 */
const CAP = 100

/**
 * @param {Array<{date:string, steps?:number|null, calories?:number|null, water?:number|null, hasAny?:boolean}>} days
 *   按时间正序（最早在前），通常 7 项
 * @param {{steps:number, calorie:number, water:number}} goals
 */
export function buildWeekBoard(days = [], goals = {}) {
  const list = Array.isArray(days) ? days : []
  const g = goals && typeof goals === 'object' ? goals : {}

  const series = [
    { key: 'steps', label: '步数', unit: '步', goal: num(g.steps), pick: (d) => d && d.steps },
    { key: 'calorie', label: '消耗', unit: 'kcal', goal: num(g.calorie), pick: (d) => d && d.calories },
    { key: 'water', label: '饮水', unit: '杯', goal: num(g.water), pick: (d) => d && d.water },
  ]

  // 目标没设（0）时的兜底刻度：用该序列自身最大值，否则全部 0% 什么都画不出来
  const fallback = {}
  for (const s of series) {
    const vals = list.map((d) => (s.pick(d) === null || s.pick(d) === undefined ? 0 : Math.max(0, Number(s.pick(d)) || 0)))
    fallback[s.key] = Math.max(0, ...vals)
  }

  const groups = list.map((d) => {
    const any = d ? d.hasAny !== false : false
    const bars = series.map((s) => {
      const raw = s.pick(d)
      const empty = !d || d.hasAny === false || raw === null || raw === undefined
      const value = empty ? 0 : Math.max(0, Number(raw) || 0)
      const scale = s.goal > 0 ? s.goal : fallback[s.key] || 1
      const pct = empty ? 0 : Math.min(CAP, Math.round((value / scale) * 100))
      return { key: s.key, value, pct, empty, hit: s.goal > 0 && value >= s.goal }
    })
    return { date: d && d.date ? d.date : '', label: dayLabel(d && d.date), empty: !any, bars }
  })

  const stats = series.map((s) => {
    const recorded = list
      .filter((d) => d && d.hasAny !== false)
      .map((d) => s.pick(d))
      .filter((v) => v !== null && v !== undefined)
      .map((v) => Math.max(0, Number(v) || 0))
    const avg = recorded.length ? Math.round(recorded.reduce((a, b) => a + b, 0) / recorded.length) : null
    return { key: s.key, label: s.label, unit: s.unit, goal: s.goal, avg, avgText: avg === null ? '—' : `${avg} ${s.unit}` }
  })

  const recordedDays = list.filter((d) => d && d.hasAny !== false).length
  return {
    series: stats,
    groups,
    dayLabels: groups.map((x) => x.label),
    recordedDays,
    allEmpty: recordedDays === 0,
  }
}

function num(v) {
  const n = Number(v)
  return isFinite(n) && n > 0 ? n : 0
}

/** 横轴日期只写"日"，去掉前导 0；解析不了给 ? */
export function dayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!m) return '?'
  return String(Number(m[3]))
}
