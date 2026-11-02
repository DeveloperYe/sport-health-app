import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePmtilesHeader, checkPmtilesStructure, magicOk } from '../src/utils/pmtiles-check.js'

/** 造一个合法的 PMTiles v3 头部（127 字节） */
function makeHeader(opt) {
  const o = opt || {}
  const total = o.fileSize || 1000
  const u8 = new Uint8Array(127)
  const magic = 'PMTiles'
  for (let i = 0; i < 7; i++) u8[i] = magic.charCodeAt(i)
  u8[7] = o.version === undefined ? 3 : o.version
  const put64 = (off, v) => {
    let x = BigInt(v)
    for (let i = 0; i < 8; i++) {
      u8[off + i] = Number(x & 0xffn)
      x >>= 8n
    }
  }
  const tileDataOffset = o.tileDataOffset === undefined ? 200 : o.tileDataOffset
  const tileDataLength = o.tileDataLength === undefined ? total - tileDataOffset : o.tileDataLength
  put64(8, 127) // rootOffset
  put64(16, o.rootLength === undefined ? 58 : o.rootLength)
  put64(24, 185)
  put64(32, 100)
  put64(40, 1364)
  put64(48, 500)
  put64(56, tileDataOffset)
  put64(64, tileDataLength)
  put64(72, o.numAddressedTiles === undefined ? 5000 : o.numAddressedTiles)
  put64(80, 3000)
  put64(88, 2500)
  u8[100] = 0
  u8[101] = 15
  return u8
}

test('magicOk：认 PMTiles，不认 HTML 错误页', () => {
  assert.equal(magicOk(makeHeader()), true)
  const html = new Uint8Array(64)
  for (let i = 0; i < 64; i++) html[i] = '<'.charCodeAt(0)
  assert.equal(magicOk(html), false)
  assert.equal(magicOk(new Uint8Array(8)), false)
})

test('parsePmtilesHeader：字段按小端 u64 读出', () => {
  const h = parsePmtilesHeader(makeHeader({ fileSize: 5000, tileDataOffset: 600 }))
  assert.equal(h.version, 3)
  assert.equal(h.rootOffset, 127)
  assert.equal(h.rootLength, 58)
  assert.equal(h.tileDataOffset, 600)
  assert.equal(h.tileDataLength, 4400)
  assert.equal(h.numAddressedTiles, 5000)
  assert.equal(h.maxZoom, 15)
})

test('checkPmtilesStructure：合法包通过', () => {
  const size = 5000
  const r = checkPmtilesStructure(makeHeader({ fileSize: size }), size, size)
  assert.equal(r.ok, true)
  assert.equal(r.header.numAddressedTiles, 5000)
})

test('checkPmtilesStructure：截断文件被识破（瓦片数据末尾 ≠ 文件长度）', () => {
  const real = 5000
  const head = makeHeader({ fileSize: real })
  // 实际只下到 4000 字节
  const r = checkPmtilesStructure(head, 4000)
  assert.equal(r.ok, false)
  assert.match(r.reason, /越界|≠ 文件长度/)
})

test('checkPmtilesStructure：多出内容（补零）也被识破', () => {
  const real = 5000
  const head = makeHeader({ fileSize: real })
  const r = checkPmtilesStructure(head, 6000)
  assert.equal(r.ok, false)
  assert.match(r.reason, /≠ 文件长度/)
})

test('checkPmtilesStructure：清单字节数不符直接拒', () => {
  const size = 5000
  const r = checkPmtilesStructure(makeHeader({ fileSize: size }), size, 4999)
  assert.equal(r.ok, false)
  assert.match(r.reason, /字节数不符/)
})

test('checkPmtilesStructure：非 PMTiles（HTML 页）被拒', () => {
  const junk = new Uint8Array(127).fill(0x3c)
  const r = checkPmtilesStructure(junk, 127)
  assert.equal(r.ok, false)
  assert.match(r.reason, /不是 PMTiles/)
})

test('checkPmtilesStructure：版本不是 3 被拒', () => {
  const size = 5000
  const r = checkPmtilesStructure(makeHeader({ fileSize: size, version: 2 }), size)
  assert.equal(r.ok, false)
  assert.match(r.reason, /版本/)
})

test('checkPmtilesStructure：瓦片数为 0 的空包被拒', () => {
  const size = 5000
  const r = checkPmtilesStructure(makeHeader({ fileSize: size, numAddressedTiles: 0 }), size)
  assert.equal(r.ok, false)
  assert.match(r.reason, /瓦片数为 0/)
})

test('真实青岛包：能解析且结构自洽（回归真实文件）', () => {
  let buf
  try {
    buf = readFileSync('src/static/tiles/qingdao-all.pmtiles')
  } catch (e) {
    return // CI 上 pmtiles 是 gitignore 的，拿不到就跳过
  }
  const head = buf.subarray(0, 127)
  const r = checkPmtilesStructure(head, buf.length, buf.length)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.header.version, 3)
  assert.ok(r.header.numAddressedTiles > 0)
  assert.equal(r.header.tileDataOffset + r.header.tileDataLength, buf.length)
})
