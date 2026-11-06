import test from 'node:test'
import assert from 'node:assert/strict'
import { toBytes, looksPmtiles, getReadStrategy, resetStrategy } from '../src/utils/native-file.js'

test('toBytes：Uint8Array 原样返回', () => {
  const u8 = new Uint8Array([1, 2, 3])
  assert.equal(toBytes(u8).length, 3)
})

test('toBytes：base64 字符串解码', () => {
  const u8 = toBytes(Buffer.from('hello').toString('base64'))
  assert.equal(String.fromCharCode.apply(null, Array.from(u8)), 'hello')
})

test('toBytes：dataURL 形式（带前缀）也能解', () => {
  const u8 = toBytes('data:application/octet-stream;base64,' + Buffer.from('PMTiles').toString('base64'))
  assert.equal(String.fromCharCode.apply(null, Array.from(u8)), 'PMTiles')
})

test('toBytes：空/null 返回 null', () => {
  assert.equal(toBytes(null), null)
  assert.equal(toBytes(''), null)
  assert.equal(toBytes(undefined), null)
})

test('toBytes：非法 base64 返回 null 而不是抛错', () => {
  assert.equal(toBytes('!!!not-base64!!!'), null)
})

test('looksPmtiles：认魔数、不认垃圾', () => {
  const ok = new Uint8Array(16)
  const m = 'PMTiles'
  for (let i = 0; i < 7; i++) ok[i] = m.charCodeAt(i)
  assert.equal(looksPmtiles(ok), true)
  assert.equal(looksPmtiles(new Uint8Array(16).fill(0x3c)), false)
  assert.equal(looksPmtiles(new Uint8Array(8)), false)
})

test('读取策略初始为空，可重置', () => {
  resetStrategy()
  assert.equal(getReadStrategy(), '')
})
