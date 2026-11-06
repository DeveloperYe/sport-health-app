import test from 'node:test'
import assert from 'node:assert/strict'
import { archivesKey, archivesChanged } from '../src/components/map-view/archives-key.js'

const bundled = [{ file: 'qingdao-all.pmtiles', where: 'bundled' }]
const city = [{ file: '469001.pmtiles', where: 'user', path: '_doc/maps/469001.pmtiles' }]

test('归档指纹：同内容相同', () => {
  assert.equal(archivesKey(bundled), archivesKey([{ file: 'qingdao-all.pmtiles', where: 'bundled' }]))
})

test('★ 换城市 → 指纹必须变（否则视图层不会重建，地图停在旧城市）', () => {
  assert.equal(archivesChanged(bundled, city), true)
})

test('切回内置包 → 指纹也变', () => {
  assert.equal(archivesChanged(city, bundled), true)
})

test('同城市但落盘路径变了（保存退路 _downloads）→ 指纹变，需要重建', () => {
  const a = [{ file: '469001.pmtiles', where: 'user', path: '_doc/maps/469001.pmtiles' }]
  const b = [{ file: '469001.pmtiles', where: 'user', path: '_downloads/maps/469001.pmtiles' }]
  assert.equal(archivesChanged(a, b), true)
})

test('引用变了但内容一样 → 不触发重建（避免每次 push 都重建图）', () => {
  const a = [{ file: 'x.pmtiles', where: 'user', path: 'p' }]
  const b = [{ file: 'x.pmtiles', where: 'user', path: 'p' }]
  assert.equal(archivesChanged(a, b), false)
})

test('空/异常输入安全', () => {
  assert.equal(archivesKey(null), '')
  assert.equal(archivesKey([]), '')
  assert.equal(archivesChanged(null, null), false)
  assert.equal(archivesChanged([], undefined), false)
})
