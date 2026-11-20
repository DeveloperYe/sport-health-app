// map-view.vue 的跨层约束（真机专属坑，H5 完全看不出来）。
//
// 背景（都是真机实测踩到的，H5 一切正常）：
//   ① renderjs（视图层）与逻辑层是**两个不同的组件实例**，逻辑层的 methods 在视图层不存在。
//      `build()` 末尾调 `this.startStatusTimer()` → 真机报
//      "this.startStatusTimer is not a function @Proxy.build" → 整张底图退回自绘轨迹图。
//   ② 写「未在 data() 里声明」的实例字段可能被静默丢弃，紧接着的 `this.X[k] = …`
//      就成了给 undefined 赋属性 → "Cannot set properties of undefined"。
//
// 这两类问题编译期不报错、H5 也不复现，只能靠静态扫描钉住，所以放进单测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FILE = fileURLToPath(new URL('../src/components/map-view/map-view.vue', import.meta.url))
const SRC = readFileSync(FILE, 'utf8')

/** 剥掉注释，避免把注释里的示例代码当成真代码 */
function strip(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

function blocks() {
  return [...SRC.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({
    attrs: m[1].trim(),
    code: strip(m[2]),
  }))
}

/** 收集一个 script 块里声明过的东西 */
function decls(code) {
  const dataKeys = new Set()
  const dm = /data\(\)\s*\{\s*return\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}/.exec(code)
  if (dm) for (const k of dm[1].matchAll(/^\s{6,8}([A-Za-z_$][\w$]*)\s*:/gm)) dataKeys.add(k[1])
  const propKeys = new Set()
  const pm = /props\s*:\s*\{([\s\S]*?)\n\s{2}\}/.exec(code)
  if (pm) for (const k of pm[1].matchAll(/^\s+([A-Za-z_$][\w$]*)\s*:/gm)) propKeys.add(k[1])
  const methodKeys = new Set()
  const mm = /methods\s*:\s*\{([\s\S]*)$/.exec(code)
  if (mm) for (const k of mm[1].matchAll(/^\s{4,6}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) methodKeys.add(k[1])
  const compKeys = new Set()
  const cm = /\n  computed:\s*\{([\s\S]*?)\n  \},/.exec(code)
  if (cm) for (const k of cm[1].matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*\(/gm)) compKeys.add(k[1])
  const funcKeys = new Set()
  for (const k of code.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) funcKeys.add(k[1])
  for (const k of code.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/gm)) funcKeys.add(k[1])
  return { dataKeys, propKeys, methodKeys, compKeys, funcKeys }
}

const RUNTIME_OK = new Set(['$el', '$emit', '$nextTick', '$refs', '$ownerInstance', '$options', '$forceUpdate', '$set'])

test('renderjs 块里所有 this.X() 调用都必须在**本块内**有定义（跨层调用会让底图整张退回）', () => {
  const b = blocks().find((x) => /lang="renderjs"/.test(x.attrs))
  assert.ok(b, '没找到 renderjs 块')
  const d = decls(b.code)
  const allowed = new Set([
    ...d.dataKeys,
    ...d.propKeys,
    ...d.methodKeys,
    ...d.compKeys,
    ...d.funcKeys,
    ...RUNTIME_OK,
  ])
  const missing = []
  for (const m of b.code.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const k = m[1]
    if (k.startsWith('$')) continue
    if (allowed.has(k)) continue
    if (missing.indexOf(k) < 0) missing.push(k)
  }
  assert.deepEqual(missing, [], 'renderjs 里调用了逻辑层的方法（真机必炸）: ' + missing.join(', '))
})

test('renderjs 自带状态轮询方法（本次真机崩溃的回归钉）', () => {
  const b = blocks().find((x) => /lang="renderjs"/.test(x.attrs))
  const d = decls(b.code)
  assert.ok(d.methodKeys.has('startStatusTimer'), 'renderjs 缺 startStatusTimer')
  assert.ok(d.methodKeys.has('stopStatusTimer'), 'renderjs 缺 stopStatusTimer')
  assert.ok(d.methodKeys.has('pushStatus'), 'renderjs 缺 pushStatus')
  // 调用点也必须在（build/onSync/onVisible 都会调）
  assert.match(b.code, /this\.startStatusTimer\(\)/)
})

test('renderjs 块里不许给 data() 未声明的实例字段赋值（真机会被静默丢弃）', () => {
  const b = blocks().find((x) => /lang="renderjs"/.test(x.attrs))
  const d = decls(b.code)
  const allowed = new Set([...d.dataKeys, ...d.propKeys, ...d.methodKeys, ...d.compKeys])
  const bad = []
  for (const m of b.code.matchAll(/this\.([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\])?\s*=(?!=)/g)) {
    const k = m[1]
    if (k.startsWith('$')) continue
    if (allowed.has(k)) continue
    if (bad.indexOf(k) < 0) bad.push(k)
  }
  assert.deepEqual(bad, [], 'renderjs 里给未声明字段赋值: ' + bad.join(', '))
})

test('逻辑层同样不许给未声明字段赋值', () => {
  const b = blocks().find((x) => !/lang="renderjs"/.test(x.attrs) && x.code.indexOf('export default') >= 0)
  assert.ok(b, '没找到逻辑层 script 块')
  const d = decls(b.code)
  const allowed = new Set([...d.dataKeys, ...d.propKeys, ...d.methodKeys, ...d.compKeys])
  const bad = []
  for (const m of b.code.matchAll(/this\.([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\])?\s*=(?!=)/g)) {
    const k = m[1]
    if (k.startsWith('$')) continue
    if (allowed.has(k)) continue
    if (bad.indexOf(k) < 0) bad.push(k)
  }
  assert.deepEqual(bad, [], '逻辑层里给未声明字段赋值: ' + bad.join(', '))
})

test('跨层可选调用必须带能力探测（typeof this.X === \'function\'）', () => {
  // 逻辑层在 H5 会调 watchThemeClass（只在 renderjs 定义）：必须 typeof 守卫
  const logic = blocks().find((x) => !/lang="renderjs"/.test(x.attrs) && x.code.indexOf('export default') >= 0)
  assert.match(logic.code, /typeof this\.watchThemeClass === 'function'/)
})
