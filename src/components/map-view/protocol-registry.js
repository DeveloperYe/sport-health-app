/**
 * PMTiles Protocol 注册表的回收决策（纯函数，便于单测）。
 *
 * 背景（P0-2：切城市内存永不回收）：
 *   pmtiles 4.5.0 的 `Protocol` **只有 add()/get()，没有 remove()**：
 *     add(inst) { this.tiles.set(inst.source.getKey(), inst) }
 *     get(key)  { return this.tiles.get(key) }
 *   而 map-core.js 里 Protocol 是**模块级单例**（切城市、重进页面都复用它），
 *   于是每换一个城市就在 `this.tiles` 里多留一个 PMTiles 实例 ——
 *   每个实例都攥着整个 .pmtiles 的 Uint8Array（青岛 22 MB、北京 94 MB、重庆 198 MB），
 *   逛过三个城市就是几百 MB 且 `destroy()` 也不会释放。
 *
 * 唯一可行的回收手段：直接操作那个 Map（键 -> 实例），删掉「当前仍指向本实例」的条目。
 *
 * 为什么把决策抽成纯函数而不是在 destroy() 里直接删：
 *   ① 同一个键可能已被后来的建图覆盖成新实例 —— 那时删了会把活着的地图打断；
 *   ② 键可能早被删过（要幂等，不能报错）；
 *   ③ 这段判断必须能单测，不该埋在依赖 DOM/maplibre 的 map-core.js 里。
 */

function normList(v) {
  if (Array.isArray(v)) return v
  if (v === null || v === undefined) return []
  return [v]
}

/** 注册表可能是 Map 也可能是普通对象，两种都认 */
function lookup(reg, key) {
  if (!reg) return undefined
  try {
    if (typeof reg.get === 'function') return reg.get(key)
    return reg[key]
  } catch (e) {
    return undefined
  }
}

/**
 * 算出「可以安全回收」的注册键。
 *
 * 判定：键在 ownedKeys 里 + 注册表现在仍指向本实例（instances 里的某一个）。
 * 指向别的实例（说明已被后来的建图覆盖）或已经不存在，都**不删**。
 *
 * @param {string[]|string} ownedKeys 本 core 建图时登记过的键
 * @param {Array} instances 本 core 登记的 PMTiles 实例
 * @param {Map|Object} registry 当前注册表（protocol.tiles）
 * @returns {string[]} 可删除的键
 */
export function keysToEvict(ownedKeys, instances, registry) {
  const keys = normList(ownedKeys)
  const mine = normList(instances)
  const out = []
  if (!mine.length) return out
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (!k) continue
    const cur = lookup(registry, k)
    if (cur === undefined || cur === null) continue // 已经不在了，不用删
    if (mine.indexOf(cur) < 0) continue // 指向别人的实例，不能删
    if (out.indexOf(k) < 0) out.push(k)
  }
  return out
}

/**
 * 按 keysToEvict 的结论真正删掉注册表条目（幂等，任何异常都吞掉）。
 * @returns {string[]} 实际删掉的键
 */
export function evictProtocolEntries(protocol, ownedKeys, instances) {
  const done = []
  if (!protocol) return done
  const reg = protocol.tiles
  if (!reg || typeof reg.delete !== 'function') return done
  const list = keysToEvict(ownedKeys, instances, reg)
  for (let i = 0; i < list.length; i++) {
    try {
      reg.delete(list[i])
      done.push(list[i])
    } catch (e) {
      /* 单个键删不掉不影响其它 */
    }
  }
  return done
}
