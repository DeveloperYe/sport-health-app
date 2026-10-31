/**
 * 饮食记录存储层
 *
 * 结构：{ 'YYYY-MM-DD': [ { id, meal, name, amount, calorie, carb, protein, fat, source, at } ] }
 *   amount 是"吃了多少克"，calorie/carb/protein/fat 已经按 amount 折算好（不是每 100g 的值），
 *   这样界面汇总时直接相加即可，不用每次再乘一遍。
 */
const KEY_DIET = 'fh_diet_days'
const KEY_WATER = 'fh_water_days'
const MAX_DAYS = 60 // 只保留最近 60 天的饮食记录，避免本地存储膨胀

/** 四个餐次（顺序即界面顺序） */
export const MEALS = [
  { key: 'breakfast', label: '早餐', icon: '🌅' },
  { key: 'lunch', label: '午餐', icon: '☀️' },
  { key: 'dinner', label: '晚餐', icon: '🌙' },
  { key: 'snack', label: '加餐', icon: '🍪' },
]

export const MEAL_MAP = MEALS.reduce((m, x) => {
  m[x.key] = x
  return m
}, {})

function readAll(key) {
  const o = uni.getStorageSync(key)
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
}

function writeAll(key, obj) {
  // 超过上限时按日期键排序丢掉最老的
  const keys = Object.keys(obj).sort()
  if (keys.length > MAX_DAYS) {
    const drop = keys.slice(0, keys.length - MAX_DAYS)
    for (const k of drop) delete obj[k]
  }
  uni.setStorageSync(key, obj)
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 某天的全部饮食条目 */
export function getDayEntries(date) {
  const all = readAll(KEY_DIET)
  const list = all[date]
  return Array.isArray(list) ? list : []
}

/** 新增一条；entry 里的营养值应当是"这份实际量"的总值 */
export function addEntry(date, entry) {
  const all = readAll(KEY_DIET)
  const list = Array.isArray(all[date]) ? all[date].slice() : []
  const item = {
    id: uid(),
    meal: MEAL_MAP[entry.meal] ? entry.meal : 'snack',
    name: String(entry.name || '').trim() || '未命名',
    amount: Number(entry.amount) || 0,
    calorie: Math.round(Number(entry.calorie) || 0),
    carb: Math.round((Number(entry.carb) || 0) * 10) / 10,
    protein: Math.round((Number(entry.protein) || 0) * 10) / 10,
    fat: Math.round((Number(entry.fat) || 0) * 10) / 10,
    source: entry.source || 'food',
    at: Date.now(),
  }
  list.push(item)
  all[date] = list
  writeAll(KEY_DIET, all)
  return item
}

export function updateEntry(date, id, patch) {
  const all = readAll(KEY_DIET)
  const list = Array.isArray(all[date]) ? all[date] : []
  const idx = list.findIndex((x) => x.id === id)
  if (idx < 0) return null
  list[idx] = Object.assign({}, list[idx], patch || {})
  all[date] = list
  writeAll(KEY_DIET, all)
  return list[idx]
}

export function removeEntry(date, id) {
  const all = readAll(KEY_DIET)
  const list = (Array.isArray(all[date]) ? all[date] : []).filter((x) => x.id !== id)
  all[date] = list
  writeAll(KEY_DIET, all)
  return list
}

export function clearDay(date) {
  const all = readAll(KEY_DIET)
  delete all[date]
  writeAll(KEY_DIET, all)
}

/** 汇总一天的营养摄入 */
export function summarize(list) {
  const sum = { calorie: 0, carb: 0, protein: 0, fat: 0, count: 0 }
  for (const e of list || []) {
    sum.calorie += Number(e.calorie) || 0
    sum.carb += Number(e.carb) || 0
    sum.protein += Number(e.protein) || 0
    sum.fat += Number(e.fat) || 0
    sum.count += 1
  }
  sum.carb = Math.round(sum.carb * 10) / 10
  sum.protein = Math.round(sum.protein * 10) / 10
  sum.fat = Math.round(sum.fat * 10) / 10
  return sum
}

/** 按餐次分组汇总 */
export function summarizeByMeal(list) {
  const out = {}
  for (const m of MEALS) out[m.key] = []
  for (const e of list || []) (out[e.meal] || out.snack).push(e)
  return out
}

/** 复制某天到另一天（常用：复制昨天） */
export function copyDay(fromDate, toDate) {
  const src = getDayEntries(fromDate)
  if (!src.length) return 0
  const all = readAll(KEY_DIET)
  const dst = (Array.isArray(all[toDate]) ? all[toDate] : []).slice()
  for (const e of src) {
    dst.push(Object.assign({}, e, { id: uid(), at: Date.now() }))
  }
  all[toDate] = dst
  writeAll(KEY_DIET, all)
  return src.length
}

// ---------------------------------------------------------------------------
// 饮水
// ---------------------------------------------------------------------------

export function getWater(date) {
  const all = readAll(KEY_WATER)
  return Number(all[date]) || 0
}

export function setWater(date, cups) {
  const all = readAll(KEY_WATER)
  all[date] = Math.max(0, Math.min(20, Math.round(Number(cups) || 0)))
  writeAll(KEY_WATER, all)
  return all[date]
}

/** 近 n 天每天的摄入汇总（统计页用） */
export function recentDailyTotals(dates) {
  return (dates || []).map((d) => {
    const list = getDayEntries(d)
    return Object.assign({ date: d, water: getWater(d) }, summarize(list))
  })
}
