import test from 'node:test'
import assert from 'node:assert/strict'
import { rankMirrors, pickBest, shouldSwitchMirror, buildAttemptOrder, saneBps, pickTopN, SLOW_BPS, SLOW_WINDOW_MS } from '../src/utils/mirror-pick.js'

test('rankMirrors：按速度降序，剔掉失败的', () => {
  const probes = [
    { prefix: 'a', bps: 100 },
    { prefix: 'b', bps: 900 },
    { prefix: 'c', bps: 0 },
    { prefix: 'd', bps: 500, ok: false },
    { prefix: 'e', bps: 300 },
  ]
  assert.deepEqual(
    rankMirrors(probes).map((p) => p.prefix),
    ['b', 'e', 'a']
  )
})

test('pickBest：全失败给 null', () => {
  assert.equal(pickBest([{ prefix: 'a', bps: 0 }, { prefix: 'b', bps: 0 }]), null)
  assert.equal(pickBest([]), null)
  assert.equal(pickBest(null), null)
  assert.equal(pickBest([{ prefix: 'x', bps: 12 }]).prefix, 'x')
})

test('buildAttemptOrder：测通的在前，没测通的按原顺序垫后', () => {
  const order = buildAttemptOrder(
    [{ prefix: 'slow', bps: 10 }, { prefix: 'fast', bps: 900 }],
    ['v6', 'slow', 'fast', 'direct']
  )
  assert.deepEqual(order, ['fast', 'slow', 'v6', 'direct'])
})

test('shouldSwitchMirror：刚起步不换（未到观察窗口）', () => {
  assert.equal(
    shouldSwitchMirror({ elapsedMs: 2000, bps: 1000, loadedBytes: 10000, totalBytes: 1000000, hasNextMirror: true }),
    false
  )
})

test('shouldSwitchMirror：过了窗口且明显慢 -> 换', () => {
  assert.equal(
    shouldSwitchMirror({ elapsedMs: SLOW_WINDOW_MS + 1, bps: SLOW_BPS - 1, loadedBytes: 100000, totalBytes: 1000000, hasNextMirror: true }),
    true
  )
})

test('shouldSwitchMirror：速度正常不换', () => {
  assert.equal(
    shouldSwitchMirror({ elapsedMs: 20000, bps: SLOW_BPS * 3, loadedBytes: 100000, totalBytes: 1000000, hasNextMirror: true }),
    false
  )
})

test('shouldSwitchMirror：没有后备线路就不折腾', () => {
  assert.equal(
    shouldSwitchMirror({ elapsedMs: 60000, bps: 1000, loadedBytes: 1000, totalBytes: 1000000, hasNextMirror: false }),
    false
  )
})

test('shouldSwitchMirror：速度还未知（0）时不换', () => {
  assert.equal(
    shouldSwitchMirror({ elapsedMs: 60000, bps: 0, loadedBytes: 1000, totalBytes: 1000000, hasNextMirror: true }),
    false
  )
})

test('shouldSwitchMirror：已经下了 90% 以上就别换（重下更亏）', () => {
  assert.equal(
    shouldSwitchMirror({ elapsedMs: 60000, bps: 1000, loadedBytes: 950000, totalBytes: 1000000, hasNextMirror: true }),
    false
  )
})

test('shouldSwitchMirror：阈值/窗口可覆盖', () => {
  const base = { elapsedMs: 3000, bps: 50000, loadedBytes: 1000, totalBytes: 1000000, hasNextMirror: true }
  assert.equal(shouldSwitchMirror(base), false)
  assert.equal(shouldSwitchMirror({ ...base, windowMs: 1000, slowBps: 100000 }), true)
})

test('shouldSwitchMirror：totalBytes 未知（0）也能判', () => {
  assert.equal(
    shouldSwitchMirror({ elapsedMs: 10000, bps: 1024, loadedBytes: 5000, totalBytes: 0, hasNextMirror: true }),
    true
  )
})

test('saneBps：正常速度原样返回', () => {
  assert.equal(saneBps(2 * 1024 * 1024, 512 * 1024, 250), 2 * 1024 * 1024)
})

test('saneBps：0/负数/NaN 一律归零', () => {
  assert.equal(saneBps(0, 100, 10), 0)
  assert.equal(saneBps(-5, 100, 10), 0)
  assert.equal(saneBps(NaN, 100, 10), 0)
})

test('saneBps：离谱速度被钳回可信值（防"没进度事件→耗时1ms→几百MB/s"）', () => {
  // 512 KB 在 1 ms 内"完成" = 512 MB/s，显然假象；应按最小可信耗时 50 ms 重算
  const v = saneBps(512 * 1024 * 1000, 512 * 1024, 1)
  assert.ok(v <= 80 * 1024 * 1024, 'v=' + v)
  assert.ok(v > 0)
})

test('saneBps：连 got 都没有时退回上限而不是 0', () => {
  assert.equal(saneBps(999 * 1024 * 1024, 0, 0), 80 * 1024 * 1024)
})

test('saneBps：可传自定义上限（上限内原样，超了就按 got/ms 重算）', () => {
  // 未超自定义上限 → 原样返回
  assert.equal(saneBps(500 * 1024, 1024, 2, 1024 * 1024), 500 * 1024)
  // 超过上限 → 按 got/ms 重算，结果必然小于原值
  const v = saneBps(50 * 1024 * 1024, 1024, 1, 1024 * 1024)
  assert.ok(v < 50 * 1024 * 1024, 'v=' + v)
  assert.ok(v > 0, 'v=' + v)
})

test('pickTopN：按速度取前 N 名且不改原数组', () => {
  const list = [
    { prefix: 'a', bps: 100 },
    { prefix: 'b', bps: 900 },
    { prefix: 'c', bps: 500 },
  ]
  const top = pickTopN(list, 2)
  assert.deepEqual(top.map((x) => x.prefix), ['b', 'c'])
  assert.equal(list[0].prefix, 'a', '原数组顺序不应被改动')
})

test('pickTopN：不足 N 个就全给，空数组给空', () => {
  assert.equal(pickTopN([{ bps: 1 }], 2).length, 1)
  assert.deepEqual(pickTopN([], 2), [])
  assert.deepEqual(pickTopN(null, 2), [])
})

test('pickTopN：bps 缺失/非法按 0 处理，不炸', () => {
  const top = pickTopN([{ prefix: 'x' }, { prefix: 'y', bps: 10 }], 2)
  assert.equal(top[0].prefix, 'y')
})