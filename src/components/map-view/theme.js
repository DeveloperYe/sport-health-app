/**
 * 底图配色：Protomaps「深色高对比」主题。
 *
 * 为什么不用现成的 dark flavor：实测它的色标几乎没有层次 ——
 *   earth #1f1f1f(12%) / buildings #111111(7%) / minor #333333(20%)
 *   major #3d3d3d(24%) / highway #474747(28%)
 * 地面与支路只差 8 个百分点，手机上糊成一片；建筑比地面还暗，等于消失。
 *
 * 做法：保留 namedFlavor('dark') 的全部 token（这样 basemaps 升级新增色标不会漏），
 * 只覆盖真正影响辨识的那批，遵循三条规则：
 *   1. 底子压暗（earth/background 降到 6–8%），把亮度预算让给道路；
 *   2. 道路按等级拉开（支路 ~33% / 次干 ~40% / 主干 ~54% / 快速路 ~69%），
 *      并用比路面更暗的 casing 勾边，形成清晰轮廓；
 *   3. 水系拉向蓝色并单独调亮一档，避免与地面同色；建筑略亮于地面，作为肌理而非黑块。
 *
 * 本模块保持纯函数（不 import maplibre / basemaps），便于单测直接验对比度。
 */

/** 覆盖 namedFlavor('dark') 的色标 */
export const PALETTE = {
  // —— 画布与地表：压暗，给道路腾亮度 ——
  background: '#0b0d11',
  earth: '#14161a',
  glacier: '#161a20',
  sand: '#20211c',
  beach: '#24251e',
  pedestrian: '#191c21',
  aerodrome: '#171a1f',
  runway: '#3a4049',
  pier: '#39404a',

  // —— 绿地/自然：色相偏绿，亮度低于道路 ——
  park_a: '#16241c',
  park_b: '#132019',
  wood_a: '#17251e',
  wood_b: '#17251e',
  scrub_a: '#1a1e1b',
  scrub_b: '#1a1e1b',
  zoo: '#1a1e1b',
  // 注意：landcover 不是单个颜色，而是按 kind 分组的对象（grassland/barren/…），
  // 写成字符串会让 layers() 生成 fill-color 表达式里 7 个取值全变 undefined，
  // MapLibre 直接拒绝渲染整个样式。见下面 NESTED 的处理与单测。
  landcover: {
    grassland: '#1a241c',
    barren: '#22221d',
    urban_area: '#191a1d',
    farmland: '#1b221d',
    glacier: '#1c1f24',
    scrub: '#1c1f1a',
    forest: '#16241e',
  },

  // —— 各类用地：几乎同地面，只留一点点区分 ——
  hospital: '#211d20',
  industrial: '#1a1b1e',
  school: '#201c1d',
  military: '#1e1c1b',

  // —— 水系：唯一刻意偏蓝的色相；地面压暗后必须跟着提亮，否则反而更看不清 ——
  water: '#143c57',

  // —— 建筑：略亮于地面，读作肌理（太暗就成黑块，看不见街区轮廓）——
  buildings: '#2b3038',

  // —— 道路：按等级分档提亮（变化最大的一批）——
  other: '#4d545e',
  minor_service: '#4d545e',
  minor_b: '#535b66',
  minor_a: '#5e6672',
  link: '#5e6672',
  major: '#7e8896',
  highway: '#a3aebd',

  // —— 描边：比路面暗一档，勾出道路轮廓 ——
  minor_service_casing: '#1b1e24',
  minor_casing: '#1b1e24',
  link_casing: '#1b1e24',
  major_casing_early: '#1b1e24',
  major_casing_late: '#1b1e24',
  highway_casing_early: '#1b1e24',
  highway_casing_late: '#1b1e24',

  // —— 铁路与边界：细而亮，但别盖过道路 ——
  // 边界在深色水面上极显眼，亮度压到中等（原 12.4% → 约 18%），只作辅助线
  railway: '#4a525d',
  boundaries: '#5e6a7d',

  // —— 隧道：整体压暗，表示"在下方" ——
  tunnel_other: '#31363d',
  tunnel_minor: '#31363d',
  tunnel_link: '#31363d',
  tunnel_major: '#3c434c',
  tunnel_highway: '#4b535d',
  tunnel_other_casing: '#101216',
  tunnel_minor_casing: '#101216',
  tunnel_link_casing: '#101216',
  tunnel_major_casing: '#101216',
  tunnel_highway_casing: '#101216',

  // —— 桥梁：与同级道路同色（在地面之上）——
  bridges_other: '#4d545e',
  bridges_minor: '#535b66',
  bridges_link: '#5e6672',
  bridges_major: '#7e8896',
  bridges_highway: '#a3aebd',
  bridges_other_casing: '#1b1e24',
  bridges_minor_casing: '#1b1e24',
  bridges_link_casing: '#1b1e24',
  bridges_major_casing: '#1b1e24',
  bridges_highway_casing: '#1b1e24',

  // —— 标注（当前离线包无字体，symbol 层已过滤；留着防以后加字体）——
  roads_label_minor: '#9aa3b0',
  roads_label_major: '#c3ccd9',
  roads_label_minor_halo: '#0b0d11',
  roads_label_major_halo: '#0b0d11',
  ocean_label: '#9fb0c2',
  subplace_label: '#9aa3b0',
  subplace_label_halo: '#0b0d11',
  city_label: '#c3ccd9',
  city_label_halo: '#0b0d11',
  state_label: '#aab4c2',
  state_label_halo: '#0b0d11',
  country_label: '#c3ccd9',
  country_label_halo: '#0b0d11',
  address_label: '#aab4c2',
  address_label_halo: '#0b0d11',
  // pois 同样是按颜色名分组的对象（blue/green/red/…），不能整块覆盖成字符串；
  // 这里保留基础 flavor 的原值（离线包已过滤 symbol 层，本来也用不到）。
}

/**
 * 把高对比色标叠到基础 flavor 上。
 * 用展开而不是替换：basemaps 以后新增的 token 会原样保留，不会因缺 key 出错。
 * 对「嵌套对象型」token（landcover、pois 这类按 kind/颜色名分组的）做一层合并：
 * 直接整体覆盖会丢掉没写到的子键，layers() 生成的 match 表达式里就会出现 undefined，
 * MapLibre 会拒绝整个样式（真机上表现为 maplibre:fail + tiles:0）。
 */
export function highContrastDark(base) {
  const b = base || {}
  const out = Object.assign({}, b)
  for (const [k, v] of Object.entries(PALETTE)) {
    const cur = b[k]
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)
    out[k] = isObj(cur) && isObj(v) ? Object.assign({}, cur, v) : v
  }
  return out
}

/** #rgb / #rrggbb / rgba(...) → [r,g,b]（0–255）；解析失败返回 null */
export function parseColor(c) {
  const s = String(c || '').trim()
  let m = s.match(/^#([0-9a-f]{3})$/i)
  if (m) {
    const h = m[1]
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
  }
  m = s.match(/^#([0-9a-f]{6})$/i)
  if (m) {
    const h = m[1]
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ]
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x))
    if (p.length >= 3) return [p[0], p[1], p[2]]
  }
  return null
}

/** WCAG 相对亮度（0–1） */
export function relLuminance(c) {
  const rgb = parseColor(c)
  if (!rgb) return null
  const f = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

/** 两色对比度（1–21，WCAG 定义） */
export function contrastRatio(a, b) {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  if (la === null || lb === null) return null
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
