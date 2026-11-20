// 本地存储层：封装 uni 同步存储，统一管理本应用的数据键
const KEYS = {
  userId: 'fh_user_id', // 匿名设备用户 id
  targets: 'fh_targets', // 每日目标
  records: 'fh_records', // 运动记录列表
  daily: 'fh_daily', // 按日期存储的当日统计
  weight: 'fh_weight', // 用户体重（kg），用于热量估算
  height: 'fh_height', // 用户身高（cm）
  age: 'fh_age', // 用户年龄（岁）
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

// 身高（cm），默认 170
export function getHeight() {
  const h = uni.getStorageSync(KEYS.height)
  return h > 50 && h < 250 ? h : 170
}

export function saveHeight(h) {
  uni.setStorageSync(KEYS.height, h)
}

// 年龄（岁），默认 25
export function getAge() {
  const a = uni.getStorageSync(KEYS.age)
  return Number.isFinite(a) && a > 0 && a < 120 ? a : 25
}

export function saveAge(a) {
  uni.setStorageSync(KEYS.age, a)
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

/**
 * 读**指定日期**的当日统计（`fh_daily_<date>`）。
 *
 * 与 getTodayData 的区别：那个只认"今天"（key 里写死 today()），做近 7 天看板时
 * 拿不到历史日期，7 天步数只能是 0 —— 这是从「我的」页搬看板时暴露的存储缺口。
 *
 * 约定：**没有记录返回 null，不要伪造一个全 0 对象**。
 * 伪造 0 会让"没走路的那些天"被当成真实数据，把日均拉低（看板里最难解释的一类假数据）。
 *
 * @param {string} date 'YYYY-MM-DD'
 * @returns {{date:string, steps:number, calories:number, duration:number}|null}
 */
export function getDailyByDate(date) {
  if (!date) return null
  let raw
  try {
    raw = uni.getStorageSync(KEYS.daily + '_' + date)
  } catch (e) {
    return null
  }
  if (!raw) return null
  let o = raw
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw)
    } catch (e) {
      return null
    }
  }
  if (!o || typeof o !== 'object') return null
  return {
    date: o.date || date,
    steps: Number(o.steps) || 0,
    calories: Number(o.calories) || 0,
    duration: Number(o.duration) || 0,
  }
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
