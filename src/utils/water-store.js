/**
 * 喝水打卡的存储层：杯子容量/时段设置 + 每杯打卡时间（冷却用）
 *
 * 为什么不把杯数也搬进来：
 *   杯数真值一直在 fh_water_days（首页圆环、饮食页、统计都读它），
 *   这里只追加两样东西，避免动老数据结构、避免迁移风险：
 *     fh_water_prefs  设置（容量 ml、时段、可选的目标覆盖）
 *     fh_water_last   每天"最近一杯"的时间戳（冷却计算用）
 */

import { getWater, setWater } from './diet-store.js'
import { DEFAULT_PREFS, waterPlan } from './water-plan.js'

const KEY_PREFS = 'fh_water_prefs'
const KEY_LAST = 'fh_water_last'

function readPrefs() {
  try {
    const v = uni.getStorageSync(KEY_PREFS)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

/** 读取设置（总是补全默认值） */
export function getWaterPrefs() {
  const p = readPrefs()
  return {
    cupMl: Number(p.cupMl) > 0 ? Number(p.cupMl) : DEFAULT_PREFS.cupMl,
    startHour: Number.isFinite(Number(p.startHour)) ? Number(p.startHour) : DEFAULT_PREFS.startHour,
    endHour: Number.isFinite(Number(p.endHour)) ? Number(p.endHour) : DEFAULT_PREFS.endHour,
    goalMlOverride: Number(p.goalMlOverride) > 0 ? Number(p.goalMlOverride) : 0,
  }
}

/** 保存设置（部分更新） */
export function saveWaterPrefs(patch) {
  const next = Object.assign(getWaterPrefs(), patch || {})
  next.cupMl = Math.round(Number(next.cupMl) || DEFAULT_PREFS.cupMl)
  next.startHour = Math.max(0, Math.min(23, Math.round(Number(next.startHour))))
  next.endHour = Math.max(next.startHour + 1, Math.min(24, Math.round(Number(next.endHour))))
  next.goalMlOverride = Math.max(0, Math.round(Number(next.goalMlOverride) || 0))
  try {
    uni.setStorageSync(KEY_PREFS, next)
  } catch (e) {
    /* ignore */
  }
  return next
}

function readLast() {
  try {
    const v = uni.getStorageSync(KEY_LAST)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

/** 某天最近一杯的时间戳（0 = 还没喝过） */
export function getLastCupAt(date) {
  const all = readLast()
  return Number(all[date]) || 0
}

function markCupAt(date, ts) {
  const all = readLast()
  all[date] = Number(ts) || Date.now()
  // 只留最近 30 天，别让存储无限增长
  const keys = Object.keys(all).sort()
  while (keys.length > 30) {
    const k = keys.shift()
    delete all[k]
  }
  try {
    uni.setStorageSync(KEY_LAST, all)
  } catch (e) {
    /* ignore */
  }
}

/**
 * 喝一杯：杯数 +1 并记录时间（冷却起点）
 * @returns {{cups:number, lastAt:number}}
 */
export function drinkOneCup(date, ts) {
  const now = Number(ts) || Date.now()
  const cups = setWater(date, getWater(date) + 1)
  markCupAt(date, now)
  return { cups, lastAt: now }
}

/** 手动纠错：直接设定杯数（不改变冷却起点） */
export function setCupsOf(date, n) {
  const cups = setWater(date, n)
  return { cups, lastAt: getLastCupAt(date) }
}

/**
 * 用设置 + 身体信息算出计划，并把"目标杯数"同步进 goals.water ——
 * 首页三环的饮水环、饮食页的杯数都以 goals.water 为准，这样只有一个真值。
 */
export function applyPlanToGoals(body, exerciseMin, saveGoalsFn) {
  const prefs = getWaterPrefs()
  const plan = waterPlan({
    cupMl: prefs.cupMl,
    startHour: prefs.startHour,
    endHour: prefs.endHour,
    goalMlOverride: prefs.goalMlOverride,
    weightKg: Number(body && body.weight) || 0,
    sex: (body && body.sex) || 'male',
    exerciseMin: Number(exerciseMin) || 0,
  })
  if (typeof saveGoalsFn === 'function') saveGoalsFn({ water: plan.cups })
  return plan
}
