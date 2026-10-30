/**
 * 极小的 DOM 判定工具（故意不依赖 maplibre / 任何运行时，方便单测）。
 *
 * 背景：uni-app App 端的 renderjs 里，`this.$el` **不是 DOM 元素**，而是一个真值包装
 * 对象。之前用 `this.$el || document.getElementById(id)` 直接取容器，真机上就把这个
 * 包装对象喂给了 MapLibre，报：
 *   Invalid type: 'container' must be a String or HTMLElement.
 * 所以凡是「当容器用」的值，都要先过 looksLikeElement。
 */

/** 能否当 MapLibre 的容器：真实元素（nodeType===1）或具备 getBoundingClientRect */
export function looksLikeElement(x) {
  return (
    !!x &&
    typeof x === 'object' &&
    (x.nodeType === 1 || typeof x.getBoundingClientRect === 'function')
  )
}

/** 选择器字符串或真实元素 */
export function containerOk(c) {
  if (typeof c === 'string') return !!c
  return looksLikeElement(c)
}

/** 把可疑值描述成短字符串，用于错误消息与真机诊断行 */
export function describeValue(v) {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v !== 'object') return typeof v + '(' + String(v).slice(0, 24) + ')'
  const ctor = (v.constructor && v.constructor.name) || 'Object'
  return 'object:' + ctor + (v.nodeType ? '/nodeType=' + v.nodeType : '')
}
