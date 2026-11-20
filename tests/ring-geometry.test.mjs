import test from 'node:test'
import assert from 'node:assert/strict'
import { ringGeometryOf, ringBand, ringGap, capCenters } from '../src/utils/ring-geometry.js'

test('ringGeometryOf：390px 屏 → band 17 / gap 14 / 三环半径 133-102-71', () => {
  const g = ringGeometryOf(270)
  assert.equal(g.band, Math.max(9, Math.round(270 * 0.062)))
  assert.equal(g.band, 17)
  assert.equal(g.gap, 14)
  assert.equal(g.rOuter, 133)
  assert.equal(g.rMid, 133 - 17 - 14)
  assert.equal(g.rInner, g.rMid - 17 - 14)
  assert.equal(g.cx, 135)
})

test('ringGeometryOf：小屏/大屏 band 不是常量（写死 17 会露馅）', () => {
  assert.equal(ringGeometryOf(355).band, 22 * 0 + Math.max(9, Math.round(355 * 0.062)))
  assert.notEqual(ringGeometryOf(355).band, 17)
  assert.equal(ringGeometryOf(248).band, 15)
})

test('ringGeometryOf：size 为 0/null 返回 null（未测量时不渲染）', () => {
  assert.equal(ringGeometryOf(0), null)
  assert.equal(ringGeometryOf(null), null)
  assert.equal(ringGeometryOf(undefined), null)
})

test('capCenters：ratio 0 与 >=99.9% 都不画（零进度不出绿点、满环不出疙瘩）', () => {
  const base = { r: 133, key: 'steps', band: 17, cx: 135, capD: 17 }
  assert.deepEqual(capCenters({ ...base, ratio: 0 }), [])
  assert.deepEqual(capCenters({ ...base, ratio: 1 }), [])
  assert.deepEqual(capCenters({ ...base, ratio: 0.999 }), [])
})

test('capCenters：62% 时两端圆心都落在环带中线上（R = r − band/2）', () => {
  const band = 17, r = 133, cx = 135
  const caps = capCenters({ r, ratio: 0.62, key: 'steps', band, cx, capD: band })
  assert.equal(caps.length, 2)
  const R = r - band / 2
  // 起点固定在 12 点方向
  assert.equal(caps[0].x, cx)
  assert.equal(caps[0].y, cx - R)
  // 终点：θ = -90 + 0.62*360 = 133.2°，到圆心距离必须等于 R
  const d = Math.hypot(caps[1].x - cx, caps[1].y - cx)
  assert.ok(Math.abs(d - R) < 1e-9, `终点半径 ${d} 应等于 ${R}`)
})

test('capCenters：ratio 极小时两端几乎重合（形成圆润起点，不是两个疙瘩）', () => {
  const caps = capCenters({ r: 133, ratio: 0.01, key: 'steps', band: 17, cx: 135, capD: 17 })
  assert.equal(caps.length, 2)
  assert.ok(Math.hypot(caps[1].x - caps[0].x, caps[1].y - caps[0].y) < 15)
})

test('ringBand/ringGap：最小 9px 兜底，间距随环带缩放', () => {
  assert.equal(ringBand(10), 9)
  assert.equal(ringGap(17), 14)
})
