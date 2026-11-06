import test from 'node:test'
import assert from 'node:assert/strict'
import { toPlusUrl, plusLocalPath } from '../src/components/map-view/tiles.js'

test('toPlusUrl：相对路径原样（plus.io 认 _doc/）', () => {
  assert.equal(toPlusUrl('_doc/maps/370200.pmtiles'), '_doc/maps/370200.pmtiles')
})

test('toPlusUrl：file:// 原样', () => {
  assert.equal(toPlusUrl('file:///storage/emulated/0/a.pmtiles'), 'file:///storage/emulated/0/a.pmtiles')
})

test('toPlusUrl：裸绝对路径补 file://（下载退路常见）', () => {
  assert.equal(toPlusUrl('/storage/emulated/0/Android/data/x/files/a.pmtiles'), 'file:///storage/emulated/0/Android/data/x/files/a.pmtiles')
})

test('toPlusUrl：空值安全', () => {
  assert.equal(toPlusUrl(''), '')
  assert.equal(toPlusUrl(null), '')
  assert.equal(toPlusUrl(undefined), '')
})

test('plusLocalPath：绝对路径不再做转换（无 plus 也不会变空）', () => {
  assert.equal(plusLocalPath('/storage/emulated/0/a.pmtiles'), '/storage/emulated/0/a.pmtiles')
})

test('plusLocalPath：无 plus 环境下相对路径返回空串而不是抛错', () => {
  assert.equal(plusLocalPath('_doc/maps/a.pmtiles'), '')
  assert.equal(plusLocalPath(''), '')
})
