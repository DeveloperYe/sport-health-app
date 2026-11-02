import test from 'node:test'
import assert from 'node:assert/strict'
import { rankMirrors, pickBest, shouldSwitchMirror, buildAttemptOrder, SLOW_BPS, SLOW_WINDOW_MS } from '../src/utils/mirror-pick.js'

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
