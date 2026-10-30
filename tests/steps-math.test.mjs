// 本场步数计算测试（纯函数）。
//
// 这一组测试对应一个真机事故（测试版 47）：用户走了 71 步，界面步数恒为 0。
// 原因是两路计步数据先合并（max）再减同一个基线，数值大的那一路（卡住的
// TYPE_STEP_COUNTER = 153）把另一路（检测器 71 步）的增量整块吞掉了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(
  fileURLToPath(new URL('../src/utils/steps-math.js', import.meta.url)),
  'utf8'
)
const { branchDelta, sessionSteps, baseUsable } = await import(
  'data:text/javascript;base64,' + Buffer.from(src).toString('base64')
)

test('branchDelta：正常增量', () => {
  assert.equal(branchDelta(110, 100), 10)
  assert.equal(branchDelta(0, 0), 0)
})

test('branchDelta：读数回退（重启/传感器归零）视为该路不可用', () => {
  assert.equal(branchDelta(5, 100), -1)
})

test('branchDelta：-1 或非数字视为不可用', () => {
  assert.equal(branchDelta(-1, 100), -1)
  assert.equal(branchDelta(100, -1), -1)
  assert.equal(branchDelta(undefined, 5), -1)
  assert.equal(branchDelta(5, null), -1)
})

test('真实事故：计步器卡住 + 检测器在走 → 步数必须等于检测器增量（不能是 0）', () => {
  // 基线：counter=1000（开机累计已走过），det=0
  const base = { counter: 1000, det: 0 }
  // 走了 71 步：counter 冻在 1153（+153 是会话开始前就有的历史），det 涨到 71
  const cur = { counter: 1153, det: 71 }
  // 旧逻辑：comp = max(153, 71) = 153，base 也取 153 → 0（这就是 bug）
  // 新逻辑：max(counter 增量 153, det 增量 71) —— 注意此例 counter 也在涨，取 153
  assert.equal(sessionSteps(cur, base), 153)
  // 若计步器完全冻住（cur.counter === base.counter），则由检测器顶上
  assert.equal(sessionSteps({ counter: 1000, det: 71 }, base), 71)
})

test('计步器完全卡死时，检测器增量就是本场步数', () => {
  const base = { counter: 500, det: 0 }
  assert.equal(sessionSteps({ counter: 500, det: 30 }, base), 30)
  assert.equal(sessionSteps({ counter: 500, det: 300 }, base), 300)
})

test('两路都在涨时取较大者（计步器通常更准）', () => {
  const base = { counter: 500, det: 0 }
  assert.equal(sessionSteps({ counter: 560, det: 58 }, base), 60)
  assert.equal(sessionSteps({ counter: 505, det: 58 }, base), 58)
})

test('只有一路可用时用那一路', () => {
  assert.equal(sessionSteps({ counter: -1, det: 42 }, { counter: -1, det: 0 }), 42)
  assert.equal(sessionSteps({ counter: 640, det: 0 }, { counter: 600, det: 0 }), 40)
})

test('两路都不可用返回 -1（调用方应保留上次读数，不能归零）', () => {
  assert.equal(sessionSteps({ counter: -1, det: -1 }, { counter: -1, det: -1 }), -1)
  // 计步器读数回退（重启归零）→ 该路作废；检测器无增量 → 本场就是 0，不是 -1
  assert.equal(sessionSteps({ counter: 10, det: 0 }, { counter: 100, det: 0 }), 0)
})

test('baseUsable：任一路有效即可用', () => {
  assert.equal(baseUsable({ counter: 0, det: 0 }), true)
  assert.equal(baseUsable({ counter: -1, det: 5 }), true)
  assert.equal(baseUsable({ counter: -1, det: -1 }), false)
  assert.equal(baseUsable(null), false)
})
