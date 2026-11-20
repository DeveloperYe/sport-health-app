import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStepReport, VERDICTS } from '../src/utils/step-selftest.js'

const APP_OK = {
  platform: 'app',
  nativeAvailable: true,
  registered: true,
  cb: 12,
  ev: 8,
  counter: 1234,
  det: 1200,
  comp: 1200,
  base: 1100,
  lastRaw: 1234,
  offset: 0,
  date: '2026-11-20',
  sysDate: '2026-11-20',
  today: 134,
  stored: 134,
  err: '',
}

test('正常：今日有值 → ok，且所有关键字段都出现在同一行里', () => {
  const r = buildStepReport(APP_OK)
  assert.equal(r.verdict, 'ok')
  for (const k of ['平台:app', '原生:ok', '注册:1', '事件:12/8', '读数:1234/1200', '复合:1200', '基线:1100', '原始:1234', '今日:134', '存档:134', '判定:ok']) {
    assert.ok(r.line.includes(k), `缺字段 ${k}：${r.line}`)
  }
})

test('H5：直接判 no-app（这是设计不是故障，不能说成坏了）', () => {
  const r = buildStepReport({ platform: 'h5', nativeAvailable: false, today: 0, stored: 0 })
  assert.equal(r.verdict, 'no-app')
  assert.ok(r.line.startsWith('平台:h5'), r.line)
  assert.ok(!r.line.includes('注册:'), 'H5 不该打原生字段')
})

test('原生不可用 → native-unavailable（走 JS 兜底）', () => {
  const r = buildStepReport({ ...APP_OK, nativeAvailable: false })
  assert.equal(r.verdict, 'native-unavailable')
})

test('监听没注册 → not-registered（权限被收回/服务没起）', () => {
  const r = buildStepReport({ ...APP_OK, registered: false, cb: 0, ev: 0, today: 0 })
  assert.equal(r.verdict, 'not-registered')
})

test('注册了但一条事件都没收到 → no-events', () => {
  const r = buildStepReport({ ...APP_OK, cb: 0, ev: 0, today: 0, stored: 0 })
  assert.equal(r.verdict, 'no-events')
})

test('读数在涨但今日为 0 → zero-today（基线/解算问题，不是传感器）', () => {
  const r = buildStepReport({ ...APP_OK, today: 0, stored: 0, counter: 1234, det: 1200 })
  assert.equal(r.verdict, 'zero-today')
})

test('今日 0 但存档有值 → stale-store', () => {
  const r = buildStepReport({ ...APP_OK, today: 0, stored: 500 })
  assert.equal(r.verdict, 'stale-store')
})

test('原生归属日期与系统日期不一致 → date-drift（零点滚动失效）', () => {
  const r = buildStepReport({ ...APP_OK, date: '2026-11-19', sysDate: '2026-11-20' })
  assert.equal(r.verdict, 'date-drift')
})

test('日期漂移优先于「今日为 0」：今天的 0 是假 0', () => {
  const r = buildStepReport({ ...APP_OK, date: '2026-11-19', sysDate: '2026-11-20', today: 0, stored: 0, counter: 5000 })
  assert.equal(r.verdict, 'date-drift')
})

test('字段缺失不抛异常，未知值打成 ?（不能让自检自己崩）', () => {
  const r = buildStepReport({ platform: 'app', nativeAvailable: true })
  assert.equal(typeof r.line, 'string')
  assert.ok(r.line.includes('注册:?'), r.line)
  assert.ok(r.line.includes('今日:?'), r.line)
  assert.equal(r.verdict, 'unknown')
})

test('入参 undefined / 空对象不抛（真机上 getTodaySteps 可能还没好）', () => {
  assert.doesNotThrow(() => buildStepReport())
  assert.doesNotThrow(() => buildStepReport({}))
  assert.equal(buildStepReport({}).verdict, 'no-app')
})

test('每个结论码都有中文解释文案（避免界面显示裸码）', () => {
  const codes = ['ok', 'no-app', 'native-unavailable', 'not-registered', 'no-events', 'zero-today', 'stale-store', 'date-drift', 'unknown']
  for (const c of codes) {
    assert.ok(VERDICTS[c] && VERDICTS[c].length > 6, `缺少文案：${c}`)
  }
})

test('comp = -1（原生未就绪）不被当成"有读数"而误判 zero-today', () => {
  const r = buildStepReport({ ...APP_OK, today: 0, stored: 0, counter: 0, det: 0, comp: -1 })
  assert.equal(r.verdict, 'no-events', r.line)
})
