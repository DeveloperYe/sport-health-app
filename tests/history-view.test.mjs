// 运动历史展示层测试（纯函数）。
//
// 这个列表从「我的」页搬到运动页，源实现有两个用户直接能看到的毛病，这两条必须在测试里钉死：
//   ① 假总数：`history.slice(0,12)` 之后拿 `history.length` 当「共 N 条」
//   ② 日期重复：title 自带日期（`跑步 · 2026-11-20`），列表再显示一列日期就出现两次
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHistoryRows,
  stripDateFromTitle,
  historyDateLabel,
  prevDay,
  moreHistoryLimit,
  HISTORY_INITIAL,
  HISTORY_PAGE_STEP,
} from '../src/utils/history-view.js'

// allExerciseHistory() 的真实形状（day-summary.js:148-169）
const runItem = (id, date, extra) =>
  Object.assign(
    {
      kind: 'run',
      id,
      date,
      title: `跑步 · ${date}`,
      duration: 1800, // 秒
      calorie: 240,
      sub: '3000 步 · 2100 米',
      at: 1000,
    },
    extra
  )
const actItem = (id, date, extra) =>
  Object.assign(
    {
      kind: 'activity',
      id,
      date,
      title: `游泳 · ${date}`,
      duration: 2700,
      calorie: 315,
      sub: 'MET 7',
      at: 500,
    },
    extra
  )

test('② 日期重复：标题里的日期尾巴被摘掉（只保留动作名）', () => {
  assert.equal(stripDateFromTitle('跑步 · 2026-11-20'), '跑步')
  assert.equal(stripDateFromTitle('游泳 · 2026-11-20'), '游泳')
  assert.equal(stripDateFromTitle('健走 · 2026-01-01'), '健走')
  // 全角/半角间隔号都认，多余的空白也吃掉
  assert.equal(stripDateFromTitle('力量训练・2026-11-20  '), '力量训练')
  assert.equal(stripDateFromTitle('羽毛球•2026-11-20'), '羽毛球')
})

test('② 标题里没有日期 / 日期在中间时不动它', () => {
  assert.equal(stripDateFromTitle('跑步'), '跑步')
  assert.equal(stripDateFromTitle('2026-11-20 夜跑'), '2026-11-20 夜跑', '只摘"结尾的日期尾巴"')
  assert.equal(stripDateFromTitle(''), '')
  assert.equal(stripDateFromTitle(null), '')
  assert.equal(stripDateFromTitle(undefined), '')
})

test('② 行里的日期只出现一次：name 不含日期，dateLabel 才是日期', () => {
  const { rows } = buildHistoryRows([runItem('a', '2026-11-19')], { todayStr: '2026-11-20', limit: 10 })
  assert.equal(rows[0].name, '跑步')
  assert.equal(rows[0].dateLabel, '昨天')
  assert.equal(rows[0].name.includes('2026'), false, 'name 里不许再出现日期')
  // 更早的日子则出「M月D日」，同样只此一处
  const old = buildHistoryRows([actItem('b', '2026-10-09')], { todayStr: '2026-11-20', limit: 10 })
  assert.equal(old.rows[0].name, '游泳')
  assert.equal(old.rows[0].dateLabel, '10月9日')
})

test('日期标签：今天 / 昨天 / 同年月日 / 跨年带年份', () => {
  assert.equal(historyDateLabel('2026-11-20', '2026-11-20'), '今天')
  assert.equal(historyDateLabel('2026-11-19', '2026-11-20'), '昨天')
  assert.equal(historyDateLabel('2026-11-18', '2026-11-20'), '11月18日')
  assert.equal(historyDateLabel('2025-12-31', '2026-01-02'), '2025年12月31日')
  assert.equal(historyDateLabel('', '2026-11-20'), '')
})

test('日期标签：月份/日期补零不会漏（11月5日不写成 11月05日）', () => {
  assert.equal(historyDateLabel('2026-03-05', '2026-11-20'), '3月5日')
  assert.equal(historyDateLabel('2026-10-09', '2026-11-20'), '10月9日')
})

test('日期标签：解析不了的串原样返回，不显示空白', () => {
  assert.equal(historyDateLabel('坏数据', '2026-11-20'), '坏数据')
})

test('prevDay：跨月 / 跨年 / 闰年都对，坏输入返回空串', () => {
  assert.equal(prevDay('2026-11-20'), '2026-11-19')
  assert.equal(prevDay('2026-11-01'), '2026-10-31')
  assert.equal(prevDay('2026-01-01'), '2025-12-31')
  assert.equal(prevDay('2024-03-01'), '2024-02-29', '闰年 2 月 29 日')
  assert.equal(prevDay('坏数据'), '')
})

test('① 总数必须是真实全量，不是截断后的长度（源实现的 bug）', () => {
  const items = []
  for (let i = 0; i < 30; i++) items.push(runItem('r' + i, '2026-11-19', { at: i }))
  const v = buildHistoryRows(items, { todayStr: '2026-11-20', limit: HISTORY_INITIAL })
  assert.equal(v.total, 30, '共 30 条就写 30，不能写 10')
  assert.equal(v.shown, HISTORY_INITIAL)
  assert.equal(v.rows.length, HISTORY_INITIAL)
  assert.equal(v.remaining, 30 - HISTORY_INITIAL)
  // 源实现会拿 v.rows.length（=10）当总数 → 正是要避免的假总数
  assert.notEqual(v.total, v.rows.length)
})

test('① 条数不足一屏时 remaining 为 0、没「展开更多」', () => {
  const v = buildHistoryRows([runItem('a', '2026-11-20')], { todayStr: '2026-11-20', limit: 10 })
  assert.equal(v.total, 1)
  assert.equal(v.shown, 1)
  assert.equal(v.remaining, 0)
})

test('混合来源：跑步/健走与其他运动混排，按时间倒序（今日在最前）', () => {
  const v = buildHistoryRows(
    [
      runItem('r1', '2026-11-18', { at: 100 }),
      actItem('a1', '2026-11-20', { at: 900 }),
      runItem('r2', '2026-11-20', { at: 800 }),
    ],
    { todayStr: '2026-11-20', limit: 10 }
  )
  assert.deepEqual(v.rows.map((r) => r.name), ['游泳', '跑步', '跑步'])
  assert.deepEqual(v.rows.map((r) => r.dateLabel), ['今天', '今天', '11月18日'])
  assert.deepEqual(v.rows.map((r) => r.kind), ['activity', 'run', 'run'])
})

test('两类记录的 id 各自从 1 开始也不会互相顶掉（key 带 kind）', () => {
  const v = buildHistoryRows(
    [runItem('same', '2026-11-20', { at: 2 }), actItem('same', '2026-11-20', { at: 1 })],
    { todayStr: '2026-11-20', limit: 10 }
  )
  assert.equal(v.total, 2)
  assert.deepEqual(v.rows.map((r) => r.key), ['run:same', 'activity:same'])
})

test('重复 id 只留一条（上游两张表拼接时防重）', () => {
  const v = buildHistoryRows(
    [runItem('dup', '2026-11-20', { at: 1 }), runItem('dup', '2026-11-20', { at: 1 })],
    { todayStr: '2026-11-20', limit: 10 }
  )
  assert.equal(v.total, 1)
})

test('脏数据：没有 id 的项被丢掉，不产生空行', () => {
  const v = buildHistoryRows(
    [runItem('ok', '2026-11-20'), { kind: 'run', date: '2026-11-20' }, null, undefined],
    { todayStr: '2026-11-20', limit: 10 }
  )
  assert.equal(v.total, 1)
  assert.equal(v.rows[0].id, 'ok')
})

test('空列表 / 非数组入参都不抛，空态可判', () => {
  for (const bad of [[], null, undefined, 'abc', 42]) {
    const v = buildHistoryRows(bad, { todayStr: '2026-11-20' })
    assert.deepEqual(v.rows, [])
    assert.equal(v.total, 0)
    assert.equal(v.remaining, 0)
  }
})

test('limit 缺省 = 首屏 10 条；limit=0 时一条不渲染但总数照真', () => {
  const items = []
  for (let i = 0; i < 5; i++) items.push(runItem('r' + i, '2026-11-20', { at: i }))
  assert.equal(buildHistoryRows(items, {}).shown, Math.min(5, HISTORY_INITIAL))
  const zero = buildHistoryRows(items, { limit: 0 })
  assert.equal(zero.rows.length, 0)
  assert.equal(zero.total, 5)
})

test('展开更多：每次 +20 且不超过总数', () => {
  assert.equal(HISTORY_PAGE_STEP, 20)
  assert.equal(moreHistoryLimit(10, 100), 30)
  assert.equal(moreHistoryLimit(30, 100), 50)
  assert.equal(moreHistoryLimit(95, 100), 100, '最后一次补到总数就停')
  assert.equal(moreHistoryLimit(100, 100), 100)
  assert.equal(moreHistoryLimit(0, 3), 3)
  assert.equal(moreHistoryLimit(undefined, 0), 0)
})

test('展开到全量后，渲染条数 == 真实总数（与「共 N 条」对得上）', () => {
  const items = []
  for (let i = 0; i < 35; i++) items.push(actItem('a' + i, '2026-11-19', { at: i }))
  let limit = HISTORY_INITIAL
  let v = buildHistoryRows(items, { todayStr: '2026-11-20', limit })
  assert.equal(v.total, 35)
  while (v.remaining > 0) {
    limit = moreHistoryLimit(limit, v.total)
    v = buildHistoryRows(items, { todayStr: '2026-11-20', limit })
  }
  assert.equal(v.rows.length, 35)
  assert.equal(v.remaining, 0)
})
