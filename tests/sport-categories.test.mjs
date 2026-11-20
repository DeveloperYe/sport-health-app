// 顶部类别条（横向滚动）测试：清单组装 + 选中态解析（纯函数）。
//
// 背景：2026-11-20 把顶部的 3 个等宽页签改成横向滚动的多类别条。
// 类别一多，两个问题必须钉住：
//   ① 「哪些类别、什么顺序、哪个被过滤掉」不能靠模板硬编码 —— 否则加一个动作要改模板
//   ② 「当前高亮哪一项」要能纯函数算出来 —— 否则选中态会散落在多个 v-if 里，
//      尤其「用户通过搜索/自定义选了一个不在清单里的动作」这种情形最容易出现
//      「一项都没高亮」的假 bug
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSportCategories,
  resolveCategoryBar,
  OTHER_CATEGORY_KEY,
} from '../src/utils/sport-categories.js'

// 与 health.js 的 MODES / nutrition.js 的 QUICK_EXERCISES 对齐（都带 uni 或 @ 别名，
// 纯测试 import 不了，所以按真实内容造一份；数值漂了这组测试会先报错）
const MODES = {
  run: { label: '跑步', met: 8.0 },
  walk: { label: '健走', met: 4.3 },
}
const QUICK = [
  { name: '跑步', met: 8.3 },
  { name: '骑行', met: 7.5 },
  { name: '游泳', met: 7.0 },
  { name: '跳绳', met: 12.3 },
  { name: '力量训练', met: 5.0 },
  { name: '篮球', met: 6.5 },
  { name: '羽毛球', met: 5.5 },
  { name: '瑜伽', met: 2.5 },
  { name: '爬楼梯', met: 8.8 },
  { name: '太极', met: 3.0 },
]

const cats = buildSportCategories(MODES, QUICK)
const idxOf = (label) => cats.findIndex((c) => c.label === label)

test('清单：轨迹类在前（按 MODES 顺序），MET 类在后，兜底「其他运动」永远在最后', () => {
  assert.equal(cats.length, 1 + 1 + 9 + 1, '跑步 + 健走 + 9 个 MET（跑步被剔掉）+ 其他运动')
  assert.deepEqual(cats.slice(0, 2).map((c) => c.label), ['跑步', '健走'])
  assert.deepEqual(cats.slice(0, 2).map((c) => c.kind), ['track', 'track'])
  assert.equal(cats[2].label, '骑行')
  assert.equal(cats[cats.length - 1].key, OTHER_CATEGORY_KEY)
  assert.equal(cats[cats.length - 1].label, '其他运动')
  assert.equal(cats[cats.length - 1].met, 0, '兜底类别没有 MET')
})

test('清单：MET 值与来源一致（8.0 / 4.3 / 12.3 …），不做二次加工', () => {
  assert.equal(cats[idxOf('跑步')].met, 8.0)
  assert.equal(cats[idxOf('健走')].met, 4.3)
  assert.equal(cats[idxOf('跳绳')].met, 12.3)
  assert.equal(cats[idxOf('游泳')].met, 7.0)
})

test('清单：与轨迹类撞名的动作被剔除（快捷清单里的「跑步 MET 8.3」）', () => {
  const runs = cats.filter((c) => c.label === '跑步')
  assert.equal(runs.length, 1, '同名只能出现在轨迹类里，不能再来一条 MET 口径的')
  assert.equal(runs[0].kind, 'track')
  assert.equal(runs[0].met, 8.0, '走的是 MODES 的 8.0，不是快捷清单的 8.3')
})

test('清单：过滤是按 label 动态做的，不是硬编码「跑步」', () => {
  const alt = buildSportCategories(
    { run: { label: '跑步', met: 8.0 }, walk: { label: '走路', met: 4.3 } },
    [{ name: '走路', met: 3.5 }, { name: '跑步', met: 8.3 }, { name: '游泳', met: 7 }]
  )
  assert.deepEqual(alt.map((c) => c.label), ['跑步', '走路', '游泳', '其他运动'])
})

test('清单：脏数据（无名称 / MET 非正 / 重复名）被丢掉，不会出现空项', () => {
  const dirty = buildSportCategories(MODES, [
    { name: '  ', met: 5 },
    { name: '游泳', met: 0 },
    { name: '游泳', met: 7 },
    { name: '游泳', met: 7 },
    { name: 'null MET' },
  ])
  assert.deepEqual(dirty.map((c) => c.label), ['跑步', '健走', '游泳', '其他运动'])
})

test('清单：MET 值保留 1 位小数（与 activity-store 落库口径一致）', () => {
  const c = buildSportCategories({ run: { label: '跑步', met: 8.04 } }, [])
  assert.equal(c[0].met, 8.0)
})

test('选中态：轨迹面板按 mode 高亮，跟 pageTab 一致', () => {
  assert.equal(resolveCategoryBar(cats, { pageTab: 'track', mode: 'run' }).activeKey, 'run')
  assert.equal(resolveCategoryBar(cats, { pageTab: 'track', mode: 'walk' }).activeKey, 'walk')
  assert.equal(resolveCategoryBar(cats, { pageTab: 'track', mode: 'run' }).activeIndex, 0)
  assert.equal(resolveCategoryBar(cats, { pageTab: 'track', mode: 'walk' }).activeIndex, 1)
})

test('选中态：MET 面板选了预设动作 → 高亮预设项，不追加临时项', () => {
  const r = resolveCategoryBar(cats, { pageTab: 'other', otherName: '游泳', otherMet: 7.0 })
  assert.equal(r.activeKey, 'met:游泳')
  assert.equal(r.transient, false)
  assert.equal(r.items.length, cats.length, '没有多出来的项')
})

test('选中态：MET 面板选了清单里没有的动作 → 末尾追加临时项并高亮', () => {
  const r = resolveCategoryBar(cats, { pageTab: 'other', otherName: '爬山', otherMet: 6.5 })
  assert.equal(r.transient, true)
  assert.equal(r.items.length, cats.length + 1)
  assert.equal(r.activeIndex, r.items.length - 1)
  assert.equal(r.items[r.activeIndex].label, '爬山')
  assert.equal(r.items[r.activeIndex].met, 6.5)
  assert.equal(r.activeKey, 'transient')
})

test('选中态：同名但 MET 不同 → 视为临时项，不误认成预设项', () => {
  // 用户自定义了一个「游泳 MET 5.0」，预设是 7.0
  const r = resolveCategoryBar(cats, { pageTab: 'other', otherName: '游泳', otherMet: 5.0 })
  assert.equal(r.transient, true)
  assert.equal(r.items[r.items.length - 1].met, 5.0)
  assert.notEqual(r.activeIndex, idxOf('游泳'), '不能高亮预设的「游泳」')
})

test('选中态：MET 面板还没选动作 → 高亮兜底「其他运动」', () => {
  const r = resolveCategoryBar(cats, { pageTab: 'other', otherName: '', otherMet: 0 })
  assert.equal(r.activeKey, OTHER_CATEGORY_KEY)
  assert.equal(r.transient, false)
})

test('选中态：轨迹面板不受 MET 面板残留动作影响', () => {
  // 之前选过「游泳」，切回跑步页签：高亮必须是跑步
  const r = resolveCategoryBar(cats, {
    pageTab: 'track',
    mode: 'walk',
    otherName: '游泳',
    otherMet: 7.0,
  })
  assert.equal(r.activeKey, 'walk')
  assert.equal(r.transient, false, '轨迹面板下不该冒出临时项')
})

test('选中态：不改入参（临时项只在本次渲染里存在，切走即消失）', () => {
  const before = cats.length
  resolveCategoryBar(cats, { pageTab: 'other', otherName: '爬山', otherMet: 6.5 })
  assert.equal(cats.length, before, '入参数组不能被 push 污染')
})

test('选中态：清单为空 / mode 非法时兜底到第一项，不抛异常', () => {
  const empty = resolveCategoryBar([], { pageTab: 'track', mode: 'run' })
  assert.deepEqual(empty.items, [])
  assert.equal(empty.activeIndex, -1)
  assert.equal(empty.activeKey, '')

  const bad = resolveCategoryBar(cats, { pageTab: 'track', mode: 'swim' })
  assert.equal(bad.activeIndex, 0, 'mode 非法时至少给 scroll-into-view 一个合法目标')

  const undef = resolveCategoryBar(undefined, undefined)
  assert.deepEqual(undef.items, [])
})

test('选中态：otherMet 传字符串/带小数噪声也能精确匹配（落库是 1 位小数）', () => {
  const r = resolveCategoryBar(cats, { pageTab: 'other', otherName: '游泳', otherMet: '7.0' })
  assert.equal(r.activeKey, 'met:游泳')
  assert.equal(r.transient, false)
  const noisy = resolveCategoryBar(cats, { pageTab: 'other', otherName: '游泳', otherMet: 7.0000001 })
  assert.equal(noisy.transient, false, '浮点噪声不该造出一个临时项')
})
