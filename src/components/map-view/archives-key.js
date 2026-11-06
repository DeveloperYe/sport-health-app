/**
 * 档案清单的"指纹"：用来判断城市是否真的换了。
 *
 * 为什么需要它：
 *   App 端地图在 renderjs（视图层）里建，逻辑层只能通过 props 推数据。
 *   切城市时如果只把 appMode 抖一下，视图层手里 `core` 还是旧的，`boot()` 的
 *   `!this.core` 守卫会让它直接跳过 → 地图永远停在旧城市。
 *
 *   ​`比较指纹`比"比较引用"可靠：逻辑层每次都会重建数组，引用必然变，比引用会误触发重建；
 *   而指纹只看真正决定加载什么的字段（文件、来源、路径），不变就不重建。
 */

/** 档案列表 → 稳定指纹字符串 */
export function archivesKey(list) {
  const arr = Array.isArray(list) ? list : []
  const parts = []
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i] || {}
    parts.push([String(a.file || ''), String(a.where || ''), String(a.path || '')].join('|'))
  }
  return parts.join(';')
}

/** 只需判断是否变化 */
export function archivesChanged(prev, next) {
  return archivesKey(prev) !== archivesKey(next)
}
