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

/**
 * 用户到底填过身体数据没有。
 *
 * 不能用 getBody() 判：它会带回 storage.js 的兜底默认值（60 kg / 170 cm / 25 岁），
 * 永远为真 —— 新人会看到一行"看似有数据"的假摘要。
 * 这里只认**真实写入过的存储键**，任一命中即算填过。
 *
 * 需要这个判断的地方：身体信息卡默认展开/收起、摘要行要不要显示、空态引导。
 */
export function hasBodyData() {
  const read = (k) => {
    try {
      return uni.getStorageSync(k)
    } catch (e) {
      return ''
    }
  }
  const num = (v) => {
    const n = Number(v)
    return isFinite(n) && n > 0
  }
  if (num(read('fh_weight')) || num(read('fh_height')) || num(read('fh_age'))) return true
  const body = read('fh_body')
  if (body && typeof body === 'object' && Object.keys(body).length) return true
  const log = read(KEYS.weightLog)
  if (Array.isArray(log) && log.length) return true
  return false
}

/**
 * **体重**是否真的填过（比 hasBodyData 精确：只关心体重这一个字段）。
 *
 * 用在"热量按 MET × 体重估算，当前用的是默认 60kg"这类提示上：
 * 用户只填了身高、没填体重时，提示依然成立，不能用 hasBodyData() 把它藏起来。
 *
 * 判定口径：fh_weight 有正数，或体重日志非空（老版本可能只写过 fh_weight，没有日志）；
 * 不看 getBody() —— 它会带回 60kg 的兜底默认值，永远为真。
 */
/**
 * 只返回**真实填过**的身体字段（缺失的给空串），不带 storage.js 的兜底默认值。
 *
 * 为什么需要它：getBody() 会给 60kg / 170cm / 25 岁 / 默认活动量的兜底值，
 * 用它拼摘要，新用户会看到一行"看似有数据"的假摘要（实测踩到）。
 * 摘要、空态、折叠判定这类"要不要显示"的场景都应该用它。
 */
export function getStoredBody() {
  const read = (k) => {
    try {
      return uni.getStorageSync(k)
    } catch (e) {
      return ''
    }
  }
  const pos = (v) => {
    const n = Number(v)
    return isFinite(n) && n > 0 ? n : ''
  }
  const extra = read(KEYS.body) || {}
  const age = pos(read('fh_age'))
  const height = pos(read('fh_height'))
  const weight = pos(read('fh_weight'))
  // 只有在真的填过至少一项身体数据时，才把"有默认值语义"的字段带出来
  const filled = !!(age || height || weight)
  return {
    age: age ? String(age) : '',
    height: height ? String(height) : '',
    weight: weight ? String(weight) : '',
    sex: extra && extra.sex === 'female' ? 'female' : filled ? 'male' : '',
    activity: filled && Number(extra.activity) > 0 ? Number(extra.activity) : 0,
    bodyFat: extra && extra.bodyFat !== undefined && extra.bodyFat !== null && extra.bodyFat !== '' ? String(extra.bodyFat) : '',
  }
}

export function hasWeight() {
  const num = (v) => {
    const n = Number(v)
    return isFinite(n) && n > 0
  }
  try {
    if (num(uni.getStorageSync('fh_weight'))) return true
  } catch (e) {
    /* ignore */
  }
  try {
    const log = uni.getStorageSync(KEYS.weightLog)
    if (Array.isArray(log) && log.some((x) => x && Number(x.w) > 0)) return true
  } catch (e) {
    /* ignore */
  }
  return false
}

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
