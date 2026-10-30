// worker-src.js 的单元测试，直接拿**真实的 maplibre worker 源码**验证。
//
// 这组测试锁死了一个真机 bug：worker 源码是 ES 模块（结尾 `export{dC as default};`），
// 而 blob URL 没有 .mjs 后缀 → maplibre 按 classic worker 创建 → export 语法错误 →
// 真机报 "Worker failed to load. Check that the worker URL is correct."
//
// 运行：npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

async function load(rel) {
  const src = readFileSync(
    fileURLToPath(new URL(`../src/components/map-view/${rel}`, import.meta.url)),
    'utf8'
  )
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { toClassicWorkerSource, isClassicScript } = await load('worker-src.js')

const real = readFileSync(
  fileURLToPath(new URL('../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url)),
  'utf8'
)

test('原始 worker 源码带模块语法，作为 classic 脚本无法编译（复现真机失败）', () => {
  assert.match(real, /export\s*\{/, '这个 maplibre 版本应当带 export 语句')
  assert.equal(isClassicScript(real), false, '带 export 的源码在 classic worker 里必须报语法错误')
})

test('剥离后可作为 classic 脚本编译（修复的判据）', () => {
  const stripped = toClassicWorkerSource(real)
  assert.equal(isClassicScript(stripped), true)
})

test('剥离后不再残留 export / import 语句', () => {
  const stripped = toClassicWorkerSource(real)
  assert.doesNotMatch(stripped, /\bexport\s*\{/)
  assert.doesNotMatch(stripped, /^[ \t]*import\s.*from\s*['"]/m)
})

test('剥离不破坏自启动入口（worker 自己要能起实例）', () => {
  const stripped = toClassicWorkerSource(real)
  assert.match(stripped, /self\.worker\s*=\s*new/, '末尾的 self.worker = new Xxx(self) 必须保留')
})

test('sourceMappingURL 注释被去掉（blob 里指不到 .map）', () => {
  const stripped = toClassicWorkerSource(real)
  assert.doesNotMatch(stripped, /sourceMappingURL/)
})

test('小样本：只剥模块语法，不动业务代码', () => {
  const src = "import a from './x.js'\nvar n=1;\nexport{dC as default};\nself.worker=new dC(self);\n//# sourceMappingURL=a.map"
  const out = toClassicWorkerSource(src)
  assert.doesNotMatch(out, /import\s.*from/)
  assert.doesNotMatch(out, /export/)
  assert.match(out, /var n=1;/)
  assert.match(out, /self\.worker=new dC\(self\);/)
})
