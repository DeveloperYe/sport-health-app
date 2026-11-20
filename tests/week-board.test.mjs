import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWeekBoard, dayLabel } from '../src/utils/week-board.js'

const GOALS = { steps: 8000, calorie: 300, water: 8 }
const d = (date, steps, calories, water, hasAny = true) => ({ date, steps, calories, water, hasAny })

test('一张图：7 天 × 每天 3 根柱（步数/消耗/饮水）', () => {
  const b = buildWeekBoard([d('2026-11-20', 1000, 100, 2), d('2026-11-19', 2000, 50, 1)], GOALS)
  assert.equal(b.groups.length, 2)
  assert.equal(b.groups[0].bars.length, 3)
  assert.deepEqual(b.groups[0].bars.map((x) => x.key), ['steps', 'calorie', 'water'])
  assert.deepEqual(b.series.map((s) => s.label), ['步数', '消耗', '饮水'])
})

test('三根柱共用"占目标百分比"口径：100% 等于各自目标', () => {
  const b = buildWeekBoard([d('2026-11-20', 8000, 300, 8)], GOALS)
  for (const bar of b.groups[0].bars) {
    assert.equal(bar.pct, 100, `${bar.key} 达目标应为 100%`)
    assert.equal(bar.hit, true)
  }
})

test('超目标夹到 100%（保留真实值）：150% 不该画成顶天一半', () => {
  const b = buildWeekBoard([d('2026-11-20', 12000, 450, 12)], GOALS)
  for (const bar of b.groups[0].bars) {
    assert.equal(bar.pct, 100)
    assert.equal(bar.value, { steps: 12000, calorie: 450, water: 12 }[bar.key])
  }
})

test('没记录的日子：柱高 0 且标 empty，日均也不含它', () => {
  const days = [
    d('2026-11-14', null, null, null, false),
    d('2026-11-15', 4000, 100, 2),
    d('2026-11-16', null, null, null, false),
    d('2026-11-17', 6000, 200, 4),
  ]
  const b = buildWeekBoard(days, GOALS)
  const g0 = b.groups[0]
  assert.equal(g0.empty, true)
  for (const bar of g0.bars) {
    assert.equal(bar.empty, true)
    assert.equal(bar.pct, 0)
  }
  const steps = b.series.find((s) => s.key === 'steps')
  assert.equal(steps.avg, 5000, '(4000+6000)/2，不是除以 4')
  assert.equal(b.recordedDays, 2)
})

test('全周无记录：allEmpty=true、日均统一破折号（不能显示 0）', () => {
  const b = buildWeekBoard([d('2026-11-19', null, null, null, false), d('2026-11-20', null, null, null, false)], GOALS)
  assert.equal(b.allEmpty, true)
  for (const s of b.series) {
    assert.equal(s.avg, null)
    assert.equal(s.avgText, '—')
  }
})

test('目标为 0 时退回"按该序列自身最大值"做刻度，不至于整图空白', () => {
  const b = buildWeekBoard([d('2026-11-20', 5000, 0, 0), d('2026-11-19', 2500, 0, 0)], { steps: 0, calorie: 0, water: 0 })
  const stepsBar = b.groups.find((x) => x.label === '20').bars.find((x) => x.key === 'steps')
  assert.equal(stepsBar.pct, 100, '最大值自己应画满')
  const half = b.groups.find((x) => x.label === '19').bars.find((x) => x.key === 'steps')
  assert.equal(half.pct, 50)
  assert.equal(stepsBar.hit, false, '没设目标不算达标')
})

test('达标判定：等于或超过目标才算 hit', () => {
  const b = buildWeekBoard([d('2026-11-19', 7999, 299, 7), d('2026-11-20', 8000, 301, 9)], GOALS)
  const g19 = b.groups[0]
  const g20 = b.groups[1]
  for (let i = 0; i < 3; i++) {
    assert.equal(g19.bars[i].hit, false)
    assert.equal(g20.bars[i].hit, true)
  }
})

test('脏数据与空输入不抛（含 goals=null、天数组含 null）', () => {
  assert.doesNotThrow(() => buildWeekBoard())
  assert.doesNotThrow(() => buildWeekBoard(null, null))
  const b = buildWeekBoard([null, { date: '' }, {}], null)
  assert.equal(b.groups.length, 3)
  assert.equal(b.groups[0].bars.length, 3)
  assert.equal(b.groups[0].bars[0].pct, 0)
})

test('dayLabels 与 groups 一一对应（模板按下标渲染不会错位）', () => {
  const b = buildWeekBoard([d('2026-11-05'), d('2026-11-20')], GOALS)
  assert.deepEqual(b.dayLabels, ['5', '20'])
  assert.equal(b.dayLabels.length, b.groups.length)
})

test('dayLabel：只取日、去前导 0；非法给 ?', () => {
  assert.equal(dayLabel('2026-11-05'), '5')
  assert.equal(dayLabel('2026-11-20'), '20')
  assert.equal(dayLabel('bad'), '?')
  assert.equal(dayLabel(''), '?')
  assert.equal(dayLabel(null), '?')
})
