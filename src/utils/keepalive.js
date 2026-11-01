/**
 * 运动保活（前台服务桥接）
 *
 * 为什么要有它：
 *   Android 8+ 之后，普通后台进程会被 Doze / App Standby 降频，定位回调直接被掐断。
 *   只申请 ACCESS_BACKGROUND_LOCATION 也不够——系统只保证"有前台服务的应用"能持续用定位。
 *   所以运动开始时挂一个前台服务（带常驻通知），结束时撤掉。
 *
 * 服务本体在原生工程里：
 *   android/app/src/main/java/com/developerye/sporthealth/MotionKeepAliveService.java
 *   它只负责把进程提到前台优先级，不参与定位采集（采集仍在 track.js），避免两套数据打架。
 *
 * 非 App 端（H5 / 小程序）是空实现：浏览器与微信没有这种常驻能力，
 * 页面切后台时定位本来就会停，属于平台差异，不是 bug。
 */

// #ifdef APP-PLUS
const SERVICE_CLASS = 'com.developerye.sporthealth.MotionKeepAliveService'

let started = false
let lastError = ''

/** 取主 Activity（拿 packageName 与 Context 能力） */
function mainActivity() {
  try {
    return plus.android.runtimeMainActivity()
  } catch (e) {
    return null
  }
}

/** 构造指向保活服务的 Intent */
function buildIntent() {
  const main = mainActivity()
  if (!main) return null
  try {
    const Intent = plus.android.importClass('android.content.Intent')
    const intent = new Intent()
    intent.setClassName(main.getPackageName(), SERVICE_CLASS)
    return intent
  } catch (e) {
    lastError = String(e && e.message)
    return null
  }
}

function sdkInt() {
  try {
    const V = plus.android.importClass('android.os.Build$VERSION')
    return Number(V.SDK_INT) || 0
  } catch (e) {
    return 0
  }
}

/**
 * 启动保活。返回是否成功（失败不抛异常，运动本身不能被保活拖垮）。
 * Android 8+ 必须用 startForegroundService，否则服务会在 5 秒内被系统判为违规。
 */
export function startKeepAlive() {
  if (started) return true
  const main = mainActivity()
  const intent = buildIntent()
  if (!main || !intent) return false
  try {
    if (sdkInt() >= 26) main.startForegroundService(intent)
    else main.startService(intent)
    started = true
    lastError = ''
    return true
  } catch (e) {
    lastError = String(e && e.message)
    // 少数 ROM 不允许后台起前台服务：退回普通 startService 再试一次
    try {
      main.startService(intent)
      started = true
      return true
    } catch (e2) {
      lastError = String(e2 && e2.message)
      return false
    }
  }
}

/** 撤掉保活；运动结束/页面销毁时必须调用，否则通知会一直挂着 */
export function stopKeepAlive() {
  const main = mainActivity()
  const intent = buildIntent()
  started = false
  if (!main || !intent) return
  try {
    main.stopService(intent)
  } catch (e) {
    lastError = String(e && e.message)
  }
}

export function isKeepAliveRunning() {
  return started
}

export function keepAliveError() {
  return lastError
}
// #endif

// #ifndef APP-PLUS
export function startKeepAlive() {
  return false
}
export function stopKeepAlive() {}
export function isKeepAliveRunning() {
  return false
}
export function keepAliveError() {
  return ''
}
// #endif
