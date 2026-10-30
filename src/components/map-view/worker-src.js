/**
 * maplibre worker 源码的模块语法剥离（纯函数，无任何依赖，方便单测）。
 *
 * 背景（真机实测）：maplibre-gl v6 的 `dist/maplibre-gl-worker.mjs` 是 ES 模块，
 * 结尾有 `export{dC as default};`。它按「URL 是否以 .mjs/.cjs 结尾」决定用
 * module worker，而我们用的是 blob URL（没有后缀）→ 落到 classic worker →
 * classic 脚本里出现 export 就是语法错误 → 真机报：
 *   Worker failed to load. Check that the worker URL is correct.
 *
 * 源码本身是自包含的：末尾 `te(self) && (self.worker = new dC(self))` 会自启动，
 * `export` 只是给模块消费者用的。所以剥掉模块语法即可得到合法 classic 脚本。
 */

/** 去掉顶层 import、export {...} 与 sourceMappingURL 注释 */
export function toClassicWorkerSource(src) {
  return String(src)
    // 顶层 import ... from '...'（maplibre 这个文件实际上没有，防御性处理）
    .replace(/^[ \t]*import\s[^\n]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    // 任意位置的 export { ... };
    .replace(/\bexport\s*\{[^}]*\}\s*;?/g, '')
    // blob 里指不到 .map，留着只会多一次失败请求
    .replace(/\/\/#\s*sourceMappingURL=[^\n]*/g, '')
}

/** 语法预检：能否作为 classic 脚本被编译（只编译不执行） */
export function isClassicScript(src) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(String(src))
    return true
  } catch (e) {
    return false
  }
}
