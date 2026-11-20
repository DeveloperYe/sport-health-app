import test from 'node:test'
import assert from 'node:assert/strict'

function stubUni(map) {
  globalThis.uni = {
    getStorageSync: (k) => (k in map ? map[k] : ''),
    setStorageSync: (k, v) => { map[k] = v },
  }
}
const { hasWeight } = await import('../src/utils/body-store.js')

test('hasWeight：什么都没填 → false（不能用 60kg 兜底值判成已填）', () => {
  stubUni({})
  assert.equal(hasWeight(), false)
})

test('hasWeight：只填身高/年龄 → false（体重仍是默认值，提示应当继续出现）', () => {
  stubUni({ fh_height: '175', fh_age: '28' })
  assert.equal(hasWeight(), false)
})

test('hasWeight：fh_weight 有值 → true（覆盖老版本只写 fh_weight 的盲区）', () => {
  stubUni({ fh_weight: '75' })
  assert.equal(hasWeight(), true)
})

test('hasWeight：只有体重日志 → true', () => {
  stubUni({ fh_weight_log: [{ d: '2026-11-20', w: 75 }] })
  assert.equal(hasWeight(), true)
})

test('hasWeight：日志里全是 0 或脏数据 → false', () => {
  stubUni({ fh_weight_log: [{ d: '2026-11-20', w: 0 }, { d: 'x' }] })
  assert.equal(hasWeight(), false)
})

test('hasWeight：存储抛异常不崩', () => {
  globalThis.uni = { getStorageSync: () => { throw new Error('boom') }, setStorageSync: () => {} }
  assert.equal(hasWeight(), false)
})
