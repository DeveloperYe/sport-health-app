// 健康数据服务：平台差异能力（计步）尽量收敛在本模块
// - Android App（APP-PLUS）：系统计步传感器 TYPE_STEP_COUNTER（plus.android 桥接）
//   注：plus.stepCounter 是 DCloud「计步器模块」，离线打包 SDK 不含实现（对象壳存在但
//   永远返回 0，且 start() 会重置计数），因此 Android 端统一走系统传感器。
// - 微信小程序（MP-WEIXIN）：微信运动（scope.werun + 云端解密）
// - 其余平台（H5 等）：暂无计步能力，返回 0

// #ifdef APP-PLUS
// 动态申请计步权限（Android 6.0+ 必需；进程内只申请一次，不重复弹）
let permRequested = false
function requestActivityRecognition(done) {
  if (permRequested) {
    done()
    return
  }
  try {
    plus.android.requestPermissions(
      ['android.permission.ACTIVITY_RECOGNITION'],
      () => {
        permRequested = true
        done()
      },
      () => {
        permRequested = true
        done() // 失败也放行，交由读取兜底
      }
    )
  } catch (e) {
    done()
  }
}

// ===== 系统计步传感器 =====
// TYPE_STEP_COUNTER = 19（Android 4.4+ 标配），返回"开机以来累计步数"。
// 当日步数 = 当前累计 - 当日首次读取时的基线；手机重启后累计归零，检测到变小即重置基线。
const SENSOR_KEY = 'fh_step_sensor'
let sensorTotal = -1 // 监听到的最新系统累计步数
let sensorRegistered = false
let sensorFound = false
let sensorManagerRef = null // 持有引用防 GC
let listenerRef = null
let lastErr = ''

function ensureSensorListener() {
  if (sensorRegistered) return true
  try {
    const main = plus.android.runtimeMainActivity()
    const sm = main.getSystemService('sensor')
    plus.android.importClass(sm)
    const sensor = sm.getDefaultSensor(19) // SensorManager.TYPE_STEP_COUNTER
    if (!sensor) {
      lastErr = 'no-sensor'
      return false
    }
    sensorFound = true
    listenerRef = plus.android.implements('android.hardware.SensorEventListener', {
      onSensorChanged: function (event) {
        // Java 桥接对象取 values 数组，两种读法兜底
        let v = NaN
        try {
          const values = plus.android.getAttribute(event, 'values')
          v = Number(values && values[0])
        } catch (e) {
          try {
            v = Number(event.values[0])
          } catch (e2) {}
        }
        if (Number.isFinite(v) && v >= 0) sensorTotal = Math.floor(v)
      },
      onAccuracyChanged: function () {},
    })
    sm.registerListener(listenerRef, sensor, 3) // SENSOR_DELAY_NORMAL
    sensorManagerRef = sm
    sensorRegistered = true
    return true
  } catch (e) {
    lastErr = String((e && e.message) || e)
    return false
  }
}

// 读取系统累计步数；无传感器 / 3 秒内无回调返回 -1
function readSensorTotal() {
  return new Promise((resolve) => {
    requestActivityRecognition(() => {
      if (!ensureSensorListener()) {
        resolve(-1)
        return
      }
      if (sensorTotal >= 0) {
        resolve(sensorTotal)
        return
      }
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (sensorTotal >= 0) {
          clearInterval(iv)
          resolve(sensorTotal)
        } else if (Date.now() - t0 > 3000) {
          clearInterval(iv)
          resolve(-1)
        }
      }, 200)
    })
  })
}

function todayStr() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 今日步数（传感器口径）：当前累计 - 当日基线；当日首次读取/重启则设基线并返回 0
export function getTodaySteps() {
  return readSensorTotal().then((total) => {
    if (total < 0) return 0
    const today = todayStr()
    let rec = null
    try {
      rec = uni.getStorageSync(SENSOR_KEY)
    } catch (e) {}
    if (!rec || rec.date !== today || total < rec.base) {
      try {
        uni.setStorageSync(SENSOR_KEY, { date: today, base: total })
      } catch (e) {}
      return 0
    }
    return total - rec.base
  })
}

// 运动会话计步：返回系统累计步数（与基线同口径），会话步数 = 结束值 - 开始值
export function getWorkoutSteps() {
  return readSensorTotal().then((total) => (total > 0 ? total : 0))
}

// 临时诊断信息（真机排查用，定位后移除）
export function getStepDiag() {
  return {
    hasPlus: typeof plus !== 'undefined',
    permAsked: permRequested,
    sensorFound,
    registered: sensorRegistered,
    total: sensorTotal,
    err: lastErr,
  }
}
// #endif

// #ifdef MP-WEIXIN
// 微信运动授权状态：true=已授权，false=未授权 / 未知
export function isWeRunAuthorized() {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => resolve(!!(res.authSetting && res.authSetting['scope.werun'])),
      fail: () => resolve(false),
    })
  })
}

// 读取今日步数。未授权时不主动弹窗，返回 0（由 UI 引导用户手动开启）
export function getTodaySteps() {
  return new Promise((resolve) => {
    isWeRunAuthorized().then((authed) => {
      if (!authed) {
        resolve(0)
        return
      }
      readWeRun(resolve)
    })
  })
}

// 用户主动授权并读取步数（点击「开启微信运动」按钮时调用）
export function authorizeWeRun() {
  return new Promise((resolve) => {
    // scope.werun 不支持 wx.authorize 静默申请，调用 wx.getWeRunData
    // 会弹出微信运动授权框，用户同意后才能读取
    readWeRun(resolve)
  })
}

function readWeRun(resolve) {
  wx.getWeRunData({
    success: (res) => {
      wx.login({
        success: (loginRes) => {
          // 云端解密微信运动数据（sync-data 云函数已实现 decryptWerun）
          uniCloud
            .callFunction({
              name: 'sync-data',
              data: {
                action: 'decryptWerun',
                code: loginRes.code,
                encryptedData: res.encryptedData,
                iv: res.iv,
              },
            })
            .then((r) => {
              const result = r.result || {}
              resolve(typeof result.steps === 'number' ? result.steps : 0)
            })
            .catch(() => resolve(0))
        },
        fail: () => resolve(0),
      })
    },
    fail: () => resolve(0),
  })
}

// 运动会话计步：读取微信运动今日步数（需已授权），供会话内 delta 计步。
// 未授权 / 读取失败返回 0（不伪造）。
export function getWorkoutSteps() {
  return new Promise((resolve) => {
    isWeRunAuthorized().then((authed) => {
      if (!authed) {
        resolve(0)
        return
      }
      readWeRun(resolve)
    })
  })
}
// #endif

// #ifndef APP-PLUS
// #ifndef MP-WEIXIN
export function getTodaySteps() {
  return Promise.resolve(0)
}
export function getWorkoutSteps() {
  return Promise.resolve(0)
}
// #endif
// #endif

// 运动模式元数据：MET（代谢当量）用于卡路里估算
export const MODES = {
  run: { label: '跑步', met: 8.0, stepPerMin: 150 },
  walk: { label: '健走', met: 4.3, stepPerMin: 110 },
}

// 按步数估算卡路里（每千步约 40 千卡，以 60kg 为基准线性折算）
export function calcCaloriesBySteps(steps, weightKg = 60) {
  return Math.round((steps / 1000) * 40 * (weightKg / 60))
}

// MET 法估算运动消耗：千卡 = MET × 体重(kg) × 时长(小时)
export function calcSportCalories(met, minutes, weightKg = 60) {
  return Math.round(met * weightKg * (minutes / 60))
}