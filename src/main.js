import { createSSRApp } from 'vue'
import App from './App.vue'
import { themeMixin, initTheme } from './utils/theme.js'

export function createApp() {
  const app = createSSRApp(App)
  // 每个页面都拿到 themeClass / isDark / themeMode，切主题时自动重渲染
  app.mixin(themeMixin)
  // 启动即应用主题（跟随系统 / 白天 / 黑夜）
  initTheme()
  return {
    app,
  }
}
