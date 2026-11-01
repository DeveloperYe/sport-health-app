// GPS 轨迹采集：把平台差异收敛在本模块
//
// - App（APP-PLUS）：uni.startLocationUpdate({ type: 'wgs84' })
//   → 运行时透传 plus.geolocation.watchPosition({ coordsType: 'wgs84' })
//   → Android 系统定位，不需要地图厂商 key（这是"离线"能成立的前提）
// - H5：同一套 uni API（浏览器 Geolocation，本身就是 wgs84），本地预览可验证
// - 微信小程序：同一套 uni API；需在 manifest 的 mp-weixin 里声明
//   requiredPrivateInfos: ['startLocationUpdate', 'onLocationChange']
//
// ⚠️ type 必须显式传 'wgs84'：运行时在校验失败时会默认成 'gcj02'，
//    而 gcj02 需要三方定位 SDK + key，打包后会定位不准/失败。
//
// 已知限制（v1 明确不做，留待后续）：
// - 锁屏继续记录依赖前台服务（见 utils/keepalive.js + 原生 MotionKeepAliveService），
//   服务已接上，但各厂商 ROM 的省电策略仍需真机验证；进程被系统强杀仍会丢当前段轨迹
//   （未做增量落盘）。

import { haversine, simplify } from './geo.js'
import { startKeepAlive, stopKeepAlive } from './keepalive.js'

// 采样过滤阈值（GPS 原始点噪声很大，必须过滤，否则距离会虚高几十个百分点）
const MAX_ACCURACY = 50 // 精度（米）差于此的点直接丢弃：飘移主要来源
const MIN_MOVE = 3 // 与上一点距离小于此（米）视为静止抖动
const MAX_SPEED = 12 // 瞬时速度上限（m/s ≈ 43km/h）：跑步不可能，视为跳点
const FORCE_KEEP_GAP = 30000 // 与上一点间隔超过此（ms）视为中断，跳过 MIN_MOVE 检查

let track = null // 当前会话状态；null = 未在采集
let watcher = null // 平台监听句柄标记
let listeners = []

const now = () => Date.now()

function newTrack() {
  return {
    points: [],
    distance: 0,
    startedAt: now(),
    segStart: now(), // 本段（未暂停）起点时刻
    accumMs: 0, // 之前各段累计时长
    paused: false,
    rejected: 0, // 被过滤掉的点数（诊断用）
    lastError: '', // 最近一次定位错误（含瞬时错误，只做诊断）
    error: '', // 面向用户的失败提示：只有「一个点都没拿到」时才有值
  }
}

export function isTracking() {
  return !!track
}

// 本场已运动时长（毫秒），不含暂停时间
export function elapsedMs() {
  if (!track) return 0
  return track.accumMs + (track.paused ? 0 : now() - track.segStart)
}

// 当前轨迹快照（给 UI 用；points 为过滤后的有效点）
export function getTrack() {
  if (!track) return null
  return {
    points: track.points,
    distance: track.distance,
    elapsedMs: elapsedMs(),
    pointCount: track.points.length,
    rejected: track.rejected,
    error: track.error,
  }
}

// 订阅轨迹变化，返回退订函数
export function onTrackUpdate(cb) {
  listeners.push(cb)
  return () => {
    listeners = listeners.filter((f) => f !== cb)
  }
}

function emit() {
  const snap = getTrack()
  for (const f of listeners) {
    try {
      f(snap)
    } catch (e) {}
  }
}

// #ifdef APP-PLUS
let permAsked = false
function requestPermission() {
  return new Promise((resolve) => {
    if (permAsked) {
      resolve(true)
      return
    }
    try {
      plus.android.requestPermissions(
        [
          'android.permission.ACCESS_FINE_LOCATION',
          'android.permission.ACCESS_COARSE_LOCATION',
        ],
        () => {
          permAsked = true
          resolve(true)
        },
        () => {
          permAsked = true
          resolve(false) // 拒绝也放行，由 fail 回调告知 UI
        }
      )
    } catch (e) {
      resolve(false)
    }
  })
}
// #endif

// #ifndef APP-PLUS
// H5 / 小程序由系统或平台自己弹授权框
function requestPermission() {
  return Promise.resolve(true)
}
// #endif

// 收一个原始定位点，按阈值过滤后并入轨迹
function accept(c) {
  if (!track || track.paused) return
  const lat = Number(c && c.latitude)
  const lng = Number(c && c.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return

  const accuracy = Number(c.accuracy) || 0
  if (accuracy > MAX_ACCURACY) {
    track.rejected++
    return
  }

  const ts = now()
  const pt = { lat, lng, accuracy, ts }
  const alt = Number(c.altitude)
  if (Number.isFinite(alt)) pt.altitude = alt
  const spd = Number(c.speed)
  if (Number.isFinite(spd) && spd >= 0) pt.speed = spd

  const last = track.points[track.points.length - 1]
  if (last) {
    const gap = ts - last.ts
    const d = haversine(last, pt)
    if (gap < FORCE_KEEP_GAP) {
      if (d < MIN_MOVE) {
        track.rejected++ // 原地抖动：GPS 静止时也会持续吐点
        return
      }
      if (gap > 0 && d / (gap / 1000) > MAX_SPEED) {
        track.rejected++ // 跳点
        return
      }
    }
    track.distance += d
  }

  track.points.push(pt)
  // 已经拿到有效点 = 定位是通的，清掉之前的失败提示
  track.error = ''
  emit()
}

function onChange(res) {
  accept(res)
}

// 定位错误回调：H5/小程序的 startLocationUpdate 只等 100ms 就 resolve，
// 真正的失败（权限被拒、无信号、非安全源）全部从这里来。
// 不订阅它的话，UI 会永远停在「等待 GPS 定位…」，用户完全不知道出了什么事。
function onChangeError(e) {
  if (!track) return
  const msg = (e && (e.errMsg || e.message)) || '定位失败'
  track.lastError = msg
  // ⚠️ 只在「一个点都没拿到」时才把它当失败展示。
  // 位置源切换等情况会吐出瞬时错误，用它覆盖正常状态会把用户的
  // 轨迹页变成报错页——实测就踩过（184 米轨迹旁边挂着 onLocationChange:fail）。
  if (track.points.length) return
  track.error = '定位失败：请确认已授权定位权限并打开手机 GPS（' + msg + '）'
  emit()
}

function startWatch() {
  if (watcher) return
  try {
    uni.onLocationChange(onChange)
    uni.onLocationChangeError(onChangeError)
    // type 必须显式传 wgs84（见文件头说明），否则运行时默认成 gcj02
    uni.startLocationUpdate({
      type: 'wgs84',
      fail: (e) => {
        if (track) track.error = '开启定位失败：' + ((e && (e.errMsg || e.message)) || '未知')
        emit()
      },
    })
    watcher = 'uni'
  } catch (e) {
    if (track) track.error = String((e && e.message) || e)
    emit()
  }
}

function stopWatch() {
  if (!watcher) return
  try {
    uni.offLocationChange(onChange)
  } catch (e) {}
  try {
    uni.offLocationChangeError(onChangeError)
  } catch (e) {}
  try {
    uni.stopLocationUpdate({})
  } catch (e) {}
  watcher = null
}

// 开始采集。已有会话时直接返回当前快照（幂等）。
export async function startTrack() {
  if (track) return getTrack()
  const granted = await requestPermission()
  track = newTrack()
  if (!granted) track.error = '定位权限被拒绝，请在系统设置里为「运动健康」开启定位'
  // 挂前台服务：锁屏/切后台时系统才肯继续给定位回调（Android 8+ 硬性要求）
  startKeepAlive()
  startWatch()
  emit()
  return getTrack()
}

export function pauseTrack() {
  if (!track || track.paused) return
  track.accumMs += now() - track.segStart
  track.paused = true
  emit()
}

export function resumeTrack() {
  if (!track || !track.paused) return
  track.segStart = now()
  track.paused = false
  emit()
}

// 结束采集，返回可入账的轨迹结果。不在采集状态返回 null。
export function stopTrack() {
  if (!track) return null
  stopWatch()
  // 撤掉前台服务（否则"正在记录运动"的通知会一直留在通知栏）
  stopKeepAlive()
  if (!track.paused) track.accumMs += now() - track.segStart
  const t = track
  track = null
  listeners = []
  return {
    points: t.points, // 原始有效点
    track: simplify(t.points, 5), // 抽稀后用于存储/上云
    distance: t.distance,
    durationMs: t.accumMs,
    pointCount: t.points.length,
    rejected: t.rejected,
    error: t.error,
  }
}

// 不结束会话但取一次结果（用于 UI 展示）
export function currentResult() {
  if (!track) return null
  return {
    points: track.points,
    track: simplify(track.points, 5),
    distance: track.distance,
    durationMs: elapsedMs(),
    pointCount: track.points.length,
    rejected: track.rejected,
    error: track.error,
  }
}
