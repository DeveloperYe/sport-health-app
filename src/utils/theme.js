/**
 * 主题运行时：三档（跟随系统 / 白天 / 黑夜）+ 原生导航栏与 tabBar 同步。
 *
 * 页面无需自己判断系统主题：全局 mixin 会把 `themeClass`（t-dark / t-light）注入每个页面，
 * 挂在根节点上即可让整棵子树的 CSS 变量切换。
 */

const KEY = 'fh_theme_mode' // auto | light | dark

let mode = 'auto'
let current = 'dark'
const subs = []

function safe(fn, fallback) {
  try {
    return fn()
  } catch (e) {
    return fallback
  }
}

/**
 * 调用 uni API 并吞掉所有失败。
 * 注意：uni 的 API 在没传 success/fail 时会返回 **Promise**，只 try/catch 接不到，
 * 平台不支持时会变成 unhandled rejection（真机上表现为一串 "Object" 报错）。
 */
function callApi(fn) {
  try {
    const r = fn()
    if (r && typeof r.catch === 'function') r.catch(() => {})
    return r
  } catch (e) {
    return null
  }
}

/** 系统当前主题（拿不到就当白天，白底更常见也更安全） */
export function systemTheme() {
  const t = safe(() => uni.getSystemInfoSync().theme, '')
  return t === 'dark' ? 'dark' : 'light'
}

export function getMode() {
  return mode
}

function resolveMode(m) {
  if (m === 'light' || m === 'dark') return m
  return systemTheme()
}

export function getTheme() {
  return current
}

/** 当前主题下的关键色（canvas 绘图等拿不到 CSS 变量的地方用） */
export function palette() {
  const dark = current === 'dark'
  return {
    dark,
    bg: dark ? '#0b0d10' : '#f4f6f8',
    card: dark ? '#15181d' : '#ffffff',
    line: dark ? '#262c35' : '#e3e9f0',
    text1: dark ? '#f3f5f7' : '#11161c',
    text2: dark ? '#9aa3ae' : '#5b6675',
    text3: dark ? '#68717d' : '#8b96a5',
    accent: dark ? '#2bd45c' : '#12b14a',
    accent2: dark ? '#7cf29d' : '#2bd45c',
    warm: dark ? '#ffb347' : '#ef8a1f',
    cool: dark ? '#4aa3ff' : '#2a7fe0',
    track: dark ? '#252b34' : '#e8eef5',
  }
}

/** 同步原生壳（状态栏 / 导航栏 / tabBar / 窗口底色），否则切了主题刘海和底栏还是旧色 */
function applyNative(theme) {
  const dark = theme === 'dark'
  const bg = dark ? '#0b0d10' : '#f4f6f8'
  const front = dark ? '#ffffff' : '#000000'
  callApi(() => uni.setNavigationBarColor({ frontColor: front, backgroundColor: bg }))
  callApi(() =>
    uni.setBackgroundColor({ backgroundColor: bg, backgroundColorTop: bg, backgroundColorBottom: bg })
  )
  callApi(() =>
    uni.setTabBarStyle({
      backgroundColor: bg,
      borderStyle: dark ? 'black' : 'white',
      color: dark ? '#68717d' : '#8b96a5',
      selectedColor: dark ? '#2bd45c' : '#12b14a',
    })
  )
  // H5：把页面底色同步给 body，避免切主题后边缘露旧色
  // #ifdef H5
  safe(() => {
    document.body.style.backgroundColor = bg
    document.documentElement.style.backgroundColor = bg
    // H5 的导航栏 / tabBar 由框架渲染，改不了原生 API，用 data-theme 让 CSS 接手
    document.body.setAttribute('data-theme', theme)
  }, null)
  // #endif
}

function notify() {
  const st = { mode: mode, theme: current }
  for (let i = 0; i < subs.length; i++) {
    try {
      subs[i] && subs[i](st)
    } catch (e) {
      /* ignore */
    }
  }
}

/** 应用当前模式（读持久化 → 解析 → 同步原生 → 通知页面） */
export function applyTheme(nextMode) {
  if (nextMode === 'auto' || nextMode === 'light' || nextMode === 'dark') mode = nextMode
  current = resolveMode(mode)
  safe(() => uni.setStorageSync(KEY, mode), null)
  applyNative(current)
  notify()
  return current
}

/** 设置模式并持久化 */
export function setThemeMode(nextMode) {
  return applyTheme(nextMode)
}

/** 订阅主题变化，返回取消函数 */
export function onThemeChange(cb) {
  if (typeof cb !== 'function') return () => {}
  subs.push(cb)
  return () => {
    const i = subs.indexOf(cb)
    if (i >= 0) subs.splice(i, 1)
  }
}

/** 初始化：读持久化 + 监听系统主题变化 */
export function initTheme() {
  const saved = safe(() => uni.getStorageSync(KEY), '')
  mode = saved === 'light' || saved === 'dark' || saved === 'auto' ? saved : 'auto'
  // 系统主题变化（用户在设置里切深色模式）：只有 auto 才跟随
  safe(() => {
    if (uni.onThemeChange) {
      uni.onThemeChange(() => {
        if (mode === 'auto') applyTheme('auto')
      })
    }
  }, null)
  return applyTheme(mode)
}

/** 给所有页面注入的主题 mixin */
export const themeMixin = {
  data() {
    return { themeMode: mode, theme: current }
  },
  computed: {
    themeClass() {
      return 't-' + this.theme
    },
    isDark() {
      return this.theme === 'dark'
    },
  },
  created() {
    this.__offTheme = onThemeChange((st) => {
      this.themeMode = st.mode
      this.theme = st.theme
    })
    // 别的页面切过主题后再进本页，直接对齐
    if (this.theme !== current) this.theme = current
    if (this.themeMode !== mode) this.themeMode = mode
  },
  beforeUnmount() {
    if (this.__offTheme) this.__offTheme()
  },
  unmounted() {
    if (this.__offTheme) this.__offTheme()
  },
}

/** 中文标签，给设置项用 */
export const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统', icon: '🌗' },
  { value: 'light', label: '白天', icon: '☀️' },
  { value: 'dark', label: '黑夜', icon: '🌙' },
]
