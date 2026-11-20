import test from 'node:test'
import assert from 'node:assert/strict'
import { rankMirrors, pickBest, shouldSwitchMirror, buildAttemptOrder, saneBps, pickTopN, makeSpeedMeter, SLOW_BPS, SLOW_WINDOW_MS, SPEED_WINDOW_MS } from '../src/utils/mirror-pick.js'

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

// ===== makeSpeedMeter：增量窗口测速（P1-4 的回归） =====

test('makeSpeedMeter：稳定 1 MB/s 的下载，窗口速率应一直 ≈ 1 MB/s（不是线性虚高）', () => {
  // 每 100 ms 多下 100 KB（= 1 MB/s），跑 5 秒
  const m = makeSpeedMeter({ windowMs: 1000 })
  const step = 100 * 1024
  const target = 1024 * 1024
  let loaded = 0
  let t = 0
  const samples = []
  for (let i = 0; i < 50; i++) {
    t += 100
    loaded += step
    const s = m.push(loaded, t)
    if (i >= 10) samples.push(s.bps) // 跳过首个窗口
  }
  for (const bps of samples) {
    assert.ok(Math.abs(bps - target) < target * 0.05, 'bps 应稳定在 ~1MB/s，实际 ' + Math.round(bps))
  }
})

test('makeSpeedMeter：旧算法（累计当窗口）会虚高 —— 新算法在 30 秒后仍是真实速率', () => {
  // 同样 1 MB/s 跑 30 秒；旧写法会把"累计 30 MB / 1 秒"当成 30 MB/s
  const m = makeSpeedMeter({ windowMs: 1000 })
  const step = 100 * 1024
  let loaded = 0
  let t = 0
  let last = 0
  for (let i = 0; i < 300; i++) {
    t += 100
    loaded += step
    last = m.push(loaded, t).bps
  }
  const target = 1024 * 1024
  assert.ok(Math.abs(last - target) < target * 0.05, '30 秒后仍应是 ~1MB/s，实际 ' + Math.round(last))
  assert.ok(last < 2 * target, '不允许出现线性虚高')
})

test('makeSpeedMeter：首个完整窗口之前退回整体速率（调用方不会拿到 0 而误判"速度未知"）', () => {
  // 默认窗口 1500 ms：第二个事件距首帧 1000 ms，还没结算窗口
  const m = makeSpeedMeter()
  const s1 = m.push(64 * 1024, 1000)
  const s2 = m.push(128 * 1024, 2000)
  assert.equal(s1.windowBps, 0, '首帧没有时间流逝，windowBps 应为 0')
  assert.equal(s2.windowBps, 0, '还没到窗口终点')
  assert.ok(s2.bps > 0, 'windowBps 未结算时 bps 应退回整体速率，实际 ' + s2.bps)
})

test('makeSpeedMeter：累计值回退（换线重下）不产生负增量', () => {
  const m = makeSpeedMeter({ windowMs: 500 })
  m.push(1000 * 1024, 100)
  m.push(2000 * 1024, 600) // 一个完整窗口
  const s = m.push(10 * 1024, 700) // 重下：累计值变小
  assert.ok(Number.isFinite(s.bps) && s.bps >= 0, '不能出现 NaN/负速度，实际 ' + s.bps)
  assert.equal(s.loaded, 10 * 1024)
})

test('makeSpeedMeter：全 0 输入不炸（还没收到任何字节）', () => {
  const m = makeSpeedMeter()
  const s = m.push(0, 0)
  assert.equal(s.loaded, 0)
  assert.equal(s.bps, 0)
  const s2 = m.push(0, 1000)
  assert.equal(s2.bps, 0)
})

test('makeSpeedMeter：默认窗口是 SPEED_WINDOW_MS，可覆盖', () => {
  assert.equal(SPEED_WINDOW_MS, 1500)
  // 默认窗口 1500 ms：1300 ms 还没结算，2000 ms 才结算
  const m = makeSpeedMeter()
  m.push(1024 * 1024, 0)
  assert.equal(m.push(2 * 1024 * 1024, 1300).windowBps, 0)
  assert.ok(m.push(3 * 1024 * 1024, 1600).windowBps > 0)
})

test('makeSpeedMeter：窗口速率与 shouldSwitchMirror 串起来能识别掉速', () => {
  const m = makeSpeedMeter({ windowMs: 1000 })
  // 先跑 2 秒 1 MB/s，再掉到 30 KB/s 跑 3 秒
  let loaded = 0
  let t = 0
  for (let i = 0; i < 20; i++) {
    t += 100
    loaded += 100 * 1024
    m.push(loaded, t)
  }
  let s = null
  for (let i = 0; i < 30; i++) {
    t += 100
    loaded += 3 * 1024
    s = m.push(loaded, t)
  }
  assert.ok(s.bps < SLOW_BPS, '掉速后窗口速率应低于阈值，实际 ' + Math.round(s.bps))
  // 掉速判定还要过 6 秒观察窗口，这里直接给一个已过窗口的 elapsedMs
  assert.equal(
    shouldSwitchMirror({
      elapsedMs: SLOW_WINDOW_MS + 1000,
      bps: s.bps,
      loadedBytes: loaded,
      totalBytes: 0,
      hasNextMirror: true,
    }),
    true
  )
})