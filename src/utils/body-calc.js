/**
 * 身体与热量计算（纯函数，不碰存储、不碰界面，可直接跑单测）
 *
 * 口径统一说明（重要）：
 *   日总消耗 = 基础代谢 BMR × 活动系数 + 当日运动额外消耗
 *   热量缺口 = 摄入 − 日总消耗（负数=缺口，在掉秤；正数=盈余）
 *
 * BMR 有两套公式，自动选择：
 *   1. 知道体脂率 → Katch-McArdle：BMR = 370 + 21.6 × 瘦体重（最准，按去脂体重算）
 *   2. 不知道体脂率 → Mifflin-St Jeor：10×体重 + 6.25×身高 − 5×年龄 + (男 +5 / 女 −161)
 * 很多用户不知道自己的体脂率，所以第二套是兜底——否则整个页面都算不出数来。
 */

/** 默认活动系数：几乎不动 */
export const DEFAULT_ACTIVITY = 1.2

/** 活动系数选项（界面直接渲染这个列表） */
export const ACTIVITY_OPTIONS = [
  { value: 1.2, label: '几乎不动（久坐）' },
  { value: 1.375, label: '轻度活动（每周运动 1–3 次）' },
  { value: 1.55, label: '中度活动（每周 3–5 次）' },
  { value: 1.725, label: '高强度（每周 6–7 次）' },
  { value: 1.9, label: '极高强度（体力工作 / 一天两练）' },
]

const isBlank = (v) => v === '' || v === null || v === undefined

/** 数字化：空值返回 NaN，方便调用方判断 */
function num(v) {
  if (isBlank(v)) return NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/**
 * Katch-McArdle：需要体重 + 体脂率
 * BMR = 370 + 21.6 × 体重 × (1 − 体脂率/100)
 */
export function calcBMRKatch(weightKg, bodyFatPct) {
  const w = num(weightKg)
  const bf = num(bodyFatPct)
  if (!(w > 0) || !(bf >= 0) || bf >= 100) return 0
  const lean = w * (1 - bf / 100)
  return Math.round(370 + 21.6 * lean)
}

/**
 * Mifflin-St Jeor：需要体重 + 身高 + 年龄 + 性别
 * 男：10w + 6.25h − 5a + 5 ；女：10w + 6.25h − 5a − 161
 */
export function calcBMRMifflin(weightKg, heightCm, age, sex) {
  const w = num(weightKg)
  const h = num(heightCm)
  const a = num(age)
  if (!(w > 0) || !(h > 0) || !(a > 0)) return 0
  const base = 10 * w + 6.25 * h - 5 * a
  return Math.round(sex === 'female' ? base - 161 : base + 5)
}

/**
 * 自动挑公式算 BMR。
 * @returns {{ value:number, formula:'katch'|'mifflin'|'none' }}
 */
export function calcBMR(body) {
  const b = body || {}
  const katch = calcBMRKatch(b.weight, b.bodyFat)
  if (katch > 0) return { value: katch, formula: 'katch' }
  const mifflin = calcBMRMifflin(b.weight, b.height, b.age, b.sex)
  if (mifflin > 0) return { value: mifflin, formula: 'mifflin' }
  return { value: 0, formula: 'none' }
}

/** 瘦体重（kg）；缺体脂率返回 0 */
export function calcLeanMass(weightKg, bodyFatPct) {
  const w = num(weightKg)
  const bf = num(bodyFatPct)
  if (!(w > 0) || !(bf >= 0) || bf >= 100) return 0
  return Math.round(w * (1 - bf / 100) * 10) / 10
}

/** BMI；缺数据返回 0 */
export function calcBMI(weightKg, heightCm) {
  const w = num(weightKg)
  const h = num(heightCm)
  if (!(w > 0) || !(h > 0)) return 0
  return Math.round((w / Math.pow(h / 100, 2)) * 10) / 10
}

/** BMI 分级文案 */
export function bmiLabel(bmi) {
  if (!(bmi > 0)) return ''
  if (bmi < 18.5) return '偏瘦'
  if (bmi < 24) return '正常'
  if (bmi < 28) return '偏胖'
  return '肥胖'
}

/**
 * 每日总消耗 TDEE = BMR × 活动系数 + 当日运动消耗
 * 两者分开算，避免同一件事算两遍（活动系数管日常，运动记录管额外训练）
 */
export function calcTDEE(bmr, activity, exerciseCalories = 0) {
  const b = num(bmr)
  const act = num(activity)
  const ex = num(exerciseCalories) || 0
  if (!(b > 0)) return 0
  const a = act > 0 ? act : DEFAULT_ACTIVITY
  return Math.round(b * a + ex)
}

/** 三大营养素换算热量：碳水 4、蛋白 4、脂肪 9（千卡/克） */
export function macroToCalorie(carb, protein, fat) {
  const c = num(carb) || 0
  const p = num(protein) || 0
  const f = num(fat) || 0
  return Math.round(c * 4 + p * 4 + f * 9)
}

/**
 * 一次运动消耗：千卡 = MET × 体重(kg) × 时长(小时)
 * 跑步/走路与其他运动都用这一条，保证"运动"页两处口径一致。
 */
export function calcExerciseCalorie(met, weightKg, minutes) {
  const m = num(met)
  const w = num(weightKg)
  const t = num(minutes)
  if (!(m > 0) || !(w > 0) || !(t > 0)) return 0
  return Math.round(m * w * (t / 60))
}

/** 热量缺口 = 摄入 − 总消耗（负数=缺口） */
export function calcGap(intake, expenditure) {
  const i = num(intake) || 0
  const e = num(expenditure) || 0
  return Math.round(i - e)
}

/**
 * 用步数估算消耗（跑步/走路兜底用，主口径仍优先按轨迹时长 × MET）
 * 一步约 0.7 米 → 按 5 km/h 折时长 → MET 3.0
 */
export function calcStepCalorie(steps, weightKg) {
  const s = num(steps)
  const w = num(weightKg)
  if (!(s > 0) || !(w > 0)) return 0
  const hours = (s * 0.7) / 1000 / 5
  return Math.round(3.0 * w * hours)
}

/** 步数折算走了多少分钟（同样按 5 km/h） */
export function calcStepMinutes(steps) {
  const s = num(steps)
  if (!(s > 0)) return 0
  return Math.round(((s * 0.7) / 1000 / 5) * 60)
}

/** 想抵消 kcal 热量需要走多少步（与上面完全对称） */
export function calcStepsForCalorie(kcal, weightKg) {
  const k = num(kcal)
  const w = num(weightKg)
  if (!(k > 0) || !(w > 0)) return 0
  const perStep = 3.0 * w * 0.00014
  return Math.round(k / perStep)
}

/** '2026-10-5' → 20261005，便于比大小 */
function dateNumberOf(text) {
  const p = String(text).split('-')
  return Number(p[0]) * 10000 + Number(p[1]) * 100 + Number(p[2])
}

/**
 * 体重趋势斜率（最小二乘拟合），单位 kg/天
 * 只取头尾两点误差大，拟合直线能把日常波动平均掉。
 */
export function calcWeightSlope(log) {
  if (!Array.isArray(log) || log.length < 2) return 0
  const baseX = dateNumberOf(log[0].d)
  const n = log.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const item of log) {
    const x = dateNumberOf(item.d) - baseX
    const y = Number(item.w)
    if (!Number.isFinite(y)) continue
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }
  const denom = n * sumXX - sumX * sumX
  if (!denom) return 0
  return Math.round(((n * sumXY - sumX * sumY) / denom) * 10000) / 10000
}

/**
 * 按当前速度多少天到目标体重
 * @returns 天数；0=已达标；-1=方向不对或速度为零（按当前趋势到不了）
 */
export function forecastDaysToGoal(lastWeight, slope, goalWeight) {
  const lw = num(lastWeight)
  const g = num(goalWeight)
  const s = num(slope)
  if (!(lw > 0) || !(g > 0) || !Number.isFinite(s)) return -1
  const diff = g - lw
  if (Math.abs(diff) < 0.05) return 0
  if (!s) return -1
  if ((diff > 0 && s > 0) || (diff < 0 && s < 0)) return Math.round(diff / s)
  return -1
}

/**
 * 一键推荐每日目标
 *   热量：维持消耗 TDEE 上打 −500（约每周 −0.45kg）；想减重时至少不低于 BMR×1.1
 *   饮水：体重 × 35 ml，折成 250ml 杯
 *   蛋白：体重 × 1.6 g（减脂期保肌肉的常见起点）
 */
export function recommendGoals({ tdee, bmr, weightKg, targetWeight }) {
  const w = num(weightKg)
  const t = num(tdee)
  const b = num(bmr)
  const tw = num(targetWeight)
  let calorie = 0
  if (t > 0) {
    const wantLose = tw > 0 ? tw < w : true
    calorie = wantLose ? t - 500 : t + 200
    const floor = b > 0 ? Math.round(b * 1.1) : 1200
    if (wantLose && calorie < floor) calorie = floor
  }
  return {
    calorie: Math.round(calorie),
    water: w > 0 ? Math.max(4, Math.round((w * 35) / 250)) : 8,
    protein: w > 0 ? Math.round(w * 1.6) : 0,
  }
}
