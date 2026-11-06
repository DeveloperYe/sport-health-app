import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPoint, accuracyOk, BREAK_GAP, MIN_MOVE, MAX_SPEED } from '../src/utils/track-filter.js'
import { trackGeoJSON, splitSegments, segmentCount } from '../src/utils/track-geo.js'

// 30.0 / 120.0 附近，1 度纬度 ≈ 111.32 km
const P = (lat, lng, ts, seg) => (seg === undefined ? { lat, lng, ts } : { lat, lng, ts, seg })

test('第一个点直接接受，不计距离', () => {
  const r = classifyPoint(null, P(30, 120, 1000))
  assert.equal(r.accept, true)
  assert.equal(r.distance, 0)
  assert.equal(r.reason, 'first')
})

test('静止抖动被丢弃（间隔短 + 位移 < 3m）', () => {
  const r = classifyPoint(P(30, 120, 1000), P(30.00001, 120, 2000)) // ~1.1m
  assert.equal(r.accept, false)
  assert.equal(r.reason, 'jitter')
})

test('正常移动被接受并按实际距离累加', () => {
  const r = classifyPoint(P(30, 120, 1000), P(30.0009, 120, 2000)) // ~100m / 1s = 100m/s？→ 应判跳点
  assert.equal(r.accept, false)
  const ok = classifyPoint(P(30, 120, 1000), P(30.00009, 120, 2000)) // ~10m / 1s = 10m/s ✓
  assert.equal(ok.accept, true)
  assert.ok(ok.distance > 8 && ok.distance < 12, 'd=' + ok.distance)
  assert.equal(ok.breakSeg, false)
})

test('跳点被拒绝（任意间隔用真实间隔算速度）', () => {
  // 500m / 10s = 50 m/s，远超上限
  const r = classifyPoint(P(30, 120, 1000), P(30.0045, 120, 11000))
  assert.equal(r.accept, false)
  assert.equal(r.reason, 'teleport')
})

test('★ 切后台 1 分钟回来：开新段（不连直线），但距离按直线估算计入——不能白跑', () => {
  const gap = 60000
  const last = P(30, 120, 1000)
  const back = P(30.003, 120, 1000 + gap) // 约 334m
  const r = classifyPoint(last, back)
  assert.equal(r.accept, true, '点不能丢（否则整段路起点丢了）')
  assert.equal(r.breakSeg, true, '必须开新段，否则会连出直线')
  assert.equal(r.estimated, true, '要标记为估算，UI 才能如实说明')
  assert.ok(r.distance > 300 && r.distance < 360, 'd=' + r.distance)
  assert.equal(r.reason, 'resume')
})

test('断档期间位移离谱（5km/40s）仍判跳点', () => {
  const r = classifyPoint(P(30, 120, 1000), P(30.045, 120, 41000)) // 约 5km / 40s = 125m/s
  assert.equal(r.accept, false)
  assert.equal(r.reason, 'teleport')
})

test('间隔 25 秒（> BREAK_GAP 20s）也开新段，距离照样算', () => {
  const r = classifyPoint(P(30, 120, 1000), P(30.0002, 120, 1000 + 25000))
  assert.equal(r.breakSeg, true)
  assert.equal(r.estimated, true)
  assert.ok(r.distance > 15 && r.distance < 30, 'd=' + r.distance)
})

test('间隔 5 秒的正常移动不开新段', () => {
  const r = classifyPoint(P(30, 120, 1000), P(30.00045, 120, 6000)) // ~50m/5s = 10m/s
  assert.equal(r.accept, true)
  assert.equal(r.breakSeg, false)
  assert.ok(r.distance > 40)
})

test('accuracyOk：>50m 判差，0/未给放行', () => {
  assert.equal(accuracyOk(80), false)
  assert.equal(accuracyOk(10), true)
  assert.equal(accuracyOk(0), true)
  assert.equal(accuracyOk(undefined), true)
})

test('trackGeoJSON：同段 → LineString，起终点齐备', () => {
  const pts = [P(30, 120, 1, 0), P(30.0001, 120, 2, 0), P(30.0002, 120, 3, 0)]
  const gj = trackGeoJSON(pts)
  const line = gj.features.find((f) => f.properties.kind === 'line')
  assert.equal(line.geometry.type, 'LineString')
  assert.equal(line.geometry.coordinates.length, 3)
  assert.ok(gj.features.some((f) => f.properties.kind === 'start'))
  assert.ok(gj.features.some((f) => f.properties.kind === 'end'))
})

test('★ 有中断 → MultiLineString，两段不共用点（无法连直线）', () => {
  const pts = [
    P(30, 120, 1, 0), P(30.0001, 120, 2, 0),
    P(31, 121, 999999, 1), P(31.0001, 121, 999999.5, 1),
  ]
  const gj = trackGeoJSON(pts)
  const line = gj.features.find((f) => f.properties.kind === 'line')
  assert.equal(line.geometry.type, 'MultiLineString')
  assert.equal(line.geometry.coordinates.length, 2)
  assert.equal(line.geometry.coordinates[0].length, 2)
  assert.equal(line.geometry.coordinates[1].length, 2)
  assert.equal(segmentCount(pts), 2)
})

test('断档会额外产出 kind=gap 的虚线连接段', () => {
  const pts = [P(30, 120, 1, 0), P(30.0001, 120, 2, 0), P(31, 121, 999999, 1), P(31.0001, 121, 1000000, 1)]
  const gj = trackGeoJSON(pts)
  const gaps = gj.features.filter((f) => f.properties.kind === 'gap')
  assert.equal(gaps.length, 1, '两个段之间应有 1 条连接线')
  assert.equal(gaps[0].geometry.type, 'LineString')
  assert.equal(gaps[0].geometry.coordinates.length, 2)
})

test('无断档时不产出 gap 连接段', () => {
  const pts = [P(30, 120, 1, 0), P(30.0001, 120, 2, 0)]
  assert.equal(trackGeoJSON(pts).features.filter((f) => f.properties.kind === 'gap').length, 0)
})

test('只有单点的段不画线（避免出现零长线段）', () => {
  const pts = [P(30, 120, 1, 0), P(31, 121, 2, 1), P(31.0001, 121, 3, 1)]
  const segs = splitSegments(pts)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].length, 1)
  const gj = trackGeoJSON(pts)
  const line = gj.features.find((f) => f.properties.kind === 'line')
  assert.equal(line.geometry.type, 'LineString', '只有一段有效，退化成单线')
})

test('空/异常输入不炸', () => {
  assert.deepEqual(trackGeoJSON([]).features, [])
  assert.equal(segmentCount(null), 0)
  assert.deepEqual(splitSegments(undefined), [])
  assert.equal(classifyPoint(null, { lat: NaN, lng: 1, ts: 1 }).accept, true)
})
