// 本地存储层：封装 uni 同步存储，统一管理本应用的数据键
const KEYS = {
  userId: 'fh_user_id', // 匿名设备用户 id
  targets: 'fh_targets', // 每日目标
  records: 'fh_records', // 运动记录列表
  daily: 'fh_daily', // 按日期存储的当日统计
  weight: 'fh_weight', // 用户体重（kg），用于热量估算
}

function today() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// 生成一个匿名用户 id（无登录体系时用于区分设备 / 云端归属）
export function getUserId() {
  let id = uni.getStorageSync(KEYS.userId)
  if (!id) {
    id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    uni.setStorageSync(KEYS.userId, id)
  }
  return id
}

export function getTargets() {
  const t = uni.getStorageSync(KEYS.targets)
  return t || { steps: 8000, calorie: 300 }
}

export function saveTargets(t) {
  uni.setStorageSync(KEYS.targets, t)
}

// 体重（kg），默认 60，用于热量估算
export function getWeight() {
  const w = uni.getStorageSync(KEYS.weight)
  return w > 30 && w < 300 ? w : 60
}

export function saveWeight(w) {
  uni.setStorageSync(KEYS.weight, w)
}

export function getTodayData() {
  const key = KEYS.daily + '_' + today()
  return (
    uni.getStorageSync(key) || {
      date: today(),
      steps: 0,
      calories: 0,
      duration: 0,
      lastSyncAt: '',
    }
  )
}

export function saveTodayData(d) {
  uni.setStorageSync(KEYS.daily + '_' + today(), d)
}

export function getRecords() {
  return uni.getStorageSync(KEYS.records) || []
}

export function saveRecords(list) {
  uni.setStorageSync(KEYS.records, list.slice(0, 50))
}

export function addRecord(rec) {
  const list = getRecords()
  list.unshift(rec)
  saveRecords(list)
  return rec
}

export function removeRecord(id) {
  saveRecords(getRecords().filter((r) => r.id !== id))
}
