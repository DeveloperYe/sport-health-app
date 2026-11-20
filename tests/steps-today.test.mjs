import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTodaySteps, daysBetween, sessionSteps, branchDelta } from '../src/utils/steps-math.js'

const D1 = '2026-11-19'
const D2 = '2026-11-20'

test('daysBetween：相邻两天 / 跨多天 / 异常输入', () => {
  assert.equal(daysBetween(D1, D2), 1)
  assert.equal(daysBetween('2026-11-15', D2), 5)
  assert.equal(daysBetween('', D2), 1)
  assert.equal(daysBetween(D2, D1), 1) // 回退也按 1 处理
})

test('首装：无记录 → 开机累计全额算今天', () => {
  const r = resolveTodaySteps(null, { counter: 3500, det: 40 }, D2)
  assert.equal(r.rec.base, 0)
  assert.equal(r.steps, 3500)
})

test('正常跨天：base = 昨日末值，今日只算增量', () => {
  const rec = { date: D1, base: 0, detBase: 0, lastRaw: 8000, offset: 0 }
  const r = resolveTodaySteps(rec, { counter: 8120, det: 500 }, D2)
  assert.equal(r.rec.base, 8000)
  assert.equal(r.steps, 120)
})

test('★ 跨天且手机重启过：新的一天从 0 起算，之后正常累加（旧实现会一直是 0）', () => {
  const rec = { date: D1, base: 0, detBase: 0, lastRaw: 8000, offset: 0 }
  // 重启后 counter 只有 120（开机累计归零）
  const r = resolveTodaySteps(rec, { counter: 120, det: 30 }, D2)
  assert.equal(r.rec.base, 120, 'base 应取 min(昨日末值, 当前读数)，否则 counterDelta 永远是负')
  assert.equal(r.steps, 0, '跨天那一刻 detector 基线也重置，从 0 开始')
  // 再走 10 步：counter 与 detector 各涨 10，今日步数应变成 10（旧实现这里仍是 0）
  const r2 = resolveTodaySteps(r.rec, { counter: 130, det: 40 }, D2)
  assert.equal(r2.steps, 10)
})

test('★ 隔了 5 天没开 App：绝不把 5 天算成今天', () => {
  const rec = { date: '2026-11-15', base: 0, detBase: 0, lastRaw: 8000, offset: 0 }
  const r = resolveTodaySteps(rec, { counter: 40000, det: 900 }, D2)
  assert.equal(r.rec.base, 40000, '多天未开 → 从此刻起算')
  assert.equal(r.steps, 0)
})

test('同一天内手机重启：offset 补回重启前的量', () => {
  const rec = { date: D2, base: 1000, detBase: 0, lastRaw: 5000, offset: 0 }
  const r = resolveTodaySteps(rec, { counter: 200, det: 10 }, D2)
  assert.equal(r.rec.offset, 5000, 'offset += lastRaw')
  // counterDelta = 5000 + (200-1000<0 → 0) = 5000；detDelta = 10
  assert.equal(r.steps, 5000)
})

test('同一天正常增长：counterDelta 与 detDelta 取大', () => {
  const rec = { date: D2, base: 1000, detBase: 0, lastRaw: 1200, offset: 0 }
  const a = resolveTodaySteps(rec, { counter: 1250, det: 10 }, D2) // counter 增量 250
  assert.equal(a.steps, 250)
  const b = resolveTodaySteps(rec, { counter: 1200, det: 300 }, D2) // detector 增量 300
  assert.equal(b.steps, 300)
})

test('两路都未就绪：steps=-1（调用方应沿用上次值，不显示 0）', () => {
  const r = resolveTodaySteps(null, { counter: -1, det: 0 }, D2)
  assert.equal(r.steps, -1)
})

test('detector 读数回退（进程清零）→ 重设基线，不会出现负增量', () => {
  const rec = { date: D2, base: 0, detBase: 500, lastRaw: 100, offset: 0 }
  const r = resolveTodaySteps(rec, { counter: 150, det: 20 }, D2)
  assert.equal(r.rec.detBase, 20)
  assert.ok(r.steps >= 0)
})

test('回归：两路各记基线的会话计步仍然正确', () => {
  // counter 卡住（1853→1853），detector 正常 0→71
  const cur = { counter: 1853, det: 71 }
  const base = { counter: 1853, det: 0 }
  assert.equal(sessionSteps(cur, base), 71)
  assert.equal(sessionSteps({ counter: -1, det: -1 }, { counter: 1, det: 1 }), -1)
  assert.equal(branchDelta(5, 10), -1)
})
