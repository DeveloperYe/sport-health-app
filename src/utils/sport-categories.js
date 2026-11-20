/**
 * 顶部类别条（横向滚动、多类别）的数据与选中态解析 —— 纯函数，配 tests/sport-categories.test.mjs
 *
 * 背景（2026-11-20）：原来顶部是 3 个等宽页签（跑步 / 健走 / 其他运动），
 * 类别一多就挤成一团，第 3 项之后也没法再加。改成横向滚动条之后，
 * 类别清单必须**数据驱动**（模板里不再出现硬编码文案），选中态也必须能纯函数算出来，
 * 否则「当前到底选中了哪一项」这件事会被散落在模板的多个 v-if 里。
 *
 * 两类运动语义不同，混在一条 bar 上但行为必须分得清：
 *   kind: 'track' → 走 GPS + 计步（跑步 / 健走），由 pageTab='track' + mode 决定
 *   kind: 'met'   → 按 MET × 体重 × 时长 计时记账（游泳 / 篮球 …），落在 pageTab='other'
 *
 * 依赖全部参数注入：
 *   - MODES 来自 health.js，但 health.js 带 uni 条件编译（同一函数在三份 #ifdef 分支里
 *     各有一份定义），纯模块 import 不了 → 由 sport.vue 传进来
 *   - 快捷动作来自 nutrition.js 的 QUICK_EXERCISES（用了 @/data/*.json 别名），同样传进来
 * 这样 MET 值（8.0 / 4.3）与动作清单都只在各自源头写一次，这里不复制任何数字。
 */

/** 兜底类别的 key：搜索框与自定义动作的落点，没有 MET */
export const OTHER_CATEGORY_KEY = 'other'

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10

/**
 * 组装类别清单。
 * @param {object} modes       health.js 的 MODES：{ run: {label:'跑步', met:8.0}, walk: {...} }
 * @param {Array} quickList    nutrition.js 的 QUICK_EXERCISES：[{ name, met }]
 * @returns {Array<{key:string,label:string,kind:'track'|'met',met:number}>}
 *   顺序：轨迹类（按 MODES 顺序）→ MET 类（按快捷清单顺序）→ 兜底「其他运动」
 */
export function buildSportCategories(modes, quickList) {
  const m = modes || {}
  const out = Object.keys(m).map((key) => ({
    key,
    label: String((m[key] && m[key].label) || key),
    kind: 'track',
    met: round1(m[key] && m[key].met),
  }))

  // 与轨迹类撞名的动作要剔除：快捷清单里第一项就是「跑步 MET 8.3」，
  // 它落 activity-store（MET 口径）、轨迹类落 records 表，两者是两条链，
  // 同名并存只会让用户记出两条不同的「跑步」。
  const trackLabels = out.map((c) => c.label)
  const seen = Object.create(null)
  for (const item of quickList || []) {
    const name = String((item && item.name) || '').trim()
    const met = round1(item && item.met)
    if (!name || !(met > 0)) continue
    if (trackLabels.indexOf(name) >= 0) continue
    if (seen[name]) continue
    seen[name] = true
    out.push({ key: 'met:' + name, label: name, kind: 'met', met })
  }

  out.push({ key: OTHER_CATEGORY_KEY, label: '其他运动', kind: 'met', met: 0 })
  return out
}

/**
 * 算当前该高亮哪一项，以及要不要追加临时项。
 *
 * 选中规则：
 *   轨迹面板   → 与 mode 同 key 的轨迹类
 *   MET 面板、已选动作 → 预设项里按 **名称 + MET** 精确匹配；匹配不到就往末尾追加一个临时项并高亮它
 *   MET 面板、没选动作 → 兜底「其他运动」
 *
 * 为什么额外追加临时项（而不是「全部不高亮」或「高亮兜底项」）：
 *   用户通过搜索/自定义选了一个清单里没有的动作（如「爬山」）时，如果一项都不高亮，
 *   条上看起来像没选中任何东西，像 bug；如果高亮兜底项「其他运动」，
 *   又会让人以为「其他运动」= 当前这个动作。临时项让条永远能回答"我现在在练什么"，
 *   且它只在选中期间存在、不落库、切走即消失。
 *
 * @param {Array} categories buildSportCategories 的结果
 * @param {{pageTab?:string, mode?:string, otherName?:string, otherMet?:number}} state
 * @returns {{items:Array, activeIndex:number, activeKey:string, transient:boolean}}
 */
export function resolveCategoryBar(categories, state) {
  const list = Array.isArray(categories) ? categories : []
  const s = state || {}
  const items = list.slice() // 不改入参：临时项只在这次渲染里存在
  let activeIndex = -1
  let transient = false

  if (s.pageTab === 'track') {
    activeIndex = items.findIndex((c) => c.kind === 'track' && c.key === s.mode)
  } else if (Number(round1(s.otherMet)) > 0 && String(s.otherName || '').trim()) {
    const name = String(s.otherName).trim()
    const met = round1(s.otherMet)
    activeIndex = items.findIndex(
      (c) => c.kind === 'met' && c.met > 0 && c.label === name && c.met === met
    )
    if (activeIndex < 0) {
      items.push({ key: 'transient', label: name, kind: 'met', met, transient: true })
      activeIndex = items.length - 1
      transient = true
    }
  } else {
    activeIndex = items.findIndex((c) => c.key === OTHER_CATEGORY_KEY)
  }

  // 极端情况（清单为空 / mode 非法）兜底到第一项：scroll-into-view 得有个目标
  if (activeIndex < 0 && items.length) activeIndex = 0
  return {
    items,
    activeIndex,
    activeKey: items[activeIndex] ? items[activeIndex].key : '',
    transient,
  }
}
