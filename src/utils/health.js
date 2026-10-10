// 健康数据服务：平台差异能力（计步）尽量收敛在本模块
// - Android App（APP-PLUS）：优先 plus.stepCounter（云打包模块），离线包降级系统计步传感器
// - 微信小程序（MP-WEIXIN）：微信运动（scope.werun + 云端解密）
// - 其余平台（H5 等）：暂无计步能力，返回 0

// #ifdef APP-PLUS
// Android：读取今日步数。
// 1) 优先 plus.stepCounter（DCloud 计步器模块，仅云打包/自定义基座可用）
// 2) 离线打包无该模块时，降级到系统计步传感器 TYPE_STEP_COUNTER
export async function getTodaySteps() {
  const moduleSteps = await readViaModule()
  if (moduleSteps > 0) return moduleSteps
  return sensorTodaySteps()
}

// 通过 DCloud 计步器模块读取（模块不存在 / 失败返回 0）
function readViaModule() {
  return new Promise((resolve) => {
    if (!plus || !plus.stepCounter) {
      resolve(0)
      return
    }
    ensureStepReady().then((ready) => {
      if (!ready) {
        resolve(0)
        return
      }
      const ok = (val) => resolve(val > 0 ? Number(val) : 0)
      // 优先按天历史步数，取最后一天（今天）
      if (typeof plus.stepCounter.getHistoryStepCount === 'function') {
        plus.stepCounter.getHistoryStepCount(
          (arr) => {
            if (Array.isArray(arr) && arr.length) {
              const last = arr[arr.length - 1]
              // 部分平台返回数字，部分返回 { value }
              const v = last && typeof last === 'object' ? last.value : last
              if (v > 0) return ok(v)
            }
            readCurrentStep(ok)
          },
          () => readCurrentStep(ok)
        )
      } else {
        readCurrentStep(ok)
      }
    })
  })
}

// Android 计步前置：确认有计步器模块 + 动态申请 ACTIVITY_RECOGNITION 权限 + 激活计步器。
// 任一失败返回 false（设备不支持 / 未勾选计步模块 / 用户拒绝授权）。
// 返回 true 表示可安全读取步数。
function ensureStepReady() {
  return new Promise((resolve) => {
    if (!plus || !plus.stepCounter) {
      resolve(false)
      return
    }

    requestActivityRecognition(() => startStepCounter(resolve))
  })
}

// 动态申请计步权限（Android 6.0+ 必需；授权结果进程内缓存，不重复弹）
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

// 激活计步器，成功后回调
function startStepCounter(done) {
  if (typeof plus.stepCounter.start !== 'function') {
    done()
    return
  }
  plus.stepCounter.start(
    () => done(),
    () => done() // 启动失败不阻塞，读取走兜底
  )
}

// 读取计步器当前累计值（兜底方案）
function readCurrentStep(ok) {
  if (typeof plus.stepCounter.getCurrentStep === 'function') {
    plus.stepCounter.getCurrentStep(
      (event) => ok(event && typeof event === 'object' ? event.value : event),
      () => ok(0)
    )
  } else {
    ok(0)
  }
}

// ===== 系统计步传感器降级（离线打包可用，无需 DCloud 计步模块） =====
// TYPE_STEP_COUNTER = 19（Android 4.4+ 标配），返回"开机以来累计步数"。
// 当日步数 = 当前累计 - 当日首次读取时的基线；手机重启后累计归零，检测到变小即重置基线。
const SENSOR_KEY = 'fh_step_sensor'
let sensorTotal = -1 // 监听到的最新系统累计步数
let sensorRegistered = false
let sensorManagerRef = null // 持有引用防 GC
let listenerRef = null

function ensureSensorListener() {
  if (sensorRegistered) return true
  try {
    const main = plus.android.runtimeMainActivity()
    const sm = main.getSystemService('sensor')
    plus.android.importClass(sm)
    const sensor = sm.getDefaultSensor(19) // SensorManager.TYPE_STEP_COUNTER
    if (!sensor) return false
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

// 当日步数估算（传感器口径）
function sensorTodaySteps() {
  return readSensorTotal().then((total) => {
    if (total < 0) return 0
    const today = todayStr()
    let rec = null
    try {
      rec = uni.getStorageSync(SENSOR_KEY)
    } catch (e) {}
    if (!rec || rec.date !== today || total < rec.base) {
      // 当日首次读取 / 手机重启：重置基线（此前未启动 App 的步数无法追溯）
      try {
        uni.setStorageSync(SENSOR_KEY, { date: today, base: total })
      } catch (e) {}
      return 0
    }
    return total - rec.base
  })
}

// 运动会话计步：读取"当前累计步数"，供会话内做 delta 计步（结束值 - 开始值 = 本场真实步数）。
// 口径一致性优先：模块存在就用模块口径（即使返回 0），否则用传感器口径，避免基线与终值不同尺度。
export async function getWorkoutSteps() {
  if (plus && plus.stepCounter) {
    return readViaModule()
  }
  const total = await readSensorTotal()
  return total > 0 ? total : 0
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