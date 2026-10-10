// uniCloud 封装：所有云端调用集中在这里，失败时静默降级，
// 保证「云空间未配置 / 断网」时本地功能不受影响
import { getUserId, getTodayData, saveTodayData, getWeight } from './storage.js'
import { getTodaySteps, calcCaloriesBySteps } from './health.js'

function call(name, data) {
  return new Promise((resolve) => {
    uniCloud
      .callFunction({ name, data: { ...data, userId: getUserId() } })
      .then((res) => resolve({ ok: true, result: res.result }))
      .catch((err) => resolve({ ok: false, err }))
  })
}

// 双端同步核心：把当日统计 + 一条运动记录推到云端
export function syncDaily(daily, record) {
  return call('sync-data', { action: 'sync', daily, record })
}

// 从云端拉取统计与运动记录（我的页「手动同步」用）
export function fetchCloudData() {
  return call('sync-data', { action: 'get' })
}

// 应用启动时自动同步今日步数：
// - Android：读原生计步器（内部会动态申请权限 + 激活计步器）
// - 微信小程序：已授权微信运动则静默读取；未授权返回 0，由首页引导入口处理，不弹窗
export async function autoSyncSteps() {
  const steps = await getTodaySteps()
  if (!(steps > 0)) return
  const daily = getTodayData()
  if (steps > (daily.steps || 0)) {
    daily.steps = steps
    daily.calories = calcCaloriesBySteps(steps, getWeight())
    saveTodayData(daily)
    syncDaily(daily, null)
  }
}
