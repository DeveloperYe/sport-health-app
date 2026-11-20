// P0-2 的回归单测：切城市时必须能回收 Protocol 注册表里的条目。
//
// 背景：pmtiles 4.5.0 的 Protocol 只有 add()/get()、没有 remove()，
// 而 map-core.js 的 Protocol 是模块级单例 —— 不直删它的 Map，
// 每换一个城市就多留一份整包 Uint8Array（青岛 22 MB / 重庆 198 MB）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keysToEvict, evictProtocolEntries } from '../src/components/map-view/protocol-registry.js'

// 假实例：只要有对象身份就够，回头拿 indexOf 比引用
const inst = (name) => ({ name })

/** 造一个和 pmtiles Protocol 同形的假对象（this.tiles 是 Map） */
function fakeProtocol(entries) {
  const tiles = new Map()
  Object.entries(entries || {}).forEach(([k, v]) => tiles.set(k, v))
  return { tiles, add(i) { tiles.set(i.name, i) }, get(k) { return tiles.get(k) } }
}

test('keysToEvict：注册表里仍指向本实例 -> 可删', () => {
  const a = inst('qingdao.pmtiles')
  const p = fakeProtocol({ 'qingdao.pmtiles': a })
  assert.deepEqual(keysToEvict(['qingdao.pmtiles'], [a], p.tiles), ['qingdao.pmtiles'])
})

test('keysToEvict：同一键已被后来的建图覆盖成新实例 -> 不能删', () => {
  const oldInst = inst('qingdao.pmtiles')
  const newInst = inst('qingdao.pmtiles')
  const p = fakeProtocol({ 'qingdao.pmtiles': newInst })
  assert.deepEqual(keysToEvict(['qingdao.pmtiles'], [oldInst], p.tiles), [])
})

test('keysToEvict：键早被删过 -> 幂等，不报错也不返回', () => {
  const a = inst('x.pmtiles')
  const p = fakeProtocol({})
  assert.deepEqual(keysToEvict(['x.pmtiles'], [a], p.tiles), [])
})

test('keysToEvict：多档案只回收属于本实例的那几个', () => {
  const mineA = inst('a.pmtiles')
  const mineB = inst('b.pmtiles')
  const other = inst('c.pmtiles')
  const p = fakeProtocol({ 'a.pmtiles': mineA, 'b.pmtiles': mineB, 'c.pmtiles': other })
  assert.deepEqual(keysToEvict(['a.pmtiles', 'b.pmtiles', 'c.pmtiles'], [mineA, mineB], p.tiles), [
    'a.pmtiles',
    'b.pmtiles',
  ])
})

test('keysToEvict：注册表也支持普通对象（不依赖 Map）', () => {
  const a = inst('a.pmtiles')
  assert.deepEqual(keysToEvict(['a.pmtiles'], [a], { 'a.pmtiles': a }), ['a.pmtiles'])
})

test('keysToEvict：没有实例 / 没有键 / 传空都返回空数组', () => {
  assert.deepEqual(keysToEvict([], [], {}), [])
  assert.deepEqual(keysToEvict(null, null, null), [])
  assert.deepEqual(keysToEvict('k.pmtiles', [], {}), [])
})

test('keysToEvict：重复键只出一次', () => {
  const a = inst('a.pmtiles')
  const p = fakeProtocol({ 'a.pmtiles': a })
  assert.deepEqual(keysToEvict(['a.pmtiles', 'a.pmtiles'], [a], p.tiles), ['a.pmtiles'])
})

test('evictProtocolEntries：真的从 Map 里删掉，返回删掉的键', () => {
  const a = inst('a.pmtiles')
  const b = inst('b.pmtiles')
  const p = fakeProtocol({ 'a.pmtiles': a, 'b.pmtiles': b })
  const done = evictProtocolEntries(p, ['a.pmtiles'], [a])
  assert.deepEqual(done, ['a.pmtiles'])
  assert.equal(p.tiles.size, 1, '只该剩 b')
  assert.equal(p.tiles.get('b.pmtiles'), b, '别人的条目必须留着')
})

test('evictProtocolEntries：连切三个城市后注册表不增长（P0-2 的判据）', () => {
  const p = fakeProtocol({})
  const cities = ['qingdao-all.pmtiles', '370200.pmtiles', '110000.pmtiles']
  for (const key of cities) {
    const i = inst(key)
    p.add(i)
    // 模拟 destroy()：只回收「当前仍指向我」的键
    evictProtocolEntries(p, [key], [i])
  }
  assert.equal(p.tiles.size, 0, '每次 destroy 都该把条目清掉，size 不该累积')
})

test('evictProtocolEntries：protocol 缺失/形状不对时不炸', () => {
  assert.deepEqual(evictProtocolEntries(null, ['a'], [inst('a')]), [])
  assert.deepEqual(evictProtocolEntries({}, ['a'], [inst('a')]), [])
  assert.deepEqual(evictProtocolEntries({ tiles: {} }, ['a'], [inst('a')]), [])
})

test('evictProtocolEntries：delete 抛异常时其它键照删', () => {
  const a = inst('a.pmtiles')
  const b = inst('b.pmtiles')
  const tiles = new Map([
    ['a.pmtiles', a],
    ['b.pmtiles', b],
  ])
  const protocol = {
    tiles: {
      get: (k) => tiles.get(k),
      delete: (k) => {
        if (k === 'a.pmtiles') throw new Error('boom')
        tiles.delete(k)
        return true
      },
    },
  }
  const done = evictProtocolEntries(protocol, ['a.pmtiles', 'b.pmtiles'], [a, b])
  assert.deepEqual(done, ['b.pmtiles'])
})
