/**
 * 当日汇总：把三处数据拼成"热量缺口"一条链
 *
 *   摄入   ← 饮食记录（diet-store）
 *   每日消耗 ← 基础代谢 BMR × 活动系数（body-calc）
 *   运动消耗 ← 跑步/走路记录（storage.records）+ 其他运动（activity-store）
 *   缺口   = 摄入 − (每日消耗 + 运动消耗)
 *
 * 为什么运动消耗要分两处加：跑步页按轨迹时长算，其他运动按手填时长算，
 * 两者是不同的记录表，但必须加在一起，否则缺口会偏小。
 */
import { getRecords } from './storage.js'
import { getDayActivities, summarizeActivities } from './activity-store.js'
import { getDayEntries, getWater, summarize } from './diet-store.js'
import { getBody, getGoals } from './body-store.js'
import { calcBMR, calcTDEE, calcGap } from './body-calc.js'

/** 把 'YYYY-MM-DD' 缓存在记录里便于按天过滤（兼容老记录只有 createdAt） */
export function dateOfRecord(rec) {
  if (rec && rec.date) return rec.date
  const ts = Number(rec && rec.createdAt) || 0
  if (!ts) return ''
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 某天的运动消耗（跑步/走路 + 其他运动） */
export function dayExercise(date) {
  const runs = getRecords().filter((r) => dateOfRecord(r) === date)
  const runCalorie = runs.reduce((a, r) => a + (Number(r.calories) || 0), 0)
  const runMinutes = runs.reduce((a, r) => a + (Number(r.duration) || 0), 0)
  const otherList = getDayActivities(date)
  const other = summarizeActivities(otherList)
  return {
    runCalorie,
    runMinutes,
    runCount: runs.length,
    otherCalorie: other.calorie,
    otherMinutes: other.minutes,
    otherCount: other.count,
    total: runCalorie + other.calorie,
    minutes: runMinutes + other.minutes,
  }
}

/**
 * 某天的完整热量账
 * @returns {{ intake, carb, protein, fat, count, water,
 *             bmr, bmrFormula, activity, tdeeBase, exercise, tdee, gap, calorieGoal }}
 */
export function dayCalories(date) {
  const entries = getDayEntries(date)
  const intake = summarize(entries)
  const body = getBody()
  const goals = getGoals()
  const bmrInfo = calcBMR(body)
  const exercise = dayExercise(date)
  const tdeeBase = calcTDEE(bmrInfo.value, body.activity, 0) // 只算基础+活动系数
  const tdee = tdeeBase + exercise.total
  const gap = calcGap(intake.calorie, tdee)
  return {
    intake: intake.calorie,
    carb: intake.carb,
    protein: intake.protein,
    fat: intake.fat,
    count: intake.count,
    water: getWater(date),
    bmr: bmrInfo.value,
    bmrFormula: bmrInfo.formula,
    activity: body.activity,
    tdeeBase,
    exercise,
    tdee,
    gap,
    calorieGoal: Number(goals.calorie) || 0,
    waterGoal: Number(goals.water) || 8,
    proteinGoal: Number(goals.protein) || 0,
  }
}

/** 某天是否有任何记录（统计页判断"有记录天数"用） */
export function hasAnyRecord(date) {
  return getDayEntries(date).length > 0 || getWater(date) > 0 || dayExercise(date).total > 0
}
