/**
 * 运动页会话状态机（纯函数，不碰 uni / plus / DOM，可直接在 node --test 里跑）
 *
 * 这一组函数来自 2026-11-20 的只读盘点，修的是两个**真 bug**（不是风格问题）：
 *
 *  P0-1 结束没有重入锁
 *       finish() 在 `await getStepBranches()`（兜底路径最长 3 s，health.js:222-229）
 *       之后才 addRecord，而这期间 state 仍是 'running'，「结束」按钮还在（sport.vue:89/94）。
 *       双击 → 第二次 stopTrack() 返回 null、track=[] → 照样再 addRecord 一条，
 *       daily.duration 加两次、syncDaily 推两次。
 *
 *  P0-2 开始不在 await 之后复核状态
 *       start() 先把 state 置 'running'（sport.vue:649），之后有两处 await：
 *         · await getStepBranches()  —— 最长 3 s
 *         · await startTrack()       —— 首次运行会弹系统定位授权框，可达数秒
 *       在这个窗口里点「结束」→ finish 走「不足 1 分钟」分支 resetSession → state 归 idle，
 *       但 start() 的后续代码照常执行：GPS 在采集、计时器在自增、计步在轮询。
 *       此时 switchSportTab / goMaps 的守卫（判 state/otState）全部放行 ——
 *       正是「运动进行中禁止切页签」想禁的事。
 *
 * 三条纪律（对应下面的函数）：
 *   ① 能不能开始，只看 state ......................... guardStart
 *   ② 每个 await 之后复核「还是不是同一轮、还在不在跑」 . isCurrentSession + afterAwait
 *   ③ 结束必须**同步**上锁，锁在 resetSession 里复位 .... tapFinish + mergeSessionReset
 */

import { calcExerciseCalorie } from './body-calc.js'

/** 会话有效的最短时长（秒）：不足视为误触，整场丢弃（P2-8：原实现按分钟四舍五入，
 *  31 秒会被记成 1 分钟，与「不足 1 分钟丢弃」的注释不符） */
export const MIN_SESSION_SECONDS = 60

/**
 * 一场运动的热量（口径 C，2026-11-20 用户拍板）。
 *
 *   热量 = MET × 体重(kg) × 时长(小时)
 *
 * 公式不在这里重写一遍：直接走 body-calc.js 的 calcExerciseCalorie ——
 * 「其他运动」早就在用它，跑步/健走改用它之后全 App 只有一条热量公式。
 *
 * 为什么放弃按步数折算：跑步与健走给了两个 MET（8.0 / 4.3），按步数算两者
 * 完全一样，两个页签就只差一句文案；按 MET 算，同样 30 分钟跑步 ≈ 健走的 1.86 倍。
 * 步数不参与热量，仍按传感器会话累计照旧展示与记录（距离/配速仍取 GPS）。
 *
 * @param {{met:number, minutes:number, weightKg:number}} p
 *   met 必须由调用方从 MODES[mode].met 取 —— health.js 带 uni 条件编译
 *   （同一函数在 #ifdef 分支里有三份定义，不能被纯函数模块 import），
 *   所以 MET 值当参数传进来，公式只保留一份实现。
 * @returns {number} 千卡（整数）；任何一项非法（0 分钟 / MET 非正 / 体重未填）返回 0
 */
export function sessionCalorieByMet(p) {
  const { met, minutes, weightKg } = p || {}
  const m = Number(met)
  const t = Number(minutes)
  const w = Number(weightKg)
  if (!(m > 0) || !(t > 0) || !(w > 0)) return 0
  return calcExerciseCalorie(m, w, t)
}

/** 能不能开始一次新会话。只有 idle 能开：模板虽然只在 idle 渲染「开始运动」，
 *  但快速连点/程序化调用仍会进来，必须自己守一道。 */
export function guardStart(state) {
  return state === 'idle'
}

/**
 * 点「结束」的处置结论（纯决策，不含任何 IO）。
 * 调用方拿到 proceed=true 后必须**同步**把 finishing 置 true，再去做 await ——
 * 锁一旦延后到 await 之后，双击就又能穿过来了。
 * @param {{state?:string, finishing?:boolean}} session
 * @returns {{proceed:boolean, reason:'ok'|'busy'|'not-running'}}
 */
export function tapFinish(session) {
  const s = session || {}
  if (s.finishing) return { proceed: false, reason: 'busy' }
  if (s.state !== 'running' && s.state !== 'paused') return { proceed: false, reason: 'not-running' }
  return { proceed: true, reason: 'ok' }
}

/** await 之后还该不该继续：期间被暂停/结束过就一律中止，绝不在非 running 下建计时器 */
export function afterAwait(state, expected = 'running') {
  return state === expected
}

/**
 * 还是不是同一轮会话。start() 里取 token = ++this.sessionToken，
 * await 之后比对：期间被新一轮 start() 顶掉（或 finish() 主动作废）就放弃后续步骤，
 * 否则会出现两套 timer / 两套订阅（旧 offTrack 被覆盖后泄漏）。
 */
export function isCurrentSession(token, currentToken) {
  return token === currentToken && typeof token === 'number' && token > 0
}

/** 本场是否该整场丢弃（时间太短，不落库） */
export function shouldDiscardSession(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s)) return true
  return s < MIN_SESSION_SECONDS
}

/** 落库用的分钟数：秒是真值，分钟只是换算（最短 1） */
export function sessionMinutes(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return 0
  return Math.max(1, Math.round(s / 60))
}

/**
 * 结束/丢弃一次会话时该被清掉的字段（连同 state 一起回到同一个干净起点）。
 *
 * 原来 resetSession 只清 7 个字段，漏了 estimatedDistance / gpsError /
 * mapMode / mapFallbackText / bgGained / pointsAtHide，导致结束后界面上仍挂着
 * 「含估算 X 米」「定位失败：…」「已回退自绘轨迹图：轨迹超出离线底图范围」，
 * 只有下次 start() 才会复位。
 *
 * mapMode 特殊：只有「本轮底图彻底坏了」（mapBroken）才保留 fallback，
 * 否则结束即回到底图 —— 上一轮因越界降级的会话不该让用户下次还在自绘层。
 * @param {{mapBroken?:boolean, mapFallbackText?:string}} prev 当前实例状态
 */
export function mergeSessionReset(prev) {
  const s = prev || {}
  return {
    state: 'idle',
    finishing: false, // 重入锁必须在这里复位，否则下次点开始/结束全被拦住
    seconds: 0,
    liveSteps: 0,
    stepBase: { counter: -1, det: -1 },
    trackPoints: [],
    gpsDistance: 0,
    estimatedDistance: 0,
    gpsError: '',
    diag: '',
    pointsAtHide: -1,
    bgGained: -1,
    mapMode: s.mapBroken ? 'fallback' : 'basemap',
    mapFallbackText: s.mapBroken ? s.mapFallbackText || '' : '',
  }
}
