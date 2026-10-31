// 热量/身体计算测试：这些数字直接决定界面上"缺口"是多少，算错了不会报错，
// 只会静默算偏，所以必须有断言钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(
  fileURLToPath(new URL('../src/utils/body-calc.js', import.meta.url)),
  'utf8'
)
const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
const {
  calcBMR, calcBMRKatch, calcBMRMifflin, calcLeanMass, calcBMI, bmiLabel,
  calcTDEE, macroToCalorie, calcExerciseCalorie, calcGap,
  calcStepCalorie, calcStepMinutes, calcStepsForCalorie,
  calcWeightSlope, forecastDaysToGoal, recommendGoals,
} = m

test('Katch-McArdle：按体脂率算，72kg / 18% 体脂 → 约 1645', () => {
  // 瘦体重 = 72 × 0.82 = 59.04 → BMR = 370 + 21.6 × 59.04 = 1645.3
  assert.equal(calcBMRKatch(72, 18), 1645)
  assert.equal(calcLeanMass(72, 18), 59)
})

test('Mifflin-St Jeor：男 72/178/28 → 1698；女同参数少 166', () => {
  assert.equal(calcBMRMifflin(72, 178, 28, 'male'), 1698)
  assert.equal(calcBMRMifflin(72, 178, 28, 'female'), 1532)
})

test('calcBMR 自动选公式：有体脂率走 Katch，没有走 Mifflin，都没有返回 0', () => {
  assert.deepEqual(calcBMR({ weight: 72, bodyFat: 18, height: 178, age: 28, sex: 'male' }), {
    value: 1645,
    formula: 'katch',
  })
  assert.deepEqual(calcBMR({ weight: 72, height: 178, age: 28, sex: 'male' }), {
    value: 1698,
    formula: 'mifflin',
  })
  assert.deepEqual(calcBMR({}), { value: 0, formula: 'none' })
})

test('缺数据不报错、返回 0（而不是 NaN）', () => {
  assert.equal(calcBMRKatch('', 18), 0)
  assert.equal(calcBMRMifflin(72, '', 28, 'male'), 0)
  assert.equal(calcBMI('', 178), 0)
  assert.equal(calcExerciseCalorie(7, 0, 40), 0)
})

test('BMI 与分级', () => {
  assert.equal(calcBMI(72, 178), 22.7)
  assert.equal(bmiLabel(22.7), '正常')
  assert.equal(bmiLabel(17), '偏瘦')
  assert.equal(bmiLabel(26), '偏胖')
  assert.equal(bmiLabel(30), '肥胖')
})

test('TDEE = BMR × 活动系数 + 运动消耗', () => {
  assert.equal(calcTDEE(1645, 1.55, 0), 2550) // 2549.75 → 2550
  assert.equal(calcTDEE(1645, 1.55, 258), 2808)
  assert.equal(calcTDEE(0, 1.55, 100), 0)
  // 活动系数缺失时按 1.2 兜底
  assert.equal(calcTDEE(1000, 0, 0), 1200)
})

test('MET 消耗：游泳 MET7 × 72kg × 45min = 378', () => {
  assert.equal(calcExerciseCalorie(7, 72, 45), 378)
  assert.equal(calcExerciseCalorie(8.3, 72, 30), 299)
})

test('营养素换算：碳4/蛋4/脂9', () => {
  assert.equal(macroToCalorie(40, 20, 10), 330)
})

test('热量缺口 = 摄入 − 消耗（负数=缺口）', () => {
  assert.equal(calcGap(1030, 3324), -2294)
  assert.equal(calcGap(2500, 2000), 500)
})

test('步数估算与反向换算自洽（每步 0.7m、5km/h、MET3）', () => {
  const kcal = calcStepCalorie(10000, 70)
  assert.equal(kcal, 294)
  assert.equal(calcStepMinutes(10000), 84)
  // 反向：抵消 294 千卡约需 10000 步（允许四舍五入误差）
  const steps = calcStepsForCalorie(294, 70)
  assert.ok(Math.abs(steps - 10000) < 200, `反向步数偏差过大: ${steps}`)
})

test('体重趋势最小二乘斜率：每天 -0.15kg 的线性数据', () => {
  const log = [
    { d: '2026-10-01', w: 75 }, { d: '2026-10-02', w: 74.85 },
    { d: '2026-10-03', w: 74.7 }, { d: '2026-10-04', w: 74.55 },
    { d: '2026-10-05', w: 74.4 },
  ]
  assert.equal(calcWeightSlope(log), -0.15)
  assert.equal(calcWeightSlope([{ d: '2026-10-01', w: 75 }]), 0)
})

test('到目标体重天数：方向一致才算得出来', () => {
  assert.equal(forecastDaysToGoal(72, -0.15, 68), 27)
  assert.equal(forecastDaysToGoal(72, 0.1, 68), -1) // 趋势反了
  assert.equal(forecastDaysToGoal(72, 0, 68), -1)
  assert.equal(forecastDaysToGoal(68, -0.15, 68), 0)
})

test('一键推荐：减脂目标给 TDEE-500，且不低于 BMR×1.1', () => {
  const r = recommendGoals({ tdee: 2550, bmr: 1645, weightKg: 72, targetWeight: 68 })
  assert.equal(r.calorie, 2050)
  assert.equal(r.protein, 115) // 72 × 1.6
  assert.equal(r.water, 10) // 72 × 35ml / 250ml ≈ 10 杯
  // 目标体重比当前大 → 反而是增重
  const up = recommendGoals({ tdee: 2000, bmr: 1645, weightKg: 60, targetWeight: 65 })
  assert.equal(up.calorie, 2200)
  // 缺口过深时兜底到 BMR×1.1
  const low = recommendGoals({ tdee: 1700, bmr: 1645, weightKg: 60, targetWeight: 50 })
  assert.equal(low.calorie, 1810)
})
