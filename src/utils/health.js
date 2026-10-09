// 健康数据服务：平台差异能力（计步）尽量收敛在本模块
// - 微信小程序：微信运动（scope.werun + 云端解密）
// - Android App：plus.stepCounter 原生计步器
// - 其余平台（H5 等）：暂无计步能力，返回 0

// #ifdef APP-PLUS
export function getTodaySteps() {
  return new Promise((resolve) => {
    if (!plus || !plus.stepCounter) {
      resolve(0)
      return
    }
    plus.stepCounter.getDailySteps(
      {},
      (res) => resolve(res && res.value ? Number(res.value) : 0),
      () => resolve(0)
    )
  })
}
// #endif

// #ifdef MP-WEIXIN
export function getTodaySteps() {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        const authed = res.authSetting && res.authSetting['scope.werun']
        if (authed) {
          readWeRun(resolve)
        } else {
          wx.authorize({
            scope: 'scope.werun',
            success: () => readWeRun(resolve),
            fail: () => resolve(0),
          })
        }
      },
      fail: () => resolve(0),
    })
  })
}

function readWeRun(resolve) {
  wx.getWeRunData({
    success: (res) => {
      wx.login({
        success: (loginRes) => {
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
