// 运动页会话状态机测试（纯函数 + 时序骨架）。
//
// 对应 2026-11-20 盘点出的两个真 bug：
//   P0-1 双击「结束」会写两条记录（finish 在 await 之后才落库，期间按钮还在）
//   P0-2 「开始」的两处 await 窗口里点结束/暂停，会让 state 归位但 GPS/计时照跑
//
// 这里的 harness 不含 Vue / uni，只把 sport.vue 的 start()/finish() 时序骨架
// （守卫 → await → 复核 → 建 timer）按真实顺序重写一遍，用可控 gate 决定每个
// await 何时落地，然后把「记录条数」「timer 个数」「GPS 是否被停」当作可观测结果。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guardStart,
  tapFinish,
  afterAwait,
  isCurrentSession,
  shouldDiscardSession,
  sessionMinutes,
  sessionCalorieByMet,
  mergeSessionReset,
  MIN_SESSION_SECONDS,
} from '../src/utils/sport-session.js'

// 与 health.js 的 MODES 对齐（health.js 带 uni 条件编译，纯测试不能 import，
// 数值改动时要同步这里 —— 见 sport-session.js 里 sessionCalorieByMet 的参数说明）
const MODES = {
  run: { label: '跑步', met: 8.0 },
  walk: { label: '健走', met: 4.3 },
}

// ===== 可控 gate：让测试决定 await 何时落地 =====
function makeGate() {
  let release
  const p = new Promise((r) => {
    release = r
  })
  return { wait: () => p, release }
}

function createPage() {
  return {
    state: 'idle',
    finishing: false,
    sessionToken: 0,
    seconds: 0,
    track: 'none', // none / active / stopped
    timers: [],
    subscriptions: [],
    records: [],
    toasts: [],
    mapBroken: false,
    mapFallbackText: '',
  }
}

// 与 sport.vue start() 同序：守卫 → token → await#1 → 复核 → await#2 → 复核 → 建 timer/订阅
async function startSession(page, gates) {
  if (!guardStart(page.state)) return 'blocked'
  const token = ++page.sessionToken
  page.state = 'running'

  await gates.step.wait() // await getStepBranches()：非原生路径最长 3 s
  if (!isCurrentSession(token, page.sessionToken)) return 'superseded@step'

  page.track = 'active' // await startTrack()：首次运行弹系统授权框
  await gates.gps.wait()
  if (!isCurrentSession(token, page.sessionToken)) {
    page.track = 'stopped'
    return 'superseded@gps'
  }
  if (!afterAwait(page.state)) return abortSession(page, token)

  page.subscriptions.push('track-update')
  page.timers.push('tick')
  return 'running'
}

function abortSession(page, token) {
  if (!isCurrentSession(token, page.sessionToken)) return 'superseded'
  page.track = 'stopped'
  Object.assign(page, mergeSessionReset(page))
  return 'aborted'
}

// 与 sport.vue finish() 同序：同步上锁 → 作废在途 start → await → 阈值 → 落库 → 复位
async function finishSession(page, stepGate) {
  const gate = tapFinish(page)
  if (!gate.proceed) return gate.reason
  page.finishing = true // 必须同步，锁挪到 await 之后就看不住双击
  page.sessionToken++

  await stepGate.wait() // await getStepBranches()：读本场两路读数
  if (shouldDiscardSession(page.seconds)) {
    Object.assign(page, mergeSessionReset(page))
    page.toasts.push('运动时间太短')
    return 'discarded'
  }
  page.records.push({ minutes: sessionMinutes(page.seconds), steps: 0 })
  Object.assign(page, mergeSessionReset(page))
  return 'saved'
}

// ===== P0-1：双击结束只能记一条 =====
test('P0-1 双击「结束」只产生 1 条记录（第二次被重入锁挡住）', async () => {
  const page = createPage()
  page.state = 'running'
  page.track = 'active'
  page.seconds = 600
  const g1 = makeGate()
  const g2 = makeGate()

  const first = finishSession(page, g1) // 用户第一次点结束，卡在读计步
  const second = await finishSession(page, g2) // 同一帧内第二次点
  assert.equal(second, 'busy', '第二次点结束必须被锁挡住，而不是排队再记一条')

  g1.release()
  g2.release()
  assert.equal(await first, 'saved')
  assert.equal(page.records.length, 1, '双击结束只能落 1 条记录')
})

test('P0-1 结束锁在 resetSession 里复位：下一次会话还能正常结束', async () => {
  const page = createPage()
  page.state = 'running'
  page.seconds = 600
  const g1 = makeGate()
  const g2 = makeGate()
  const p1 = finishSession(page, g1)
  g1.release()
  await p1
  assert.equal(page.state, 'idle')
  assert.equal(page.finishing, false, '锁没复位的话页面从此再也结束不了')

  page.state = 'running'
  page.seconds = 120
  const p2 = finishSession(page, g2)
  g2.release()
  assert.equal(await p2, 'saved')
  assert.equal(page.records.length, 2)
})

test('P0-1 idle / 重复结束时不落库', async () => {
  const page = createPage()
  assert.deepEqual(tapFinish(page), { proceed: false, reason: 'not-running' })
  page.state = 'paused'
  assert.equal(tapFinish(page).proceed, true, '暂停态可以结束')
  page.finishing = true
  assert.deepEqual(tapFinish(page), { proceed: false, reason: 'busy' })
})

test('P0-1 已经停下来的会话再点结束不会写记录', async () => {
  const page = createPage()
  page.state = 'running'
  page.seconds = 600
  const g1 = makeGate()
  const p = finishSession(page, g1)
  g1.release()
  await p
  // 界面已经回到 idle，用户又点了一下（例如惯性连点落在同一位置）
  const g2 = makeGate()
  const again = await finishSession(page, g2)
  assert.equal(again, 'not-running')
  assert.equal(page.records.length, 1)
})

// ===== P0-2：await 窗口里被结束 =====
test('P0-2 第一处 await（计步读数）期间点结束 → 不再建 timer、不建 track', async () => {
  const page = createPage()
  const gates = { step: makeGate(), gps: makeGate() }
  const gpsFinish = makeGate()

  const starting = startSession(page, gates) // 卡在计步读数
  const finishing = finishSession(page, gpsFinish) // 用户点结束
  gpsFinish.release()
  assert.equal(await finishing, 'discarded', '0 秒的会话按太短丢弃')

  gates.step.release()
  assert.equal(await starting, 'superseded@step')
  assert.equal(page.timers.length, 0, '结束之后绝不能再建计时器')
  assert.equal(page.subscriptions.length, 0)
  assert.equal(page.state, 'idle')
})

test('P0-2 第二处 await（定位授权框）期间点结束 → GPS 被撤掉、不建 timer', async () => {
  const page = createPage()
  const gates = { step: makeGate(), gps: makeGate() }
  const gpsFinish = makeGate()

  const starting = startSession(page, gates)
  gates.step.release() // 过了第一道
  await new Promise((r) => setImmediate(r))
  assert.equal(page.track, 'active', '此时 startTrack 已建会话，正是原来的漏洞窗口')

  const finishing = finishSession(page, gpsFinish)
  gpsFinish.release()
  await finishing

  gates.gps.release()
  assert.equal(await starting, 'superseded@gps')
  assert.equal(page.track, 'stopped', '结束之后 GPS 必须停，不能留幽灵采集')
  assert.equal(page.timers.length, 0)
})

test('P0-2 窗口期被暂停 → 中止整场（不留下 state=paused 但无采集的幽灵会话）', async () => {
  const page = createPage()
  const gates = { step: makeGate(), gps: makeGate() }
  const starting = startSession(page, gates)
  gates.step.release()
  await new Promise((r) => setImmediate(r))

  page.state = 'paused' // 用户在授权框弹着的时候点了暂停
  gates.gps.release()
  assert.equal(await starting, 'aborted')
  assert.equal(page.state, 'idle')
  assert.equal(page.track, 'stopped')
  assert.equal(page.timers.length, 0)
})

test('P0-2 await 期间被新一轮开始顶掉 → 旧流程放弃，不出现两套 timer', async () => {
  const page = createPage()
  const gates1 = { step: makeGate(), gps: makeGate() }
  const first = startSession(page, gates1)
  // 第一轮还卡在 await 里（state 已经是 running，正常入口进不来第二轮；
  // 这里直接模拟"程序化/异常路径又调了一次 start"之后 token 被顶掉的情形）
  page.sessionToken++ // 相当于有人又发起了一轮
  gates1.step.release()
  assert.equal(await first, 'superseded@step')
  assert.equal(page.timers.length, 0)
})

test('P0-2 守卫：非 idle 不允许开始', () => {
  assert.equal(guardStart('idle'), true)
  assert.equal(guardStart('running'), false)
  assert.equal(guardStart('paused'), false)
  assert.equal(guardStart(undefined), false)
  // 中止后必须回到能重新开始的状态
  const page = Object.assign(createPage(), { state: 'running' })
  Object.assign(page, mergeSessionReset(page))
  assert.equal(guardStart(page.state), true)
})

// ===== 判定函数本身的边界 =====
test('afterAwait：只有仍是 running 才继续', () => {
  assert.equal(afterAwait('running'), true)
  assert.equal(afterAwait('paused'), false)
  assert.equal(afterAwait('idle'), false)
  assert.equal(afterAwait('running', 'paused'), false, 'expected 可覆盖')
})

test('isCurrentSession：token 必须一致且有效', () => {
  assert.equal(isCurrentSession(3, 3), true)
  assert.equal(isCurrentSession(3, 4), false, '被新一轮顶掉')
  assert.equal(isCurrentSession(0, 0), false, '0 号不算有效会话')
  assert.equal(isCurrentSession(undefined, undefined), false)
})

// ===== P2-8：结束阈值按秒真值判，不再被四舍五入放宽到 30 秒 =====
test('P2-8 不足 60 秒整场丢弃（原先 31 秒会被 round 成 1 分钟入库）', () => {
  assert.equal(MIN_SESSION_SECONDS, 60)
  assert.equal(shouldDiscardSession(0), true)
  assert.equal(shouldDiscardSession(29), true)
  assert.equal(shouldDiscardSession(31), true, '31 秒按旧逻辑会记成 1 分钟，这里必须丢弃')
  assert.equal(shouldDiscardSession(59), true)
  assert.equal(shouldDiscardSession(60), false)
  assert.equal(shouldDiscardSession(61), false)
  assert.equal(shouldDiscardSession(undefined), true, '缺值当误触')
  assert.equal(shouldDiscardSession(NaN), true)
})

test('sessionMinutes：秒换分钟，入库时间不再出现 0 分钟', () => {
  assert.equal(sessionMinutes(60), 1)
  assert.equal(sessionMinutes(89), 1)
  assert.equal(sessionMinutes(90), 2)
  assert.equal(sessionMinutes(600), 10)
  assert.equal(sessionMinutes(0), 0)
})

// ===== 口径 C（2026-11-20 用户拍板）：热量 = MET × 体重 × 时长，与步数无关 =====
test('口径 C：30 分钟 60kg 跑步 / 健走的热量与 1.86 倍关系', () => {
  const run = sessionCalorieByMet({ met: MODES.run.met, minutes: 30, weightKg: 60 })
  const walk = sessionCalorieByMet({ met: MODES.walk.met, minutes: 30, weightKg: 60 })
  assert.equal(run, 240, '8.0 × 60kg × 0.5h')
  assert.equal(walk, 129, '4.3 × 60kg × 0.5h')
  const ratio = run / walk
  assert.ok(Math.abs(ratio - 8.0 / 4.3) < 0.02, `跑步/健走比值应≈1.86，实际 ${ratio.toFixed(3)}`)
  assert.ok(run > walk, '同样时长的跑步热量必须高于健走，否则两个页签没有实际差别')
})

test('口径 C：0 分钟 / 负时长 → 0 千卡', () => {
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: 0, weightKg: 60 }), 0)
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: -5, weightKg: 60 }), 0)
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: '', weightKg: 60 }), 0)
})

test('口径 C：MET 非法（mode 传错/库里没有）→ 0，不抛异常', () => {
  assert.equal(sessionCalorieByMet({ met: undefined, minutes: 30, weightKg: 60 }), 0)
  assert.equal(sessionCalorieByMet({ met: 0, minutes: 30, weightKg: 60 }), 0)
  assert.equal(sessionCalorieByMet({ met: NaN, minutes: 30, weightKg: 60 }), 0)
  assert.equal(sessionCalorieByMet({ met: MODES['nonexistent'] && MODES['nonexistent'].met, minutes: 30, weightKg: 60 }), 0)
  assert.equal(sessionCalorieByMet(undefined), 0)
  assert.equal(sessionCalorieByMet(null), 0)
})

test('口径 C：体重为 0 / 未填 → 0（调用方负责用默认 60 兜底并给提示）', () => {
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: 30, weightKg: 0 }), 0)
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: 30, weightKg: '' }), 0)
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: 30, weightKg: undefined }), 0)
  // 默认体重 60 的下限口径：60kg 有效
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: 30, weightKg: 60 }), 240)
})

test('口径 C：跑步 vs 健走 30 分钟的比值钉在 8.0/4.3（≈1.86）', () => {
  // 用 60kg、30 分钟这一组用户实际会看到的数字钉死：
  //   跑步 8.0 × 60 × 0.5h = 240 kcal
  //   健走 4.3 × 60 × 0.5h = 129 kcal
  // 240/129 = 1.8605，与 8.0/4.3 = 1.8605 一致（取整带来的偏差 ≤ 0.4%）
  const run = sessionCalorieByMet({ met: 8.0, minutes: 30, weightKg: 60 })
  const walk = sessionCalorieByMet({ met: 4.3, minutes: 30, weightKg: 60 })
  assert.equal(run, 240)
  assert.equal(walk, 129)
  const expect = 8.0 / 4.3
  const actual = run / walk
  assert.ok(Math.abs(actual - expect) < 0.01, `比值 ${actual.toFixed(4)} 应≈${expect.toFixed(4)}`)
  // 长时长时取整误差被抹平，比值更贴近理论值
  const run5 = sessionCalorieByMet({ met: 8.0, minutes: 300, weightKg: 60 })
  const walk5 = sessionCalorieByMet({ met: 4.3, minutes: 300, weightKg: 60 })
  assert.equal(run5, 2400)
  assert.equal(walk5, 1290)
  assert.ok(Math.abs(run5 / walk5 - 8.0 / 4.3) < 0.001)
})

test('口径 C：体重翻倍 → 热量翻倍（线性），体重变了历史记录不变', () => {
  const base = sessionCalorieByMet({ met: 8.0, minutes: 30, weightKg: 60 })
  const double = sessionCalorieByMet({ met: 8.0, minutes: 30, weightKg: 120 })
  assert.equal(base, 240)
  assert.equal(double, 480)
  assert.equal(double, base * 2, 'MET 口径对体重是严格线性')
  // 同一个人 60→70kg：240 → 280（8.0×70×0.5=280）
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: 30, weightKg: 70 }), 280)
  // 时长翻倍同样翻倍（另一条线性轴）
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: 60, weightKg: 60 }), 480)
})

test('口径 C：与「其他运动」同一个公式（同样的 MET/体重/时长结果必须一致）', () => {
  // calcExerciseCalorie 是 body-calc.js 的实现，这里用等价算例钉住口径没被改坏
  const byHelper = sessionCalorieByMet({ met: 5.0, minutes: 45, weightKg: 70 })
  // 5.0 × 70 × 0.75 = 262.5 → round = 263
  assert.equal(byHelper, 263)
  // 热身：极短时长也不出负数/NaN
  assert.equal(sessionCalorieByMet({ met: 8.0, minutes: 0.5, weightKg: 60 }), 4)
})

// ===== P1-4：resetSession 必须清干净的字段 =====
test('mergeSessionReset：清掉上次会话残留（估算距离/错误/底图回退/后台增点）', () => {
  const prev = {
    state: 'running',
    finishing: true,
    seconds: 187,
    liveSteps: 210,
    stepBase: { counter: 1200, det: 33 },
    trackPoints: [{ lat: 1 }],
    gpsDistance: 830,
    estimatedDistance: 120,
    gpsError: '定位失败：请确认已授权定位权限',
    diag: 'sen:1 dt:1 c+12 d+10',
    pointsAtHide: 17,
    bgGained: 5,
    mapMode: 'fallback',
    mapFallbackText: '轨迹超出离线底图范围（青岛市区）',
    mapBroken: false,
  }
  const s = mergeSessionReset(prev)
  assert.equal(s.state, 'idle')
  assert.equal(s.finishing, false, '锁必须复位')
  assert.equal(s.seconds, 0)
  assert.equal(s.liveSteps, 0)
  assert.deepEqual(s.stepBase, { counter: -1, det: -1 })
  assert.deepEqual(s.trackPoints, [])
  assert.equal(s.gpsDistance, 0)
  assert.equal(s.estimatedDistance, 0, '否则 idle 下仍显示「含估算 120 米」')
  assert.equal(s.gpsError, '', '否则错误提示一直挂着')
  assert.equal(s.diag, '')
  assert.equal(s.pointsAtHide, -1)
  assert.equal(s.bgGained, -1, '否则下次会话首屏显示上次的后台增点')
  assert.equal(s.mapMode, 'basemap', '上一轮越界降级不该让用户下次还在自绘层')
  assert.equal(s.mapFallbackText, '')
})

test('mergeSessionReset：底图彻底坏了（mapBroken）时保留自绘层，不再无谓重试', () => {
  const s = mergeSessionReset({ mapBroken: true, mapFallbackText: 'WebGL 初始化失败' })
  assert.equal(s.mapMode, 'fallback')
  assert.equal(s.mapFallbackText, 'WebGL 初始化失败')
})
