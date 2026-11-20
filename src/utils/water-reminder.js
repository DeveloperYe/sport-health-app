/**
 * 喝水提醒：系统通知 + 点通知直接记一杯。
 *
 * 判断逻辑全部是纯函数（可在 node --test 覆盖），读写与通知在 impure 部分。
 *
 * 平台与限制（**界面上必须如实写，不能承诺做不到的事**）：
 *   App      —— `plus.push.createMessage()` 发**本地通知**（不经过任何服务器），
 *               点击通知 → 打开 App 并由本模块自动记一杯（等于「通知栏打卡」）。
 *   限制     —— App 进程被系统杀掉后不会再触发（真正的后台定时需要 AlarmManager + 原生
 *               通知按钮，属下一阶段）；所以文案写「App 在后台时提醒」，不写「关了也会提醒」。
 *   H5       —— 不发通知（浏览器权限与时机都不可控），只在页面内给下一步提示。
 */

import { getWater, setWater } from './diet-store.js'
import { getWaterPrefs, getLastCupAt } from './water-store.js'
import { waterPlan, inDrinkWindow, cooldownLeftMs } from './water-plan.js'

const KEY_CFG = 'fh_water_reminder'

/** 提醒配置：默认关闭（不打扰），用户自己开 */
export function getReminderCfg() {
  try {
    const o = uni.getStorageSync(KEY_CFG)
    if (o && typeof o === 'object') {
      return {
        enabled: !!o.enabled,
        silencedUntil: Number(o.silencedUntil) || 0, // 「今天不再提醒」到当天 23:59
      }
    }
  } catch (e) {
    /* ignore */
  }
  return { enabled: false, silencedUntil: 0 }
}

export function setReminderCfg(patch) {
  const next = { ...getReminderCfg(), ...(patch || {}) }
  try {
    uni.setStorageSync(KEY_CFG, next)
  } catch (e) {
    /* ignore */
  }
  return next
}

/**
 * 纯函数：现在该不该提醒。
 *
 * 抑制条件（任一成立就不提醒，且**各自有独立理由**，写在 reason 里便于调试）：
 *   - 开关关（enabled=false）
 *   - 今天被「不再提醒」静音（nowMs < silencedUntil）
 *   - 不在允许时段（startHour ≤ h < endHour）
 *   - 已达标（cups ≥ goalCups）
 *   - 距上一杯不足一个间隔（冷却中）
 *
 * @returns {{remind:boolean, reason:string, nextAtMs:number|null, leftMs:number}}
 */
export function shouldRemind(p) {
  const o = p || {}
  const nowMs = Number(o.nowMs) || Date.now()
  const intervalMin = Math.max(1, Number(o.intervalMin) || 120)
  const cups = Math.max(0, Number(o.cups) || 0)
  const goalCups = Math.max(0, Number(o.goalCups) || 0)
  const lastCupAt = Number(o.lastCupAt) || 0

  if (!o.enabled) return { remind: false, reason: 'disabled', nextAtMs: null, leftMs: 0 }
  if (Number(o.silencedUntil) > nowMs) {
    return { remind: false, reason: 'silenced', nextAtMs: Number(o.silencedUntil), leftMs: Number(o.silencedUntil) - nowMs }
  }
  const d = new Date(nowMs)
  if (!inDrinkWindow(d, Number(o.startHour), Number(o.endHour))) {
    return { remind: false, reason: 'out-of-window', nextAtMs: null, leftMs: 0 }
  }
  if (goalCups > 0 && cups >= goalCups) {
    return { remind: false, reason: 'goal-reached', nextAtMs: null, leftMs: 0 }
  }
  const leftMs = cooldownLeftMs(lastCupAt, intervalMin, nowMs)
  if (leftMs > 0) {
    return { remind: false, reason: 'cooldown', nextAtMs: nowMs + leftMs, leftMs }
  }
  return { remind: true, reason: 'due', nextAtMs: nowMs, leftMs: 0 }
}

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 组装一次判断所需的实时参数（读存储 + 计划） */
export function buildRemindInput(nowMs = Date.now()) {
  const cfg = getReminderCfg()
  const prefs = getWaterPrefs()
  const plan = waterPlan({
    cupMl: prefs.cupMl,
    startHour: prefs.startHour,
    endHour: prefs.endHour,
    goalMlOverride: prefs.goalMlOverride,
  })
  const last = readLastCupAt(nowMs)
  return {
    enabled: cfg.enabled,
    silencedUntil: cfg.silencedUntil,
    nowMs,
    intervalMin: plan.intervalMin,
    startHour: prefs.startHour,
    endHour: prefs.endHour,
    cups: getWater(todayStr(new Date(nowMs))),
    goalCups: plan.cups,
    lastCupAt: last,
  }
}

function readLastCupAt(nowMs) {
  try {
    const d = new Date(Number(nowMs) || Date.now())
    const p = (n) => String(n).padStart(2, '0')
    const key = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    return Number(getLastCupAt(key)) || 0
  } catch (e) {
    return 0
  }
}

/**
 * 发本地通知（App）或页面内提示（H5）。
 * 点击通知后由 installClickHandler 记一杯。
 */
export function notifyWater(plan = {}) {
  const title = '该喝水了'
  const body = plan.cupMl
    ? `已喝 ${plan.cups || 0}/${plan.goalCups || 0} 杯 · 点这里记一杯（${plan.cupMl} ml）`
    : `已喝 ${plan.cups || 0}/${plan.goalCups || 0} 杯 · 点这里记一杯`
  if (typeof plus !== 'undefined' && plus.push && plus.push.createMessage) {
    try {
      plus.push.createMessage(body, JSON.stringify({ fhWater: 1, date: todayStr() }), {
        title,
        cover: false,
        delay: 0,
      })
      return true
    } catch (e) {
      /* 落到下面的 toast */
    }
  }
  uni.showToast({ title: '该喝水了', icon: 'none' })
  return false
}

/** 点通知 → 记一杯（幂等：同一条通知只加一次由调用方保证） */
export function logCupFromNotification(payload) {
  const date = (payload && payload.date) || todayStr()
  const cur = getWater(date)
  setWater(date, cur + 1)
  uni.showToast({ title: '已记录 1 杯', icon: 'none' })
  return cur + 1
}

let timer = null
let clickBound = false

/** 装上通知点击监听（App 端只装一次） */
export function installClickHandler() {
  if (clickBound) return
  if (typeof plus === 'undefined' || !plus.push) return
  clickBound = true
  try {
    plus.push.addEventListener('click', (msg) => {
      try {
        const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload
        if (payload && payload.fhWater) logCupFromNotification(payload)
      } catch (e) {
        /* 不是我们的通知，忽略 */
      }
    })
  } catch (e) {
    clickBound = false
  }
}

/** 启动轮询（每分钟检查一次；只在 App 进程存活时有效） */
export function startWaterReminder(opt = {}) {
  stopWaterReminder()
  const everyMs = Number(opt.everyMs) > 0 ? Number(opt.everyMs) : 60000
  installClickHandler()
  timer = setInterval(() => {
    const input = buildRemindInput()
    const r = shouldRemind(input)
    if (!r.remind) return
    notifyWater({ cupMl: Number(getWaterPrefs().cupMl) || 250, cups: input.cups, goalCups: input.goalCups })
    // 记下"提醒过了"：把 lastAt 推到冷却点，避免同一分钟内连发
    bumpCooldown()
  }, everyMs)
  return true
}

export function stopWaterReminder() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function bumpCooldown() {
  // 只把"最近一杯时间"推到现在（用于冷却），**不加杯数** ——
  // water-store 的 drinkOneCup 会真的 +1 杯，那是用户动作，不能被提醒逻辑冒用。
  try {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const key = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    let all = {}
    try {
      const v = uni.getStorageSync('fh_water_last')
      all = v && typeof v === 'object' ? v : {}
    } catch (e) {
      all = {}
    }
    all[key] = Date.now()
    uni.setStorageSync('fh_water_last', all)
  } catch (e) {
    /* ignore */
  }
}

/** 供测试/调试：把内部计时器状态暴露出来 */
export function isReminderRunning() {
  return !!timer
}

