import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldRemind } from '../src/utils/water-reminder.js'

// 固定时间：2026-11-20 14:30（在 8–22 点窗口内）
const T = new Date(2026, 10, 20, 14, 30).getTime()
const base = {
  enabled: true,
  silencedUntil: 0,
  nowMs: T,
  intervalMin: 120,
  startHour: 8,
  endHour: 22,
  cups: 5,
  goalCups: 8,
  lastCupAt: T - 121 * 60000, // 刚过冷却
}

test('条件齐备 → due（该提醒了）', () => {
  assert.equal(shouldRemind(base).remind, true)
  assert.equal(shouldRemind(base).reason, 'due')
})

test('开关关掉 → 绝不提醒（默认就是关的）', () => {
  const r = shouldRemind({ ...base, enabled: false })
  assert.equal(r.remind, false)
  assert.equal(r.reason, 'disabled')
})

test('「今天不再提醒」期间不提醒，并给出恢复时间', () => {
  const r = shouldRemind({ ...base, silencedUntil: T + 3600000 })
  assert.equal(r.remind, false)
  assert.equal(r.reason, 'silenced')
  assert.equal(r.nextAtMs, T + 3600000)
})

test('刚喝过（冷却中）不提醒，并给出还差多久', () => {
  const r = shouldRemind({ ...base, lastCupAt: T - 10 * 60000 }) // 10 分钟前
  assert.equal(r.remind, false)
  assert.equal(r.reason, 'cooldown')
  assert.ok(r.leftMs > 100 * 60000, `应还剩约 110 分钟，实际 ${r.leftMs}`)
})

test('不在允许时段不提醒（早上 6 点 / 夜里 23 点）', () => {
  const morning = new Date(2026, 10, 20, 6, 0).getTime()
  const night = new Date(2026, 10, 20, 23, 0).getTime()
  assert.equal(shouldRemind({ ...base, nowMs: morning }).reason, 'out-of-window')
  assert.equal(shouldRemind({ ...base, nowMs: night }).reason, 'out-of-window')
})

test('已达标不提醒（喝够了就别再烦人）', () => {
  const r = shouldRemind({ ...base, cups: 8 })
  assert.equal(r.remind, false)
  assert.equal(r.reason, 'goal-reached')
})

test('优先级：静音 > 时段 > 达标 > 冷却（静音时不该因为其它条件而提醒）', () => {
  const r = shouldRemind({ ...base, silencedUntil: T + 1, cups: 0, lastCupAt: 0 })
  assert.equal(r.reason, 'silenced')
})

test('没喝过（lastCupAt=0）且未达标 → due', () => {
  assert.equal(shouldRemind({ ...base, lastCupAt: 0, cups: 0 }).remind, true)
})

test('脏参数不抛：intervalMin 为 0 / goalCups 为 0 / 入参空', () => {
  assert.doesNotThrow(() => shouldRemind({ ...base, intervalMin: 0 }))
  assert.equal(shouldRemind({ ...base, goalCups: 0 }).remind, true, '目标未知时不该因达标而永久静音')
  assert.equal(shouldRemind().remind, false, '空入参按关闭处理')
})
