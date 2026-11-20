/**
 * 运动历史列表的展示层（纯函数，配 tests/history-view.test.mjs）
 *
 * 这个列表从「我的」页搬到运动页（2026-11-20）。原来那份实现有两个用户能直接看到的问题，
 * 所以不整体照抄，改成「纯函数算、模板只渲染」：
 *
 *   ① **假总数**：源实现写的是
 *        history = allExerciseHistory().slice(0, 12)
 *        模板 `共 {{ history.length }} 条`            ← 显示的是**截断后**的长度
 *      于是有 30 条记录却写「共 12 条」。这里 total 一律取全量长度，shown/remaining 单独给。
 *
 *   ② **日期重复**：源数据 `allExerciseHistory()` 的 title 自带日期
 *        `跑步 · 2026-11-20` / `游泳 · 2026-11-20`
 *      列表一旦自己再显示一列日期，同一行就出现两次日期。这里用 stripDateFromTitle 把
 *      标题里的日期摘掉，日期只由 historyDateLabel 统一出一处（今天 / 昨天 / 11月19日）。
 *
 *   ③ **别一次渲染几百条**：记录表最多 50 条、其他运动保留 60 天，全量可以上百条。
 *      默认只渲染 10 条，每次「展开更多」再放 20 条；条数上限与步长都是导出常量。
 */

/** 首屏渲染几条 */
export const HISTORY_INITIAL = 10
/** 每次「展开更多」再加几条 */
export const HISTORY_PAGE_STEP = 20

/** 标题里的日期尾巴：`跑步 · 2026-11-20` → `跑步`（全角/半角间隔号都认） */
export function stripDateFromTitle(title) {
  const s = String(title == null ? '' : title)
  return s.replace(/\s*[·・•]\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim()
}

const pad2 = (n) => String(n).padStart(2, '0')

function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''))
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/** 'YYYY-MM-DD' 的前一天；解析失败返回 ''（按「不是昨天」处理） */
export function prevDay(dateStr) {
  const p = parseDate(dateStr)
  if (!p) return ''
  const t = Date.UTC(p.y, p.m - 1, p.d) - 86400000
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/**
 * 日期给人看的写法：今天 / 昨天 / 11月19日 / 2025年11月19日
 * 解析不了就原样返回（宁可显示原始串，也不要显示空白）。
 */
export function historyDateLabel(date, todayStr) {
  const d = String(date || '')
  if (!d) return ''
  if (todayStr && d === String(todayStr)) return '今天'
  const prev = prevDay(todayStr)
  if (prev && d === prev) return '昨天'
  const p = parseDate(d)
  if (!p) return d
  const sameYear = todayStr ? Number(String(todayStr).slice(0, 4)) === p.y : true
  return sameYear ? `${p.m}月${p.d}日` : `${p.y}年${p.m}月${p.d}日`
}

/**
 * 把 allExerciseHistory() 的结果整理成可直接渲染的行。
 *
 * @param {Array} items allExerciseHistory() 的原始项
 *   { kind:'run'|'activity', id, date, title, duration(秒), calorie, sub, at }
 * @param {{todayStr?:string, limit?:number}} opts
 * @returns {{rows:Array, total:number, shown:number, remaining:number}}
 *   total 是全量条数（**不是截断后的长度**），remaining = total − shown
 */
export function buildHistoryRows(items, opts) {
  const o = opts || {}
  const todayStr = String(o.todayStr || '')
  const limit = Number.isFinite(Number(o.limit)) ? Math.max(0, Math.floor(Number(o.limit))) : HISTORY_INITIAL

  const seen = Object.create(null)
  const rows = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.id === undefined || it.id === null) continue
    const kind = it.kind === 'activity' ? 'activity' : 'run'
    const key = kind + ':' + it.id
    if (seen[key]) continue // 两张表拼一起，同一 id 只留一条
    seen[key] = true
    rows.push({
      key,
      kind,
      id: it.id,
      date: String(it.date || ''),
      dateLabel: historyDateLabel(it.date, todayStr),
      name: stripDateFromTitle(it.title) || (kind === 'activity' ? '运动' : '跑步'),
      sub: String(it.sub || ''),
      durationSeconds: Number(it.duration) || 0,
      calorie: Number(it.calorie) || 0,
      at: Number(it.at) || 0,
    })
  }

  // allExerciseHistory 已按时间倒序；这里再稳一次，避免上游改排序就翻车
  rows.sort((a, b) => b.at - a.at)

  const total = rows.length
  const shown = Math.min(limit, total)
  return { rows: rows.slice(0, shown), total, shown, remaining: total - shown }
}

/** 「展开更多」之后的新上限（不超过总数，且至少前进一页） */
export function moreHistoryLimit(current, total) {
  const cur = Number.isFinite(Number(current)) ? Math.max(0, Math.floor(Number(current))) : HISTORY_INITIAL
  const all = Number.isFinite(Number(total)) ? Math.max(0, Math.floor(Number(total))) : 0
  if (cur >= all) return all
  return Math.min(all, cur + HISTORY_PAGE_STEP)
}
