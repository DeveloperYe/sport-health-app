import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    uni(),
  ],
  // app-vue 视图层（renderjs）默认按 es6(es2015) 打包，而 maplibre-gl v6 源码里
  // 有 BigInt 字面量（0n/1n，ES2020 特性），默认 target 直接编不过。
  // 注意必须是 es2020 —— es2019 一样会报 "Big integer literals are not available"。
  build: {
    target: 'es2020',
  },
})
