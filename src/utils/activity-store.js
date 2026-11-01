/**
 * 「其他运动」记录存储层（按 MET × 体重 × 时长 算消耗）
 *
 * 与跑步/走路的区别：那两个有 GPS 轨迹，消耗按轨迹时长×MET 实时算；
 * 这里是手动补录的运动（游泳、篮球、力量训练…），只填时长。
 * 两条路最终都归到同一个"当日运动消耗"，保证热量缺口口径统一。
 */
const KEY = 'fh_activity_days'
const MAX_DAYS = 60

function readAll() {
  const o = uni.getStorageSync(KEY)
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
}

function writeAll(obj) {
  const keys = Object.keys(obj).sort()
  if (keys.length > MAX_DAYS) {
    for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete obj[k]
  }
  uni.setStorageSync(KEY, obj)
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getDayActivities(date) {
  const list = readAll()[date]
  return Array.isArray(list) ? list : []
}

/**
 * 新增一条其他运动
 * calorie 由调用方用 calcExerciseCalorie 算好传进来，同时记下当时用的体重，
 * 方便以后体重变了也能解释"这条为什么是这个数"。
 */
export function addActivity(date, item) {
  const all = readAll()
  const list = Array.isArray(all[date]) ? all[date].slice() : []
  // 秒是"真值"，分钟只是给界面看的换算值。
  // 计时会话存 seconds（可能只有几秒）；手动补录只给 minutes，则反推 seconds。
  const minutesRaw = Number(item.minutes) || 0
  const seconds =
    Number(item.seconds) > 0 ? Math.round(Number(item.seconds)) : Math.round(minutesRaw * 60)
  const entry = {
    id: uid(),
    name: String(item.name || '').trim() || '运动',
    met: Math.round((Number(item.met) || 0) * 10) / 10,
    seconds,
    minutes: Math.round((seconds / 60) * 10) / 10,
    calorie: Math.round(Number(item.calorie) || 0),
    weightUsed: Number(item.weightUsed) || 0,
    at: Date.now(),
  }
  list.push(entry)
  all[date] = list
  writeAll(all)
  return entry
}

export function updateActivity(date, id, patch) {
  const all = readAll()
  const list = Array.isArray(all[date]) ? all[date] : []
  const idx = list.findIndex((x) => x.id === id)
  if (idx < 0) return null
  list[idx] = Object.assign({}, list[idx], patch || {})
  all[date] = list
  writeAll(all)
  return list[idx]
}

export function removeActivity(date, id) {
  const all = readAll()
  const list = (Array.isArray(all[date]) ? all[date] : []).filter((x) => x.id !== id)
  all[date] = list
  writeAll(all)
  return list
}

export function summarizeActivities(list) {
  const sum = { calorie: 0, minutes: 0, seconds: 0, count: 0 }
  for (const e of list || []) {
    sum.calorie += Number(e.calorie) || 0
    sum.seconds += Number(e.seconds) || Math.round((Number(e.minutes) || 0) * 60)
    sum.count += 1
  }
  sum.minutes = Math.round((sum.seconds / 60) * 10) / 10
  return sum
}

/** 时长展示：不足 1 分钟显示秒，否则显示分钟（1 位小数，整数不带 .0） */
export function formatActivityDuration(entry) {
  const e = entry || {}
  const sec = Number(e.seconds) || Math.round((Number(e.minutes) || 0) * 60)
  if (sec < 60) return `${sec} 秒`
  const min = sec / 60
  const text = Number.isInteger(min) ? String(min) : min.toFixed(1)
  return `${text} 分钟`
}

/** 近 n 天每天的运动消耗（统计/趋势用） */
export function recentActivityTotals(dates) {
  return (dates || []).map((d) => {
    const list = getDayActivities(d)
    return Object.assign({ date: d }, summarizeActivities(list))
  })
}

/**
 * 全部「其他运动」记录（扁平成一条条，带日期），按时间倒序。
 * 运动历史页要把跑步/走路和这些混在一起看，所以需要一个跨天的视图。
 */
export function getAllActivities() {
  const all = readAll()
  const out = []
  for (const date of Object.keys(all)) {
    const list = all[date]
    if (!Array.isArray(list)) continue
    for (const e of list) out.push(Object.assign({}, e, { date, kind: 'activity' }))
  }
  return out.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
}
