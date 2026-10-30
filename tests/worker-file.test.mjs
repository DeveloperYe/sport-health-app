// 校验 src/static/maplibre/worker.js 与当前 maplibre 源码是否同步（防漂移）。
//
// 这个文件是 gen:worker 生成的，App 端靠它当 worker 源（真机禁 blob:）。
// 升级 maplibre 后如果忘了重跑 `npm run gen:worker`，worker 会与主线程版本不匹配，
// 表现为地图静默不渲染 —— 所以用单测把这条钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const norm = (s) => String(s).replace(/\r\n/g, '\n')

async function load(rel) {
  const src = readFileSync(
    fileURLToPath(new URL(`../src/components/map-view/${rel}`, import.meta.url)),
    'utf8'
  )
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { toClassicWorkerSource, deriveSiblingUrl } = await load('worker-src.js')

const raw = readFileSync(
  fileURLToPath(new URL('../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url)),
  'utf8'
)
const committed = norm(
  readFileSync(fileURLToPath(new URL('../src/static/maplibre/worker.js', import.meta.url)), 'utf8')
)
const expected = norm(toClassicWorkerSource(raw))
// 生成文件顶部有一行「自动生成」标记，比对时去掉
const committedBody = committed.replace(/^\/\*[^\n]*\*\/\n/, '')

test('静态 worker 文件与当前 maplibre 源码同步（不一致就重跑 npm run gen:worker）', () => {
  assert.equal(
    committedBody.length,
    expected.length,
    `长度不一致：文件 ${committedBody.length} vs 期望 ${expected.length}`
  )
  assert.ok(committedBody === expected, '内容不一致：请运行 npm run gen:worker 重新生成')
})

test('静态 worker 文件是合法 classic 脚本（不含模块语法）', () => {
  assert.doesNotMatch(committedBody, /\bexport\s*\{/)
  assert.doesNotMatch(committedBody, /^[ \t]*import\s.*from\s*['"]/m)
})

test('静态 worker 文件保留自启动入口', () => {
  assert.match(committedBody, /self\.worker\s*=\s*new/)
})

// ---- deriveSiblingUrl：真机上用它把「读通的瓦片地址」换成 worker 地址 ----

test('deriveSiblingUrl：http 源（uni-app 本地服务最常见形态）', () => {
  assert.equal(
    deriveSiblingUrl('http://127.0.0.1:13131/static/tiles/a.pmtiles', 'static/tiles', 'static/maplibre/worker.js'),
    'http://127.0.0.1:13131/static/maplibre/worker.js'
  )
})

test('deriveSiblingUrl：带子路径与查询串也能推', () => {
  assert.equal(
    deriveSiblingUrl('http://h/apps/X/www/static/tiles/a.pmtiles?v=1', 'static/tiles', 'static/maplibre/worker.js'),
    'http://h/apps/X/www/static/maplibre/worker.js'
  )
})

test('deriveSiblingUrl：不匹配时返回空串（调用方会退回其它候选）', () => {
  assert.equal(deriveSiblingUrl('http://h/other/a.pmtiles', 'static/tiles', 'static/maplibre/worker.js'), '')
  assert.equal(deriveSiblingUrl('', 'static/tiles', 'static/maplibre/worker.js'), '')
})

test('deriveSiblingUrl：toPath 带尾斜杠时用于推导目录（prepareWorker 就是这种用法）', () => {
  assert.equal(
    deriveSiblingUrl('http://127.0.0.1:13131/static/tiles/a.pmtiles', 'static/tiles', 'static/maplibre/'),
    'http://127.0.0.1:13131/static/maplibre/'
  )
})
