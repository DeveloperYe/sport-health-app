// 健康数据服务：平台差异能力（计步）尽量收敛在本模块
// - Android App（APP-PLUS）：plus.stepCounter 原生计步器
// - 微信小程序（MP-WEIXIN）：微信运动（scope.werun + 云端解密）
// - 其余平台（H5 等）：暂无计步能力，返回 0

// #ifdef APP-PLUS
// Android：读取今日步数。使用 plus.stepCounter 官方 API（getHistoryStepCount 取今天计数，
// 退化为 getCurrentStep 当前值），并兜底返回 0。
export function getTodaySteps() {
  return new Promise((resolve) => {
    const ok = (val) => resolve(val > 0 ? Number(val) : 0)

    // 设备不支持计步器 / 未勾选「计步器」模块时 plus.stepCounter 为空
    if (!plus || !plus.stepCounter) {
      ok(0)
      return
    }

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
// #endif

// #ifndef APP-PLUS
// #ifndef MP-WEIXIN
export function getTodaySteps() {
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