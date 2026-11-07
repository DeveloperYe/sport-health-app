/**
 * 科学饮水计划（纯函数，可单测）
 *
 * 依据与口径（都能对上公开指南，不是拍的数）：
 *  1. 中国居民膳食指南（2022）：成人每日**饮水量** 男 1700 ml / 女 1500 ml（不含食物中的水）。
 *  2. 按体重估算：30 ml/kg —— 国内外临床与运动营养通用口径。
 *     两者取较大者更稳妥：偏瘦的人按指南补足下限，偏胖的人按体重给量。
 *  3. 运动补水：每运动 1 分钟额外 10 ml（≈600 ml/小时，落在 ACSM 建议的 400–800 ml/h 区间内）。
 *  4. 上限 4000 ml/天：短时间大量饮水有低钠风险，超出不再累加。
 *  5. 单杯 150–500 ml：一次超过 500 ml 会加重胃负担，太小又变成频繁起夜。
 *  6. 间隔 30–240 分钟：低于 30 分钟没意义，超过 4 小时容易漏。
 */

export const GUIDE_ML = { male: 1700, female: 1500 }
export const ML_PER_KG = 30
export const ML_PER_EXERCISE_MIN = 10
export const MAX_DAILY_ML = 4000
export const MIN_CUP_ML = 150
export const MAX_CUP_ML = 500
export const MIN_INTERVAL_MIN = 30
export const MAX_INTERVAL_MIN = 240

/** 默认设置：250 ml 杯、08:00–22:00、目标自动计算 */
export const DEFAULT_PREFS = {
  cupMl: 250,
  startHour: 8,
  endHour: 22,
  goalMlOverride: 0, // >0 表示用户手动指定每日目标，忽略自动计算
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 每日建议饮水量（ml）
 * @param {{weightKg?:number, sex?:'male'|'female', exerciseMin?:number}} opt
 */
export function waterTargetMl(opt) {
  const o = opt || {}
  const weight = Number(o.weightKg) > 0 ? Number(o.weightKg) : 60
  const sex = o.sex === 'female' ? 'female' : 'male'
  const guide = GUIDE_ML[sex]
  const byWeight = Math.round(weight * ML_PER_KG)
  const base = Math.max(guide, byWeight)
  const bonus = Math.max(0, Math.round((Number(o.exerciseMin) || 0) * ML_PER_EXERCISE_MIN))
  const raw = base + bonus
  return {
    guide,
    byWeight,
    base, // 取较大者之后的基准
    basis: byWeight >= guide ? 'weight' : 'guide', // 展示"依据哪一条"
    bonus,
    total: Math.min(MAX_DAILY_ML, raw),
    capped: raw > MAX_DAILY_ML,
  }
}

/**
 * 生成喝水计划：每日目标、杯数、建议间隔
 * @param {object} opt { cupMl, startHour, endHour, goalMlOverride, goalMl, weightKg, sex, exerciseMin }
 */
export function waterPlan(opt) {
  const o = opt || {}
  const prefs = Object.assign({}, DEFAULT_PREFS, o)
  const cupMl = clamp(Math.round(Number(prefs.cupMl) || DEFAULT_PREFS.cupMl), MIN_CUP_ML, MAX_CUP_ML)
  const startHour = clamp(Math.round(Number(prefs.startHour)) || 0, 0, 23)
  const endHour = clamp(Math.round(Number(prefs.endHour)) || 22, startHour + 1, 24)
  const spanMin = Math.max(60, Math.round((endHour - startHour) * 60))

  const auto = waterTargetMl({ weightKg: prefs.weightKg, sex: prefs.sex, exerciseMin: prefs.exerciseMin })
  const override = Math.round(Number(prefs.goalMlOverride) || 0)
  const goalMl = override > 0 ? clamp(override, 500, MAX_DAILY_ML) : auto.total

  const cups = Math.max(1, Math.ceil(goalMl / cupMl))
  // 首杯落在时段起点，最后一杯落在时段终点前；杯与杯之间均分
  const gapCount = Math.max(1, cups - 1)
  const intervalMin = clamp(Math.round(spanMin / gapCount), MIN_INTERVAL_MIN, MAX_INTERVAL_MIN)

  return {
    cupMl,
    startHour,
    endHour,
    spanMin,
    goalMl,
    cups,
    intervalMin,
    override,
    auto,
    basis: override > 0 ? 'manual' : auto.basis,
  }
}

/** 距下一杯还要等多久（毫秒）；0 表示现在就能喝 */
export function cooldownLeftMs(lastAt, intervalMin, nowTs) {
  const last = Number(lastAt) || 0
  if (last <= 0) return 0
  const iv = clamp(Number(intervalMin) || 0, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN)
  const left = last + iv * 60000 - (Number(nowTs) || Date.now())
  return left > 0 ? Math.round(left) : 0
}

/** 毫秒 → "42:15" / "1:02:30" */
export function formatLeft(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s)
}

/** 当前时刻是否在饮水时段内 */
export function inDrinkWindow(dateObj, startHour, endHour) {
  const d = dateObj instanceof Date ? dateObj : new Date()
  const h = d.getHours() + d.getMinutes() / 60
  const from = Number(startHour) || 0
  const to = Number(endHour) || 24
  return h >= from && h <= to
}

/** 下一杯的建议时刻（Date），用于界面提示 */
export function nextCupAt(lastAt, intervalMin) {
  const last = Number(lastAt) || 0
  const iv = clamp(Number(intervalMin) || 0, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN)
  const base = last > 0 ? last : Date.now()
  return new Date(base + iv * 60000)
}

/** "HH:mm" */
export function hhmm(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date()
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}
