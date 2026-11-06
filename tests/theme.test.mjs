import test from 'node:test'
import assert from 'node:assert/strict'

// 最小 uni 桩：theme.js 只用到这几个 API
const store = new Map()
let sysTheme = 'dark'
const calls = { nav: [], bg: [], tab: [] }
globalThis.uni = {
  getSystemInfoSync: () => ({ theme: sysTheme }),
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
  setStorageSync: (k, v) => store.set(k, v),
  setNavigationBarColor: (o) => calls.nav.push(o),
  setBackgroundColor: (o) => calls.bg.push(o),
  setTabBarStyle: (o) => calls.tab.push(o),
  onThemeChange: (cb) => { globalThis.__themeCb = cb },
}

const mod = await import('../src/utils/theme.js')

test('auto 模式跟随系统：系统暗 → 暗', () => {
  sysTheme = 'dark'
  assert.equal(mod.initTheme(), 'dark')
  assert.equal(mod.getMode(), 'auto')
})

test('auto 模式跟随系统：系统亮 → 亮', () => {
  sysTheme = 'light'
  assert.equal(mod.initTheme(), 'light')
})

test('手动指定优先于系统', () => {
  sysTheme = 'dark'
  assert.equal(mod.setThemeMode('light'), 'light')
  sysTheme = 'light'
  assert.equal(mod.setThemeMode('dark'), 'dark')
  assert.equal(mod.getMode(), 'dark')
})

test('模式会持久化，重新 init 仍生效', () => {
  mod.setThemeMode('light')
  store.set('fh_theme_mode', 'light')
  assert.equal(mod.initTheme(), 'light')
})

test('持久化值是垃圾时回落 auto', () => {
  store.set('fh_theme_mode', 'rainbow')
  mod.initTheme()
  assert.equal(mod.getMode(), 'auto')
})

test('palette():暗色/亮色取不同品牌色', () => {
  mod.setThemeMode('dark')
  const d = mod.palette()
  mod.setThemeMode('light')
  const l = mod.palette()
  assert.equal(d.dark, true)
  assert.equal(l.dark, false)
  assert.notEqual(d.accent, l.accent)
  assert.notEqual(d.bg, l.bg)
})

test('切换主题会同步原生壳（导航栏/窗口/tabBar）', () => {
  calls.nav.length = 0; calls.bg.length = 0; calls.tab.length = 0
  mod.setThemeMode('light')
  assert.ok(calls.nav.length >= 1, '应调用 setNavigationBarColor')
  assert.ok(calls.bg.length >= 1, '应调用 setBackgroundColor')
  assert.ok(calls.tab.length >= 1, '应调用 setTabBarStyle')
  assert.equal(calls.nav[0].backgroundColor, '#f4f6f8')
  assert.equal(calls.nav[0].frontColor, '#000000')
})

test('订阅能收到推送且可取消', () => {
  let got = null
  const off = mod.onThemeChange((s) => { got = s })
  mod.setThemeMode('dark')
  assert.equal(got.theme, 'dark')
  off()
  got = null
  mod.setThemeMode('light')
  assert.equal(got, null, '取消后不应再收到')
})

test('THEME_OPTIONS 三档齐全', () => {
  assert.deepEqual(mod.THEME_OPTIONS.map((o) => o.value), ['auto', 'light', 'dark'])
})
