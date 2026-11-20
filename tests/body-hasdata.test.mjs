import test from 'node:test'
import assert from 'node:assert/strict'

// body-store 依赖 uni 全局：用最小桩模拟"存储里有什么"
function stubUni(map) {
  globalThis.uni = {
    getStorageSync: (k) => (k in map ? map[k] : ''),
    setStorageSync: (k, v) => {
      map[k] = v
    },
  }
  return map
}

const { hasBodyData } = await import('../src/utils/body-store.js')

test('hasBodyData：全新设备上为 false（不能因为 getBody 有兜底默认值就判成已填）', () => {
  stubUni({})
  assert.equal(hasBodyData(), false)
})

test('hasBodyData：填了体重就算填过', () => {
  stubUni({ fh_weight: '75' })
  assert.equal(hasBodyData(), true)
})

test('hasBodyData：只填了身高/年龄也算', () => {
  stubUni({ fh_height: '175' })
  assert.equal(hasBodyData(), true)
  stubUni({ fh_age: '28' })
  assert.equal(hasBodyData(), true)
})

test('hasBodyData：只有活动量（fh_body 非空）也算', () => {
  stubUni({ fh_body: { activity: 'medium' } })
  assert.equal(hasBodyData(), true)
})

test('hasBodyData：空对象/空数组/0/空串一律不算', () => {
  stubUni({ fh_body: {}, fh_weight_log: [], fh_weight: '0', fh_height: '', fh_age: 'abc' })
  assert.equal(hasBodyData(), false)
})

test('hasBodyData：有体重日志也算（老用户可能只在日志里留下过体重）', () => {
  stubUni({ fh_weight_log: [{ d: '2026-11-20', w: 75 }] })
  assert.equal(hasBodyData(), true)
})

test('hasBodyData：存储读抛异常时返回 false，不崩', () => {
  globalThis.uni = { getStorageSync: () => { throw new Error('boom') }, setStorageSync: () => {} }
  assert.equal(hasBodyData(), false)
})
