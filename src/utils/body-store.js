/**
 * 身体信息 / 每日目标 / 体重记录 的本地存储层
 *
 * 与既有 storage.js 的关系：
 *   体重、身高、年龄三个字段在 storage.js 里早就有（`fh_weight` 等），运动页算热量也在用。
 *   这里不另起一套，而是**读写同一批键**，新增的性别、体脂率、活动系数放在 `fh_body`。
 *   这样老代码（health.js 的 calcCaloriesBySteps）不用改就能拿到新体重。
 */
import { getWeight, saveWeight, getHeight, saveHeight, getAge, saveAge } from './storage.js'
import { DEFAULT_ACTIVITY } from './body-calc.js'

const KEYS = {
  body: 'fh_body', // { sex, bodyFat, activity }
  goals: 'fh_goals', // { calorie, water, protein, weight }
  weightLog: 'fh_weight_log', // [{ d: 'YYYY-MM-DD', w: 70.1 }]
}

export function today() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 昨天的日期字符串 */
export function dateOffset(days) {
  const d = new Date()
  d.setDate(d.getDate() + (days || 0))
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// ---------------------------------------------------------------------------
// 身体信息
// ---------------------------------------------------------------------------

/**
 * 读身体信息
 * @returns {{age:string, sex:'male'|'female', height:string, weight:string, bodyFat:string, activity:number}}
 * 注意全部用字符串返回：输入框里保留用户原始输入（空就是空），由计算函数判断是否可用。
 */
export function getBody() {
  const extra = uni.getStorageSync(KEYS.body) || {}
  return {
    age: String(getAge() || ''),
    sex: extra.sex === 'female' ? 'female' : 'male',
    height: String(getHeight() || ''),
    weight: String(getWeight() || ''),
    bodyFat: extra.bodyFat === undefined || extra.bodyFat === null ? '' : String(extra.bodyFat),
    activity: Number(extra.activity) > 0 ? Number(extra.activity) : DEFAULT_ACTIVITY,
  }
}

/**
 * 保存身体信息（只传要改的字段）
 * 体重/身高/年龄同步写回 storage.js 的老键，保证运动页热量估算用的是同一份数据。
 */
export function saveBody(patch) {
  const p = patch || {}
  if (p.weight !== undefined) saveWeight(p.weight === '' ? '' : Number(p.weight))
  if (p.height !== undefined) saveHeight(p.height === '' ? '' : Number(p.height))
  if (p.age !== undefined) saveAge(p.age === '' ? '' : Number(p.age))
  const extra = uni.getStorageSync(KEYS.body) || {}
  if (p.sex !== undefined) extra.sex = p.sex === 'female' ? 'female' : 'male'
  if (p.bodyFat !== undefined) extra.bodyFat = p.bodyFat === '' ? '' : Number(p.bodyFat)
  if (p.activity !== undefined) extra.activity = Number(p.activity) || DEFAULT_ACTIVITY
  uni.setStorageSync(KEYS.body, extra)
  // 体重改动时同步进体重日志（同一天只留最后一次）
  if (p.weight !== undefined && Number(p.weight) > 0) upsertWeight(today(), Number(p.weight))
  return getBody()
}

// ---------------------------------------------------------------------------
// 每日目标
// ---------------------------------------------------------------------------

const DEFAULT_GOALS = { calorie: 0, water: 8, protein: 0, weight: 0 }

export function getGoals() {
  return Object.assign({}, DEFAULT_GOALS, uni.getStorageSync(KEYS.goals) || {})
}

export function saveGoals(patch) {
  const next = Object.assign(getGoals(), patch || {})
  next.calorie = Number(next.calorie) || 0
  next.water = Number(next.water) || 0
  next.protein = Number(next.protein) || 0
  next.weight = Number(next.weight) || 0
  uni.setStorageSync(KEYS.goals, next)
  return next
}

// ---------------------------------------------------------------------------
// 体重记录（趋势用）
// ---------------------------------------------------------------------------

/** 全部体重记录，按日期升序 */
export function getWeightLog() {
  const list = uni.getStorageSync(KEYS.weightLog)
  if (!Array.isArray(list)) return []
  return list
    .filter((x) => x && x.d && Number(x.w) > 0)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
}

/** 写入/覆盖某天的体重 */
export function upsertWeight(date, kg) {
  const w = Number(kg)
  if (!(w > 0)) return getWeightLog()
  const list = getWeightLog().filter((x) => x.d !== date)
  list.push({ d: date, w: Math.round(w * 10) / 10 })
  list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  // 只留最近 180 天，避免本地存储无限膨胀
  const trimmed = list.slice(-180)
  uni.setStorageSync(KEYS.weightLog, trimmed)
  return trimmed
}

export function removeWeight(date) {
  const list = getWeightLog().filter((x) => x.d !== date)
  uni.setStorageSync(KEYS.weightLog, list)
  return list
}

/** 最近 n 天的体重点（没有记录的日子不补点） */
export function recentWeights(days = 30) {
  const from = dateOffset(-(days - 1))
  return getWeightLog().filter((x) => x.d >= from)
}
