// uniCloud 封装：所有云端调用集中在这里，失败时静默降级，
// 保证「云空间未配置 / 断网」时本地功能不受影响
import { getUserId } from './storage.js'

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
