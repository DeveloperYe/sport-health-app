// 其他运动时长口径测试：秒是真值，分钟只是换算；这两条错了界面会显示"5 秒 = 1 分钟"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(
  fileURLToPath(new URL('../src/utils/activity-store.js', import.meta.url)),
  'utf8'
)
const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
const { summarizeActivities, formatActivityDuration } = m

test('时长展示：不足 1 分钟显示秒', () => {
  assert.equal(formatActivityDuration({ seconds: 5 }), '5 秒')
  assert.equal(formatActivityDuration({ seconds: 59 }), '59 秒')
})

test('时长展示：整分钟不带小数，非整分钟保留 1 位', () => {
  assert.equal(formatActivityDuration({ seconds: 60 }), '1 分钟')
  assert.equal(formatActivityDuration({ seconds: 600 }), '10 分钟')
  assert.equal(formatActivityDuration({ seconds: 90 }), '1.5 分钟')
})

test('老记录只有 minutes 时也能算（60 分钟 → 1 小时级显示）', () => {
  assert.equal(formatActivityDuration({ minutes: 45 }), '45 分钟')
  assert.equal(formatActivityDuration({ minutes: 0.5 }), '30 秒')
})

test('汇总：秒累加后再换算分钟，不会被逐条取整放大', () => {
  const sum = summarizeActivities([
    { seconds: 5, calorie: 1 },
    { seconds: 5, calorie: 1 },
    { seconds: 5, calorie: 1 },
  ])
  // 三条各 5 秒 = 15 秒 = 0.25 分钟 → 1 位小数 0.3；若逐条四舍五入成 1 分钟会变成 3
  assert.equal(sum.seconds, 15)
  assert.equal(sum.minutes, 0.3)
  assert.equal(sum.calorie, 3)
  assert.equal(sum.count, 3)
})

test('汇总：混合老记录（只有 minutes）与新记录（有 seconds）', () => {
  const sum = summarizeActivities([{ minutes: 2 }, { seconds: 30 }])
  assert.equal(sum.seconds, 150)
  assert.equal(sum.minutes, 2.5)
})

test('空列表返回全 0，不返回 NaN', () => {
  assert.deepEqual(summarizeActivities([]), { calorie: 0, minutes: 0, seconds: 0, count: 0 })
  assert.deepEqual(summarizeActivities(null), { calorie: 0, minutes: 0, seconds: 0, count: 0 })
})
