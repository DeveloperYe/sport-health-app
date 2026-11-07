import test from 'node:test'
import assert from 'node:assert/strict'
import {
  waterTargetMl, waterPlan, cooldownLeftMs, formatLeft,
  inDrinkWindow, nextCupAt, hhmm,
  GUIDE_ML, MAX_DAILY_ML, MIN_CUP_ML, MAX_CUP_ML, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN,
} from '../src/utils/water-plan.js'

test('目标水量：体重 70kg 男 → 按体重 2100 胜出（>指南 1700）', () => {
  const r = waterTargetMl({ weightKg: 70, sex: 'male' })
  assert.equal(r.byWeight, 2100)
  assert.equal(r.guide, GUIDE_ML.male)
  assert.equal(r.base, 2100)
  assert.equal(r.basis, 'weight')
  assert.equal(r.total, 2100)
})

test('目标水量：体重 50kg 女 → 指南 1500 兜底（按体重只有 1500，取等）', () => {
  const r = waterTargetMl({ weightKg: 45, sex: 'female' })
  assert.equal(r.byWeight, 1350)
  assert.equal(r.base, 1500)
  assert.equal(r.basis, 'guide')
})

test('运动补偿：每运动 1 分钟 +10 ml', () => {
  const base = waterTargetMl({ weightKg: 70, sex: 'male' }).total
  const r = waterTargetMl({ weightKg: 70, sex: 'male', exerciseMin: 60 })
  assert.equal(r.bonus, 600)
  assert.equal(r.total, base + 600)
})

test('单日封顶 4000 ml（超量不叠加）', () => {
  const r = waterTargetMl({ weightKg: 120, sex: 'male', exerciseMin: 200 })
  assert.equal(r.total, MAX_DAILY_ML)
  assert.equal(r.capped, true)
})

test('缺省体重按 60kg 计（没填身体信息也能出计划）', () => {
  const r = waterTargetMl({})
  assert.equal(r.byWeight, 1800)
  assert.ok(r.total >= GUIDE_ML.male)
})

test('计划：2100ml / 250ml 杯 / 8–22 点 → 9 杯，间隔 105 分钟', () => {
  const p = waterPlan({ goalMlOverride: 2100, cupMl: 250, startHour: 8, endHour: 22 })
  assert.equal(p.cupMl, 250)
  assert.equal(p.cups, 9)
  assert.equal(p.spanMin, 840)
  assert.equal(p.intervalMin, 105) // 840 / 8
  assert.equal(p.basis, 'manual')
})

test('计划：杯容量变大 → 杯数变少、间隔变长', () => {
  const a = waterPlan({ goalMlOverride: 2000, cupMl: 200, startHour: 8, endHour: 22 })
  const b = waterPlan({ goalMlOverride: 2000, cupMl: 500, startHour: 8, endHour: 22 })
  assert.ok(b.cups < a.cups, `500ml 杯 ${b.cups} 应少于 200ml 杯 ${a.cups}`)
  assert.ok(b.intervalMin > a.intervalMin)
})

test('计划：时段越短 → 间隔越短', () => {
  const wide = waterPlan({ goalMlOverride: 2000, cupMl: 250, startHour: 7, endHour: 23 })
  const narrow = waterPlan({ goalMlOverride: 2000, cupMl: 250, startHour: 12, endHour: 16 })
  assert.ok(narrow.intervalMin < wide.intervalMin)
})

test('计划：杯容量与间隔都被夹到安全区间', () => {
  const tiny = waterPlan({ goalMlOverride: 3000, cupMl: 50, startHour: 8, endHour: 9 })
  assert.equal(tiny.cupMl, MIN_CUP_ML)
  assert.ok(tiny.intervalMin >= MIN_INTERVAL_MIN)
  const huge = waterPlan({ goalMlOverride: 3000, cupMl: 9999, startHour: 0, endHour: 24 })
  assert.equal(huge.cupMl, MAX_CUP_ML)
  assert.ok(huge.intervalMin <= MAX_INTERVAL_MIN)
})

test('计划：目标受单日上限约束（手动填 9999 也只到 4000）', () => {
  const p = waterPlan({ goalMlOverride: 9999, cupMl: 250 })
  assert.equal(p.goalMl, MAX_DAILY_ML)
})

test('★ 冷却：刚喝完 0 秒 → 剩余 = 间隔', () => {
  const now = 1000000
  assert.equal(cooldownLeftMs(now, 105, now), 105 * 60000)
})

test('★ 冷却：过了一半 → 剩一半；到点 → 0；不足 → 0', () => {
  const now = 1000000
  const half = now + Math.round((105 * 60000) / 2)
  assert.equal(cooldownLeftMs(now, 105, half), 105 * 60000 - Math.round((105 * 60000) / 2))
  assert.equal(cooldownLeftMs(now, 105, now + 105 * 60000), 0)
  assert.equal(cooldownLeftMs(now, 105, now + 999 * 60000), 0)
})

test('冷却：没喝过 → 0（不等）', () => {
  assert.equal(cooldownLeftMs(0, 105, Date.now()), 0)
})

test('formatLeft：分秒 / 时分秒', () => {
  assert.equal(formatLeft(0), '0:00')
  assert.equal(formatLeft(999), '0:01')
  assert.equal(formatLeft(63150), '1:03')
  assert.equal(formatLeft(3725000), '1:02:05')
})

test('inDrinkWindow：8–22 点内/外', () => {
  const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d }
  assert.equal(inDrinkWindow(at(8, 0), 8, 22), true)
  assert.equal(inDrinkWindow(at(14, 30), 8, 22), true)
  assert.equal(inDrinkWindow(at(22, 0), 8, 22), true)
  assert.equal(inDrinkWindow(at(23, 0), 8, 22), false)
  assert.equal(inDrinkWindow(at(6, 0), 8, 22), false)
})

test('nextCupAt / hhmm：下一杯时刻可读', () => {
  const base = new Date(2026, 10, 7, 9, 0, 0).getTime()
  const next = nextCupAt(base, 105)
  assert.equal(hhmm(next), '10:45')
})
