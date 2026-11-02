import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Sha256, sha256Hex } from '../src/utils/sha256.js'

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'))
const nodeHash = (u8) => createHash('sha256').update(Buffer.from(u8)).digest('hex')

test('已知向量：空串', () => {
  assert.equal(sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('已知向量：abc', () => {
  assert.equal(sha256Hex(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('已知向量：448 位边界（56 字节触发两轮补块）', () => {
  const s = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'
  assert.equal(sha256Hex(enc(s)), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
})

test('已知向量：100 万个 a', () => {
  const u8 = new Uint8Array(1000000).fill(0x61)
  assert.equal(sha256Hex(u8), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
})

test('分块喂数据 == 一次性喂（覆盖跨块边界）', () => {
  const data = new Uint8Array(5000)
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff
  const once = sha256Hex(data)
  // 各种块长都要和一次性一致（含 1、63、64、65 这些边界）
  for (const chunk of [1, 7, 63, 64, 65, 127, 512]) {
    const h = new Sha256()
    for (let i = 0; i < data.length; i += chunk) h.update(data.subarray(i, Math.min(i + chunk, data.length)))
    assert.equal(h.digest(), once, 'chunk=' + chunk)
  }
  assert.equal(once, nodeHash(data))
})

test('随机数据 20 组与 node:crypto 一致', () => {
  for (let n = 0; n < 20; n++) {
    const len = Math.floor(Math.random() * 9000)
    const data = new Uint8Array(len)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 256) | 0
    assert.equal(sha256Hex(data), nodeHash(data), 'len=' + len)
  }
})

test('空 update 不影响结果', () => {
  const h = new Sha256()
  h.update(new Uint8Array(0))
  h.update(enc('abc'))
  h.update(new Uint8Array(0))
  assert.equal(h.digest(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('digest 之后不能再 update / 再 digest', () => {
  const h = new Sha256().update(enc('x'))
  h.digest()
  assert.throws(() => h.update(enc('y')))
  assert.throws(() => h.digest())
})
