// dom.js 的单元测试。
//
// 为什么值得单独测：App 端（renderjs）本地根本跑不起来，H5 验证走的又是另一条代码
// 路径，所以「容器判定」这类只影响 App 的逻辑以前是零覆盖——正是这样才漏掉了
// `container: this.el || this.$el` 把包装对象喂给 MapLibre 的 bug，真机报
// "Invalid type: 'container' must be a String or HTMLElement."。
//
// 载入方式同 geo.test.mjs：包内没有 "type": "module"，用 data: URL 载入源码。
//
// 运行：npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

async function load(rel) {
  const src = readFileSync(
    fileURLToPath(new URL(`../src/components/map-view/${rel}`, import.meta.url)),
    'utf8'
  )
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { looksLikeElement, containerOk, describeValue } = await load('dom.js')

// 假元素：只要 nodeType === 1 就该被认
const fakeEl = { nodeType: 1, clientWidth: 300, clientHeight: 160, style: {} }
// 假「包装对象」：真机上 this.$el 就长这样——真值、但没有 nodeType
const wrapper = { $el: null, foo: 1 }

test('looksLikeElement：nodeType===1 的元素通过', () => {
  assert.equal(looksLikeElement(fakeEl), true)
})

test('looksLikeElement：有 getBoundingClientRect 也算元素', () => {
  assert.equal(looksLikeElement({ getBoundingClientRect: () => ({ width: 1, height: 1 }) }), true)
})

test('looksLikeElement：renderjs 的 $el 包装对象必须被拒', () => {
  assert.equal(looksLikeElement(wrapper), false, '包装对象真值但不是元素，绝不能当容器')
})

test('looksLikeElement：null / undefined / 原始值 全部被拒', () => {
  for (const v of [null, undefined, 0, 1, 'x', true]) {
    assert.equal(looksLikeElement(v), false, `${String(v)} 不该通过`)
  }
})

test('containerOk：合法选择器字符串通过', () => {
  assert.equal(containerOk('#mv-host-1'), true)
})

test('containerOk：空字符串被拒（MapLibre 会当无效选择器）', () => {
  assert.equal(containerOk(''), false)
})

test('containerOk：元素与包装对象的判定', () => {
  assert.equal(containerOk(fakeEl), true)
  assert.equal(containerOk(wrapper), false)
  assert.equal(containerOk(undefined), false)
})

test('describeValue：能把可疑值说清楚（用于真机诊断）', () => {
  assert.equal(describeValue(undefined), 'undefined')
  assert.equal(describeValue(null), 'null')
  assert.match(describeValue(wrapper), /^object:Object/, '包装对象应报成 object:Object')
  assert.match(describeValue(fakeEl), /nodeType=1/, '元素应带上 nodeType')
  assert.match(describeValue('abc'), /^string/)
})
