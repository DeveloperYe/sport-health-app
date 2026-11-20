/**
 * 原生计步桥（App 端）：调用 android 工程里的 StepCounter。
 *
 * 设计原则：
 *   - **原生优先，缺失降级**：类找不到（H5、旧包、或还没编译进 APK）时不报错，
 *     由 health.js 退回原来的 JS 实现；
 *   - 只读一个数字（毫秒级），不再像旧实现那样"注册监听→等首值→3 秒超时"；
 *   - 读不到时返回 -1（不是 0），调用方应沿用上次已知值，避免界面闪成 0。
 *
 * 与原生侧约定的接口（com.developerye.sporthealth.StepCounter）：
 *   static boolean start(Context)      注册传感器监听（幂等）
 *   static int     getTodaySteps(Context) -1=未就绪
 *   static String  getBranchesJson(Context) {"counter":N,"det":N,"ok":bool,"err":"..."}
 *   static String  getDiagJson(Context)
 *   static void    ensureService(Context) 起常驻服务 + 排零点闹钟
 */

const CLASS = 'com.developerye.sporthealth.StepCounter'

let cls = null
let ctx = null
let unavailable = false
let started = false

/** 懒加载原生类；不可用就永久标记，避免反复抛异常 */
function load() {
  if (cls) return cls
  if (unavailable) return null
  try {
    if (typeof plus === 'undefined' || !plus.android || !plus.android.importClass) {
      unavailable = true
      return null
    }
    ctx = plus.android.runtimeMainActivity()
    if (!ctx) {
      unavailable = true
      return null
    }
    cls = plus.android.importClass(CLASS)
    if (!cls) {
      unavailable = true
      return null
    }
    return cls
  } catch (e) {
    unavailable = true
    return null
  }
}

/** 原生计步是否可用 */
export function nativeStepsAvailable() {
  return !!load()
}

/** 起常驻服务 + 排零点闹钟 + 注册监听（幂等，失败不影响读取） */
export function nativeStepsEnsure() {
  const c = load()
  if (!c) return false
  if (started) return true
  try {
    c.ensureService(ctx)
  } catch (e) {
    /* ignore */
  }
  try {
    c.start(ctx)
  } catch (e) {
    /* ignore */
  }
  started = true
  return true
}

/** 今日步数：>=0 直接用；-1 表示原生还没就绪 */
export function nativeTodaySteps() {
  const c = load()
  if (!c) return -1
  nativeStepsEnsure()
  try {
    const v = Number(c.getTodaySteps(ctx))
    return Number.isFinite(v) ? v : -1
  } catch (e) {
    return -1
  }
}

/** 两路原始读数 {ok, counter, det}；不可用时 ok=false */
export function nativeBranches() {
  const c = load()
  if (!c) return { ok: false, counter: -1, det: 0, err: 'no-native' }
  nativeStepsEnsure()
  try {
    const raw = c.getBranchesJson(ctx)
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      ok: !!(o && o.ok),
      counter: Number(o && o.counter),
      det: Number(o && o.det),
      err: (o && o.err) || '',
    }
  } catch (e) {
    return { ok: false, counter: -1, det: 0, err: String((e && e.message) || e) }
  }
}

/** 诊断信息（真机排查用） */
export function nativeDiag() {
  const c = load()
  if (!c) return { available: false }
  try {
    const raw = c.getDiagJson(ctx)
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Object.assign({ available: true }, o || {})
  } catch (e) {
    return { available: true, err: String((e && e.message) || e) }
  }
}

/** 轮询等原生就绪（首次冷启动传感器要几百毫秒）；超时返回 null */
export function nativeTodayStepsWait(timeoutMs) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 1500
  if (!nativeStepsAvailable()) return Promise.resolve(null)
  const t0 = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const v = nativeTodaySteps()
      if (v >= 0) {
        resolve(v)
        return
      }
      if (Date.now() - t0 > limit) {
        resolve(null)
        return
      }
      setTimeout(tick, 80)
    }
    tick()
  })
}
