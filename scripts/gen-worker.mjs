#!/usr/bin/env node
/**
 * 生成 App/H5 用的 classic worker 静态文件：src/static/maplibre/worker.js
 *
 * 为什么需要：真机（Android WebView）里 `new Worker(blobURL)` 被拦
 *   Worker failed to load. Check that the worker URL is correct.
 * 而同一环境下 `fetch('static/...')` 是通的 —— 说明 blob: 源被策略禁止，
 * 同源静态文件走 `script-src 'self'` 才是可行路径。
 *
 * 源：node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs（ES 模块），
 * 剥掉模块语法后即为合法 classic 脚本（见 worker-src.js）。
 *
 * 用法：npm run gen:worker
 * 漂移：tests/worker-file.test.mjs 会校验提交的文件与当前 maplibre 源码一致，
 *       升级 maplibre 后忘了重跑本脚本，单测会红。
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = new URL('../', import.meta.url)

async function loadWorkerSrc() {
  // 包内没有 "type":"module"，.js 在 Node 里按 CJS 解析，直接 import 会报错；
  // 用 data: URL 载入源码（与 tests/*.test.mjs 同一手法）。
  const src = readFileSync(new URL('src/components/map-view/worker-src.js', root), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { toClassicWorkerSource } = await loadWorkerSrc()
const raw = readFileSync(new URL('node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', root), 'utf8')
const classic = toClassicWorkerSource(raw)

// 顶部加一行标记，便于人工识别「这是生成物」；校验测试会忽略这一行
const HEADER =
  '/* 自动生成，勿手改；来源 maplibre-gl/dist/maplibre-gl-worker.mjs，重生成用 npm run gen:worker */\n'
const content = HEADER + classic

const outPath = fileURLToPath(new URL('src/static/maplibre/worker.js', root))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, content)

const size = statSync(outPath).size
const dirty = /\bexport\s*\{/.test(classic) || /^[ \t]*import\s.*from\s*['"]/m.test(classic)
console.log(`已生成 ${outPath}`)
console.log(`  源 ${(raw.length / 1024).toFixed(0)} KB -> 产物 ${(size / 1024).toFixed(0)} KB`)
console.log(`  模块语法残留: ${dirty ? '有（异常！）' : '无'}`)
console.log(`  自启动入口 self.worker=保留: ${/self\.worker\s*=/.test(classic)}`)
