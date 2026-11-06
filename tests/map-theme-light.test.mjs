import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PALETTE, LIGHT_PALETTE, highContrastDark, highContrastLight, paletteFor,
  mergeFlavor, relLuminance, contrastRatio,
} from '../src/components/map-view/theme.js'

const L = (c) => relLuminance(c)

test('亮色：地表最亮，道路按等级递减（支路 > 次干 > 主干 > 快速路 亮度）', () => {
  const earth = L(LIGHT_PALETTE.earth)
  const minor = L(LIGHT_PALETTE.minor_a)
  const major = L(LIGHT_PALETTE.major)
  const hw = L(LIGHT_PALETTE.highway)
  assert.ok(earth > minor, '地表应比支路亮')
  assert.ok(minor > major, '支路应比主干亮')
  assert.ok(major > hw, '主干应比快速路亮')
})

test('亮色：道路与地表对比度 ≥ 1.4（不会糊成一片）', () => {
  for (const k of ['minor_a', 'major', 'highway']) {
    const r = contrastRatio(LIGHT_PALETTE[k], LIGHT_PALETTE.earth)
    assert.ok(r >= 1.4, k + ' 对比度仅 ' + r.toFixed(2))
  }
})

test('亮色：快速路对地表对比度 ≥ 3（手机上一眼可辨）', () => {
  const r = contrastRatio(LIGHT_PALETTE.highway, LIGHT_PALETTE.earth)
  assert.ok(r >= 3, '实际 ' + r.toFixed(2))
})

test('亮色：水系明显偏蓝（蓝通道最大）', () => {
  const hex = LIGHT_PALETTE.water
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  assert.ok(b > r + 20 && b > g, `water=${hex}`)
})

test('亮色：描边比路面更亮（浅底靠浅色勾边）', () => {
  assert.ok(L(LIGHT_PALETTE.major_casing_late) > L(LIGHT_PALETTE.major))
  assert.ok(L(LIGHT_PALETTE.minor_casing) > L(LIGHT_PALETTE.minor_a))
})

test('暗色：原有层次仍成立（道路比地面亮）', () => {
  assert.ok(L(PALETTE.minor_a) > L(PALETTE.earth))
  assert.ok(L(PALETTE.highway) > L(PALETTE.major))
})

test('mergeFlavor：嵌套 token 逐键合并，不丢子键', () => {
  const base = { landcover: { grassland: '#111', forest: '#222', barren: '#333' }, other: 'x' }
  const out = mergeFlavor(base, { landcover: { grassland: '#999' }, other: 'y' })
  assert.equal(out.landcover.grassland, '#999')
  assert.equal(out.landcover.forest, '#222', '未覆盖的子键必须保留')
  assert.equal(out.other, 'y')
})

test('paletteFor：light → 亮色，其余 → 暗色', () => {
  const base = { earth: '#000', buildings: '#000', landcover: {} }
  assert.equal(paletteFor('light', base).earth, LIGHT_PALETTE.earth)
  assert.equal(paletteFor('dark', base).earth, PALETTE.earth)
  assert.equal(paletteFor(undefined, base).earth, PALETTE.earth)
})

test('两套色标都覆盖同一批关键 token（不会漏）', () => {
  const keys = ['earth','water','buildings','minor_a','major','highway','railway','boundaries']
  for (const k of keys) {
    assert.ok(LIGHT_PALETTE[k], '亮色缺 ' + k)
    assert.ok(PALETTE[k], '暗色缺 ' + k)
  }
})
