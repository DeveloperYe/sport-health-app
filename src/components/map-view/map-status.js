/**
 * 诊断行的小工具。
 *
 * 单独成文件的原因：App 逻辑层（v8）也要拼这行字，但它**不能** import
 * map-core.js —— 那会把 maplibre-gl 拖进没有 window/document 的逻辑层，
 * 一 import 就炸。所以状态与格式化放这里，谁都能引。
 */

export function makeMapStatus(seed) {
  return Object.assign(
    {
      webgl: '-', // 视图层 WebGL 能不能用（真机唯一能指望的判断）
      renderjs: '-', // renderjs 模块有没有真的跑起来
      maplibre: 'fail', // map 是否 load 成功
      tiles: 0, // 已加载的矢量瓦片数
      err: '', // 最后一条错误
      src: '', // 瓦片字节来自哪条路径
      worker: '', // worker 用的是 blob 还是默认
    },
    seed || {}
  )
}

export function trimStr(s, n) {
  const t = String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim()
  const max = n || 90
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 组件角落那行小字。字段顺序是约定好的，真机就靠它定位问题：
 * webgl:ok/fail renderjs:ok/fail maplibre:ok/fail tiles:<已加载瓦片数> err:<最后一条错误>
 * 末尾额外附 src（字节来源）与 worker（worker 方式），方便判断 App 端走了哪条路。
 */
export function formatMapStatus(s) {
  const st = s || {}
  const extra = []
  if (st.src) extra.push('src:' + st.src)
  if (st.worker) extra.push('worker:' + st.worker)
  return (
    'webgl:' + (st.webgl || '-') +
    ' renderjs:' + (st.renderjs || '-') +
    ' maplibre:' + (st.maplibre || 'fail') +
    ' tiles:' + (st.tiles || 0) +
    ' err:' + (trimStr(st.err) || '-') +
    (extra.length ? ' ' + extra.join(' ') : '')
  )
}
