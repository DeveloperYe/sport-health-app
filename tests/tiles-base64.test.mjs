import test from 'node:test'
import assert from 'node:assert/strict'
import { isPmtilesBase64, base64ToBytes } from '../src/components/map-view/tiles.js'

test('isPmtilesBase64：认 PMTiles 的 base64', () => {
  const b64 = Buffer.from('PMTiles' + '\0'.repeat(200)).toString('base64')
  assert.equal(isPmtilesBase64(b64), true)
})

test('isPmtilesBase64：全 0 数据（Native 分块的假成功）必须判 false', () => {
  const zeros = Buffer.alloc(256, 0).toString('base64')
  assert.equal(isPmtilesBase64(zeros), false)
})

test('isPmtilesBase64：HTML 错误页判 false', () => {
  const html = Buffer.from('<html><body>404 Not Found</body></html>').toString('base64')
  assert.equal(isPmtilesBase64(html), false)
})

test('isPmtilesBase64：太短/非字符串一律 false', () => {
  assert.equal(isPmtilesBase64(''), false)
  assert.equal(isPmtilesBase64('UE1U'), false)
  assert.equal(isPmtilesBase64(null), false)
  assert.equal(isPmtilesBase64(undefined), false)
})

test('base64ToBytes：往返一致', () => {
  const raw = Buffer.from('PMTiles-hello')
  const u8 = base64ToBytes(raw.toString('base64'))
  assert.equal(Buffer.from(u8).toString(), 'PMTiles-hello')
})
