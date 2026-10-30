// 底图配色对比度测试。
//
// 背景：原生 Protomaps dark 色标几乎没层次（地面相对亮度 1.4%、支路 3.3%、
// 建筑 0.6%），真机截图整片糊成深灰。这一组测试把"能不能看清"变成可断言的数字，
// 以后换配色、升级 basemaps 若把对比度做回去，单测会直接红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

async function loadTheme() {
  const src = readFileSync(
    fileURLToPath(new URL('../src/components/map-view/theme.js', import.meta.url)),
    'utf8'
  )
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { PALETTE, highContrastDark, parseColor, relLuminance, contrastRatio } = await loadTheme()

const flavor = highContrastDark({
  background: '#34373d',
  earth: '#1f1f1f',
  // 故意给一个"未来 basemaps 新增的 token"，用来验证不会被覆盖丢失
  brand_new_token: '#123456',
})

test('parseColor 支持 #rgb / #rrggbb / rgb() / rgba()', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255])
  assert.deepEqual(parseColor('#1a2b3c'), [26, 43, 60])
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30])
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30])
  assert.equal(parseColor('not-a-color'), null)
})

test('relLuminance / contrastRatio 边界正确', () => {
  assert.equal(relLuminance('#000000'), 0)
  assert.equal(relLuminance('#ffffff'), 1)
  assert.equal(contrastRatio('#000000', '#ffffff'), 21)
  assert.equal(contrastRatio('#123456', '#123456'), 1)
  assert.equal(contrastRatio('bad', '#000'), null)
})

test('高对比叠层保留基础 flavor 的全部 token（含未来新增的）', () => {
  assert.equal(flavor.brand_new_token, '#123456')
  for (const k of Object.keys(PALETTE)) assert.ok(k in flavor, `缺少 token: ${k}`)
})

test('地面被压到足够暗，给道路留出亮度空间', () => {
  assert.ok(relLuminance(flavor.earth) < 0.02, `earth 仍太亮: ${relLuminance(flavor.earth)}`)
  assert.ok(relLuminance(flavor.background) < 0.01, 'background 应是最暗的画布色')
})

test('道路对地面有足够对比度（支路最低也要 >2，主干 >4，快速路 >6）', () => {
  const c = (k) => contrastRatio(flavor[k], flavor.earth)
  assert.ok(c('minor_service') > 2, `支路对比度偏低: ${c('minor_service').toFixed(2)}`)
  assert.ok(c('minor_a') > 2.5, `次干对比度偏低: ${c('minor_a').toFixed(2)}`)
  assert.ok(c('major') > 4, `主干对比度偏低: ${c('major').toFixed(2)}`)
  assert.ok(c('highway') > 6, `快速路对比度偏低: ${c('highway').toFixed(2)}`)
})

test('道路等级亮度严格递增（支路 < 次干 < 主干 < 快速路）', () => {
  const order = ['minor_service', 'minor_a', 'major', 'highway']
  for (let i = 1; i < order.length; i++) {
    const a = relLuminance(flavor[order[i - 1]])
    const b = relLuminance(flavor[order[i]])
    assert.ok(b > a, `${order[i]}(${b.toFixed(3)}) 应亮于 ${order[i - 1]}(${a.toFixed(3)})`)
  }
})

test('建筑、水系、铁路都能从地面里分辨出来', () => {
  assert.ok(contrastRatio(flavor.buildings, flavor.earth) > 1.3, '建筑与地面区分不足')
  assert.ok(contrastRatio(flavor.water, flavor.earth) > 1.5, '水系与地面区分不足')
  assert.ok(contrastRatio(flavor.railway, flavor.earth) > 2, '铁路与地面区分不足')
})

test('水系偏蓝（不是中性灰），确保靠色相也能认出海岸线', () => {
  const [r, g, b] = parseColor(flavor.water)
  assert.ok(b > r + 20, `水系蓝色分量应明显高于红色: ${flavor.water}`)
})

test('描边比同级路面暗，才能勾出道路轮廓', () => {
  const pairs = [
    ['minor_casing', 'minor_a'],
    ['major_casing_late', 'major'],
    ['highway_casing_late', 'highway'],
  ]
  for (const [casing, road] of pairs) {
    assert.ok(
      relLuminance(flavor[casing]) < relLuminance(flavor[road]),
      `${casing} 应比 ${road} 暗`
    )
  }
})

// ---- 回归：配色不能把 layers() 的表达式搞出 undefined ----
// 2026-10-30 踩过：landcover / pois 是「按 kind 分组的嵌套对象」，被当成单色写成字符串后，
// fill-color 的 match 表达式里 7 个取值全变 undefined，MapLibre 拒绝整个样式，
// 真机表现为 maplibre:fail + tiles:0。这条测试把该类错误挡在提交前。

test('嵌套对象型 token 不被拍平成字符串（landcover 保留全部子键）', async () => {
  const { namedFlavor } = await import('@protomaps/basemaps')
  const base = namedFlavor('dark')
  const f = highContrastDark(base)
  assert.equal(typeof base.landcover, 'object')
  assert.equal(typeof f.landcover, 'object', 'landcover 必须是对象')
  for (const k of Object.keys(base.landcover)) {
    assert.ok(typeof f.landcover[k] === 'string', `landcover.${k} 丢失`)
  }
  // 没覆盖的嵌套 token（pois）应原样保留
  assert.equal(typeof f.pois, 'object', 'pois 应保持对象')
  assert.deepEqual(f.pois, base.pois)
})

test('用新配色生成的全部图层，paint/layout 里不含任何 undefined', async () => {
  const { namedFlavor, layers } = await import('@protomaps/basemaps')
  const f = highContrastDark(namedFlavor('dark'))
  const ls = layers('protomaps', f, { lang: 'zh' })
  const bad = []
  const walk = (v, path, lid) => {
    if (v === undefined) return bad.push(lid + ' ' + path)
    if (Array.isArray(v)) return v.forEach((x, j) => walk(x, path + '[' + j + ']', lid))
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k, lid)
    }
  }
  for (const l of ls) {
    walk(l.paint || {}, 'paint', l.id)
    walk(l.layout || {}, 'layout', l.id)
  }
  assert.deepEqual(bad, [], '生成出含 undefined 的图层: ' + bad.slice(0, 5).join(' | '))
})

test('过滤 symbol 层后仍有 50 层以上底图（避免配色改动把层数搞崩）', async () => {
  const { namedFlavor, layers } = await import('@protomaps/basemaps')
  const f = highContrastDark(namedFlavor('dark'))
  const nonSymbol = layers('protomaps', f, { lang: 'zh' }).filter((l) => l.type !== 'symbol')
  assert.ok(nonSymbol.length >= 50, `非 symbol 层只有 ${nonSymbol.length} 层`)
})
