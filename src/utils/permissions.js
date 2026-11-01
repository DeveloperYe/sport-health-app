/**
 * 权限集中申请
 *
 * 目标：第一次进入 App 就把需要的系统权限一次申请完，而不是等用户点「开始运动」
 * 才弹定位、等打开统计才弹身体活动——那种"用到才弹"的体验很容易被拒绝。
 *
 * 需要哪些：
 *   定位（前台）   —— 跑步/走路的轨迹与距离
 *   后台定位       —— 锁屏/切到别的 App 后继续记录轨迹
 *   身体活动识别   —— 系统计步传感器（步数与步数热量）
 *
 * Android 平台限制（这是硬约束，不是偷懒）：
 *   Android 11+ 明确要求 ACCESS_BACKGROUND_LOCATION 必须**单独**申请，
 *   和前台定位放在同一次请求里会被系统直接判为拒绝。
 *   所以流程是：先申请「前台定位 + 计步」→ 用户允许后，再单独弹一次「始终允许」。
 *   从用户视角仍然是"一次点击配齐"，只是系统会出两个弹窗。
 *
 * 非 App 端（H5 / 小程序）：没有这种批量授权概念，直接返回 unsupported，
 * 让页面照常进入（H5 由浏览器自己弹，小程序由平台弹）。
 */

const KEY = 'fh_perms_v1'

/** 界面要展示的清单（顺序即展示顺序） */
export const PERMISSION_ITEMS = [
  {
    key: 'location',
    icon: '📍',
    title: '定位',
    desc: '绘制跑步 / 走路的轨迹与距离。轨迹只存在这台手机上，不上传。',
    required: true,
  },
  {
    key: 'background',
    icon: '🌙',
    title: '后台定位',
    desc: '锁屏或切到其他 App 时继续记录轨迹；不授权就只记录前台那一段。',
    required: false,
  },
  {
    key: 'activity',
    icon: '👟',
    title: '身体活动识别',
    desc: '读取系统计步传感器，统计步数与步数消耗。',
    required: true,
  },
  {
    key: 'notification',
    icon: '🔔',
    title: '通知',
    desc: '运动时在通知栏显示「正在记录运动」，这是安卓保持后台定位的必要条件。',
    required: false,
  },
]

/** 读缓存：{ askedAt, supported, location, background, activity } */
export function getPermState() {
  const s = uni.getStorageSync(KEY)
  return s && typeof s === 'object' ? s : null
}

/** 是否已经走过一次集中授权流程（无论同意还是跳过） */
export function hasAskedPermissions() {
  const s = getPermState()
  return !!(s && s.askedAt)
}

export function savePermState(state) {
  const next = Object.assign({}, state || {}, { askedAt: Date.now() })
  uni.setStorageSync(KEY, next)
  return next
}

// ---------------------------------------------------------------------------
// 平台实现
// ---------------------------------------------------------------------------

// #ifdef APP-PLUS
/** Android API 级别（拿不到就当 0） */
function sdkInt() {
  try {
    const V = plus.android.importClass('android.os.Build$VERSION')
    return Number(V.SDK_INT) || 0
  } catch (e) {
    return 0
  }
}

/** granted 数组里是否包含某个权限（名字可能带 android.permission. 前缀） */
function hasGranted(granted, name) {
  return (granted || []).some((p) => String(p).indexOf(name) >= 0)
}

/** 请求一批权限，统一返回 { granted: [], denied: [] }，不抛异常 */
function request(list) {
  return new Promise((resolve) => {
    try {
      plus.android.requestPermissions(
        list,
        (res) => {
          const granted = [].concat((res && res.granted) || [])
          const denied = [].concat((res && res.deniedPresent) || [], (res && res.deniedAlways) || [])
          resolve({ granted, denied })
        },
        () => resolve({ granted: [], denied: list })
      )
    } catch (e) {
      resolve({ granted: [], denied: list })
    }
  })
}
// #endif

/**
 * 一次性申请全部权限
 * @returns {Promise<{supported:boolean, location:string, background:string, activity:string}>}
 * 每个字段取 'granted' | 'denied' | 'na' | 'unsupported'
 */
export async function requestAllPermissions() {
  const state = {
    // 默认 false：只有真正做过 plus.android 请求的平台才算"支持集中授权"。
    // H5 / 小程序由系统或平台自己弹窗，这里不能冒充成功。
    supported: false,
    location: 'unsupported',
    background: 'na',
    activity: 'unsupported',
    notification: 'na',
  }

  // #ifdef APP-PLUS
  state.supported = true
  const sdk = sdkInt()
  // Android 10(API 29) 起"身体活动"才是运行时权限；更早的系统申请它可能抛未知权限
  const needActivity = sdk >= 29
  // 第一轮：前台定位 + 计步（这两个 Android 允许一起申请）
  const firstList = [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ]
  if (needActivity) firstList.push('android.permission.ACTIVITY_RECOGNITION')
  const first = await request(firstList)
  state.location = hasGranted(first.granted, 'ACCESS_FINE_LOCATION') ? 'granted' : 'denied'
  state.activity = needActivity
    ? hasGranted(first.granted, 'ACTIVITY_RECOGNITION')
      ? 'granted'
      : 'denied'
    : 'na'

  // 第二轮：后台定位必须在拿到前台定位之后单独申请（Android 11+ 硬性要求）
  if (state.location === 'granted' && sdk >= 29) {
    const second = await request(['android.permission.ACCESS_BACKGROUND_LOCATION'])
    state.background = hasGranted(second.granted, 'ACCESS_BACKGROUND_LOCATION') ? 'granted' : 'denied'
  }

  // 第三轮：通知（Android 13 / API 33 起才是运行时权限）。前台服务的常驻通知靠它显示
  if (sdk >= 33) {
    const third = await request(['android.permission.POST_NOTIFICATIONS'])
    state.notification = hasGranted(third.granted, 'POST_NOTIFICATIONS') ? 'granted' : 'denied'
  } else {
    state.notification = 'na'
  }
  // #endif

  savePermState(state)
  return state
}

/** 把状态翻译成一句人话，给首页/运动页提示用 */
export function permSummary(state) {
  const s = state || getPermState()
  if (!s) return ''
  if (!s.supported) return ''
  const bad = PERMISSION_ITEMS.filter((it) => s[it.key] === 'denied')
  if (!bad.length) return ''
  return `${bad.map((b) => b.title).join('、')}未授权，相关功能会受限（可在系统设置里开启）`
}
