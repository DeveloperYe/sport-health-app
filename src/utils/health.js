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

// ===== 系统计步传感器（双传感器兜底） =====
// - TYPE_STEP_COUNTER(19)：开机以来累计，按批上报；部分机型注册后只推一次初始值就卡住。
// - TYPE_STEP_DETECTOR(18)：每落一步推一个事件，实时性最好。
// 对外统一返回两路对齐后的 max 值：任一路失效（counter 卡住 / detector 缺失）另一路兜底。
const SENSOR_KEY = 'fh_step_sensor'
let sensorTotal = -1 // counter 最新累计值（开机口径）
let counterBase = null // counter 首值时点（统一口径为「注册起算」的起点）
let detTotal = 0 // detector 自注册起事件累计（进程内单调）
let counterEvents = 0 // 诊断：counter 回调次数
let detEvents = 0 // 诊断：detector 回调次数
let sensorRegistered = false
let sensorFound = false
let detFound = false
let sensorManagerRef = null // 持有引用防 GC
let listenerRef = null
let detListenerRef = null
let lastErr = ''

// 从 Java 事件对象取 values[0]（桥接两种读法兜底）
function readEventValue(event) {
  let v = NaN
  try {
    const values = plus.android.getAttribute(event, 'values')
    v = Number(values && values[0])
  } catch (e) {
    try {
      v = Number(event.values[0])
    } catch (e2) {}
  }
  return v
}

function ensureSensorListener() {
  if (sensorRegistered) return true
  try {
    const main = plus.android.runtimeMainActivity()
    const sm = main.getSystemService('sensor')
    plus.android.importClass(sm)
    sensorManagerRef = sm

    // counter（开机累计，可能卡住）
    try {
      const sc = sm.getDefaultSensor(19) // SensorManager.TYPE_STEP_COUNTER
      if (sc) {
        sensorFound = true
        listenerRef = plus.android.implements('android.hardware.SensorEventListener', {
          onSensorChanged: function (event) {
            counterEvents++
            const v = readEventValue(event)
            if (Number.isFinite(v) && v >= 0) {
              if (counterBase === null) counterBase = Math.floor(v) // 首值即起点
              sensorTotal = Math.floor(v)
            }
          },
          onAccuracyChanged: function () {},
        })
        sm.registerListener(listenerRef, sc, 3) // SENSOR_DELAY_NORMAL
      } else if (!lastErr) {
        lastErr = 'no-counter'
      }
    } catch (e) {
      lastErr = 'counter:' + String((e && e.message) || e)
    }

    // detector（每步一事件，实时）
    try {
      const sd = sm.getDefaultSensor(18) // SensorManager.TYPE_STEP_DETECTOR
      if (sd) {
        detFound = true
        detListenerRef = plus.android.implements('android.hardware.SensorEventListener', {
          onSensorChanged: function () {
            detEvents++
            detTotal++ // 每个事件 = 落地一步
          },
          onAccuracyChanged: function () {},
        })
        sm.registerListener(detListenerRef, sd, 3)
      }
    } catch (e) {
      if (!lastErr) lastErr = 'detector:' + String((e && e.message) || e)
    }

    sensorRegistered = true
    return sensorFound || detFound
  } catch (e) {
    lastErr = String((e && e.message) || e)
    return false
  }
}

// 两路统一为「自注册/首值起算」的增量后取 max（单调、无量级跳变，供 delta 计步）：
// - counter 分支：sensorTotal - counterBase（首值前无效，counter 晚到不影响已产生的读数）
// - detector 分支：detTotal（每步 +1）
// 任一分支失效另一分支顶上；手机重启 counter 归零 → 该分支按无效处理，由 detector 兜底。
function compositeTotal() {
  const counterDelta =
    counterBase !== null && sensorTotal >= counterBase ? sensorTotal - counterBase : -1
  if (counterDelta < 0) return detTotal
  return Math.max(counterDelta, detTotal)
}

// 读取累计步数；两路都无数据 / 3 秒内无回调返回 -1
function readComposite() {
  return new Promise((resolve) => {
    requestActivityRecognition(() => {
      if (!ensureSensorListener()) {
        resolve(-1)
        return
      }
      const ready = () => sensorTotal >= 0 || detEvents > 0
      if (ready()) {
        resolve(compositeTotal())
        return
      }
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (ready()) {
          clearInterval(iv)
          resolve(compositeTotal())
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

// 今日步数（传感器口径）：两路各自相对当日基线取 max。
// 基线在当日首次读取时设定；counter 归零（手机重启）→ 全部重设；detector 归零（App 重启）
// → 仅重设 det 基线（counter 分支仍有效，不丢当日步数）。
export function getTodaySteps() {
  return readComposite().then((total) => {
    if (total < 0) return 0
    const today = todayStr()
    let rec = null
    try {
      rec = uni.getStorageSync(SENSOR_KEY)
    } catch (e) {}
    const valid = rec && rec.date === today && typeof rec.base === 'number'
    if (!valid) {
      // 当日首次读取：双基线同时设定
      try {
        uni.setStorageSync(SENSOR_KEY, { date: today, base: sensorTotal, detBase: detTotal })
      } catch (e) {}
      return 0
    }
    if (sensorTotal >= 0 && sensorTotal < rec.base) {
      // 手机重启：counter 归零，今日步数从头计
      try {
        uni.setStorageSync(SENSOR_KEY, { date: today, base: sensorTotal, detBase: detTotal })
      } catch (e) {}
      return 0
    }
    if (detTotal < (rec.detBase || 0)) {
      // App 重启：detector 归零，仅重设 det 基线，counter 分支继续
      rec.detBase = detTotal
      try {
        uni.setStorageSync(SENSOR_KEY, rec)
      } catch (e) {}
    }
    if (rec.base < 0 && sensorTotal >= 0) {
      // counter 首值晚到：从到达时刻补设基线
      rec.base = sensorTotal
      try {
        uni.setStorageSync(SENSOR_KEY, rec)
      } catch (e) {}
    }
    const counterDelta = rec.base >= 0 && sensorTotal >= rec.base ? sensorTotal - rec.base : 0
    const detDelta = detTotal >= (rec.detBase || 0) ? detTotal - (rec.detBase || 0) : 0
    return Math.max(counterDelta, detDelta)
  })
}

// 运动会话计步：返回两路统一口径的累计值（单调，供 delta 计步）。
// 传感器无数据时返回 -1（由运动页用懒基线兜底，区分「读取失败」与「真的 0 步」）。
export function getWorkoutSteps() {
  return readComposite()
}

// 临时诊断信息（真机排查用，定位后移除）
export function getStepDiag() {
  return {
    hasPlus: typeof plus !== 'undefined',
    permAsked: permRequested,
    sensorFound,
    detFound,
    registered: sensorRegistered,
    total: sensorTotal,
    det: detTotal,
    cb: counterEvents,
    ev: detEvents,
    comp: compositeTotal(),
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