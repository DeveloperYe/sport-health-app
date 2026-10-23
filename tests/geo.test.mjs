// geo.js 的单元测试：轨迹几何是距离/配速的地基，错了不会报错、只会静默算偏。
//
// 本包 package.json 没有 "type": "module"，所以 src/utils/*.js 在 node 里会按 CJS
// 解析、直接 import 会语法报错。这里用 data: URL 载入源码——既不用引入构建工具，
// 也不用改包类型（改 "type" 会影响 uni-app 工具链，不值得）。
//
// 运行：npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

async function load(rel) {
  const src = readFileSync(fileURLToPath(new URL(`../src/utils/${rel}`, import.meta.url)), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { haversine, trackDistance, project, simplify, bounds, formatDistance, formatPace, formatDuration } =
  await load('geo.js')

// 天安门附近取两点，纬度差 0.01°（实测约 1112 米）
const A = { lat: 39.9087, lng: 116.3975 }
const B = { lat: 39.9187, lng: 116.3975 }

test('haversine：0.01° 纬度约 1112 米', () => {
  assert.ok(Math.abs(haversine(A, B) - 1112) < 3, `实际 ${haversine(A, B)}`)
})

test('haversine：同点距离为 0', () => {
  assert.equal(haversine(A, A), 0)
})

test('haversine：交换两点结果一致', () => {
  assert.equal(haversine(A, B), haversine(B, A))
})

test('trackDistance：约 100m 正方形的周长约 400m', () => {
  const sq = [
    { lat: 39.9, lng: 116.4 },
    { lat: 39.9, lng: 116.40117 },
    { lat: 39.9009, lng: 116.40117 },
    { lat: 39.9009, lng: 116.4 },
  ]
  const per = trackDistance([...sq, sq[0]])
  assert.ok(Math.abs(per - 400) < 4, `实际 ${per}`)
})

test('trackDistance：空/单点轨迹为 0', () => {
  assert.equal(trackDistance([]), 0)
  assert.equal(trackDistance([A]), 0)
})

test('bounds：空轨迹返回 null', () => {
  assert.equal(bounds([]), null)
})

test('project：正方形投影后像素边长近似相等（不因纬度拉伸）', () => {
  const sq = [
    { lat: 39.9, lng: 116.4 },
    { lat: 39.9, lng: 116.40117 },
    { lat: 39.9009, lng: 116.40117 },
    { lat: 39.9009, lng: 116.4 },
  ]
  const pr = project(sq, 300, 200, 20)
  const xs = pr.points.map((p) => p.x)
  const ys = pr.points.map((p) => p.y)
  const dx = Math.max(...xs) - Math.min(...xs)
  const dy = Math.max(...ys) - Math.min(...ys)
  assert.ok(Math.abs(dx - dy) < 2, `dx=${dx} dy=${dy}`)
  // 像素全部落在画布内（padding 之内）
  for (const p of pr.points) {
    assert.ok(p.x >= 0 && p.x <= 300 && p.y >= 0 && p.y <= 200, `越界 ${p.x},${p.y}`)
  }
})

test('project：北在上（纬度越大 y 越小）', () => {
  const pr = project([A, B], 300, 200, 20)
  assert.ok(pr.points[1].y < pr.points[0].y)
})

test('project：单点轨迹不会把比例尺算成无穷大', () => {
  const pr = project([A], 300, 200, 20)
  assert.ok(Number.isFinite(pr.pxPerMeter))
  assert.ok(pr.pxPerMeter > 0)
})

test('simplify：共线点只留首尾', () => {
  const line = Array.from({ length: 100 }, (_, i) => ({ lat: 39.9 + i * 0.0001, lng: 116.4 }))
  assert.equal(simplify(line, 5).length, 2)
})

test('simplify：拐点会保留', () => {
  const pts = [
    { lat: 39.9, lng: 116.4 },
    { lat: 39.905, lng: 116.4 },
    { lat: 39.905, lng: 116.405 }, // 直角拐点
    { lat: 39.9, lng: 116.405 },
  ]
  assert.equal(simplify(pts, 5).length, 4)
})

test('simplify：点数 <= 2 时原样返回', () => {
  assert.equal(simplify([A], 5).length, 1)
  assert.equal(simplify([A, B], 5).length, 2)
})

test('formatDistance：米/公里切换', () => {
  assert.equal(formatDistance(456), '456 米')
  assert.equal(formatDistance(999), '999 米')
  assert.equal(formatDistance(1000), '1.00 公里')
  assert.equal(formatDistance(1234), '1.23 公里')
})

test('formatPace：距离过短不硬算配速', () => {
  assert.equal(formatPace(300, 5), '--')
  assert.equal(formatPace(0, 1000), '--')
  assert.equal(formatPace(300, 1000), `5'00"`)
  assert.equal(formatPace(390, 1000), `6'30"`)
})

test('formatDuration：分秒 / 时分秒', () => {
  assert.equal(formatDuration(754), '12:34')
  assert.equal(formatDuration(3723), '1:02:03')
  assert.equal(formatDuration(0), '00:00')
  assert.equal(formatDuration(-5), '00:00')
})
