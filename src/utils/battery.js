/**
 * 电池优化白名单（Android「忽略电池优化」）
 *
 * 为什么需要它：
 *   前台服务能挡住原生 Android 的 Doze，但国内 ROM（MIUI / EMUI / ColorOS / FuntouchOS 等）
 *   还会按自己的省电策略清理后台，哪怕你有前台服务。加入电池优化白名单是
 *   官方提供、且不需要 root 的正当手段，能显著降低被清的概率。
 *
 * 注意两点（都写在文档里的，不是我的猜测）：
 *   1. 它不是普通"运行时权限"，不能用 plus.android.requestPermissions 批量申请——
 *      必须 startActivity 弹一个专门的系统对话框（ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）。
 *      所以用户会看到"允许 [运动健康] 忽略电池优化？"这样一个单独的窗。
 *   2. 用户点了允许后没有回调，只能回到 App 时用 PowerManager.isIgnoringBatteryOptimizations()
 *      重新查一次状态——所以 gate 里用 resume 事件刷新。
 *   3. 上架 Google Play 时这个权限受政策限制（需说明理由），自用/侧载 APK 不受影响。
 */

// #ifdef APP-PLUS
/** 当前是否已在电池优化白名单里 */
export function isIgnoringBatteryOptimizations() {
  try {
    const main = plus.android.runtimeMainActivity()
    const pm = main.getSystemService('power') // Context.POWER_SERVICE
    if (!pm) return false
    plus.android.importClass(pm)
    return !!pm.isIgnoringBatteryOptimizations(main.getPackageName())
  } catch (e) {
    return false
  }
}

/**
 * 弹系统对话框申请加入白名单。
 * @returns {boolean} 是否成功把对话框拉起来（不代表用户点了允许）
 */
export function requestIgnoreBatteryOptimizations() {
  const main = (() => {
    try {
      return plus.android.runtimeMainActivity()
    } catch (e) {
      return null
    }
  })()
  if (!main) return false

  const pkg = main.getPackageName()
  try {
    const Intent = plus.android.importClass('android.content.Intent')
    const Uri = plus.android.importClass('android.net.Uri')
    const intent = new Intent()
    intent.setAction('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS')
    intent.setData(Uri.parse('package:' + pkg))
    main.startActivity(intent)
    return true
  } catch (e) {
    // 极少数 ROM 没有这个 Activity：退回"应用详情页"，让用户自己去省电里关
    try {
      const Intent = plus.android.importClass('android.content.Intent')
      const Uri = plus.android.importClass('android.net.Uri')
      const intent = new Intent()
      intent.setAction('android.settings.APPLICATION_DETAILS_SETTINGS')
      intent.setData(Uri.parse('package:' + pkg))
      main.startActivity(intent)
      return false
    } catch (e2) {
      return false
    }
  }
}

/** 打开本应用详情页（用户需要手动去关省电策略时的兜底入口） */
export function openAppSettings() {
  try {
    const main = plus.android.runtimeMainActivity()
    const Intent = plus.android.importClass('android.content.Intent')
    const Uri = plus.android.importClass('android.net.Uri')
    const intent = new Intent()
    intent.setAction('android.settings.APPLICATION_DETAILS_SETTINGS')
    intent.setData(Uri.parse('package:' + main.getPackageName()))
    main.startActivity(intent)
    return true
  } catch (e) {
    return false
  }
}
// #endif

// #ifndef APP-PLUS
export function isIgnoringBatteryOptimizations() {
  return false
}
export function requestIgnoreBatteryOptimizations() {
  return false
}
export function openAppSettings() {
  return false
}
// #endif
