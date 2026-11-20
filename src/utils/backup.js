/**
 * 数据备份：**文件**，不是剪贴板。
 *
 * 背景：原来「我的」页的备份是「导出到剪贴板 / 从剪贴板导入」，用户评价「方式太低劣」，
 * 卡片被删掉。但删掉之后换机就真的没法迁移数据了（云同步后端还没接），
 * 所以这里补一条正经的迁移通路：整包 JSON 文件。
 *
 * 设计取舍：
 *   ① 只导出「用户的记录」，不导出设备本地状态（地图缓存、权限授予、Range 探测记忆、
 *      用户 id、会话 token）—— 那些搬到另一台手机上不仅无用，还可能有害
 *      （例如把旧机的 map_source_mode=whole 带过去，新机就不会按需读取了）。
 *   ② 带 version + 导出时间 + 计数，导入时先校验再写，写之前不破坏现有数据。
 *   ③ 日期键（fh_daily_* / 按天存的对象）要**裁剪**：只保留最近 N 天，
 *      否则一年后单文件几十 MB。裁剪在导入侧做，导出侧保留原样（用户可能只想存档）。
 *
 * 本文件是纯逻辑（不碰 uni/plus）：序列化、解析、校验、裁剪、合并都在这里，
 * 读写在 backup-native.js 里。这样 node --test 能全覆盖。
 */

export const BACKUP_VERSION = 1

/** 导出的键（白名单，新增存储键要手动加进来，避免把设备状态误传） */
export const EXPORT_KEYS = [
  'fh_user_id', // 匿名用户 id：保留它，云端 syncDaily 才认得出是同一台设备
  'fh_age',
  'fh_height',
  'fh_weight',
  'fh_body',
  'fh_goals',
  'fh_targets',
  'fh_weight_log',
  'fh_records',
  'fh_activity_days',
  'fh_diet_days',
  'fh_water_days',
  'fh_water_prefs',
  'fh_water_last',
  'fh_theme_mode',
]

/** 明确不导出的键（写成常量是为了让"为什么不导"这件事留在代码里） */
export const EXCLUDED_KEYS = [
  'fh_accounts', // 账号与口令哈希不上文件：备份文件可能被转发
  'fh_session',
  'fh_perms_v1', // 权限授予是每台设备各自的
  'fh_map_installed',
  'fh_map_current',
  'fh_map_source_mode', // 设备级性能适配，不该跨机继承
  'fh_map_mirror_v1',
  'fh_map_range_bad_v1',
  'fh_map_read_probe_v1',
  'fh_step_sensor', // 计步校准基线属于设备传感器
]

/** 按天存的对象键：导入时裁到最近 N 天 */
const DAY_MAP_KEYS = ['fh_activity_days', 'fh_diet_days', 'fh_water_days']
export const KEEP_DAYS = 60

/**
 * @param {Record<string, any>} raw key → 值（导出侧已从存储读出的原始对象）
 * @param {string} exportedAt ISO 时间
 * @returns {{version:number, exportedAt:string, app:string, counts:object, data:object}}
 */
export function buildBackup(raw = {}, exportedAt = new Date().toISOString()) {
  const data = {}
  const counts = {}
  for (const k of EXPORT_KEYS) {
    const v = raw[k]
    if (v === undefined || v === null || v === '') continue
    // 空数组 / 空对象不写进文件：省体积，也让"有没有这条"可判
    if (Array.isArray(v) && !v.length) continue
    if (isPlainObject(v) && !Object.keys(v).length) continue
    data[k] = v
  }
  counts.weightLog = Array.isArray(data.fh_weight_log) ? data.fh_weight_log.length : 0
  counts.records = Array.isArray(data.fh_records) ? data.fh_records.length : 0
  counts.activityDays = data.fh_activity_days ? Object.keys(data.fh_activity_days).length : 0
  counts.dietDays = data.fh_diet_days ? Object.keys(data.fh_diet_days).length : 0
  counts.waterDays = data.fh_water_days ? Object.keys(data.fh_water_days).length : 0
  return {
    version: BACKUP_VERSION,
    exportedAt,
    app: 'sport-health-app',
    counts,
    data,
  }
}

/** 序列化：带缩进便于用户肉眼检查（体积换可读性，几十 KB 级别不成问题） */
export function serializeBackup(backup) {
  return JSON.stringify(backup, null, 2)
}

/**
 * 解析 + 校验。**任何一步不对都返回 {ok:false, reason}**，绝不让半个包进存储。
 * @param {string} text
 */
export function parseBackup(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return { ok: false, reason: '内容是空的' }
  let o
  try {
    o = JSON.parse(s)
  } catch (e) {
    return { ok: false, reason: '不是合法的 JSON' }
  }
  if (!o || typeof o !== 'object') return { ok: false, reason: '格式不是对象' }
  if (o.app !== 'sport-health-app') return { ok: false, reason: '不是本应用的备份文件' }
  const ver = Number(o.version)
  if (!ver || ver > BACKUP_VERSION) return { ok: false, reason: '备份版本太新，当前版本读不了（' + (o.version || '?') + '）' }
  if (!o.data || typeof o.data !== 'object') return { ok: false, reason: '缺少数据段' }
  const data = {}
  for (const k of EXPORT_KEYS) {
    if (o.data[k] !== undefined && o.data[k] !== null) data[k] = o.data[k]
  }
  if (!Object.keys(data).length) return { ok: false, reason: '备份里没有任何可导入的数据' }
  const skipped = Object.keys(o.data).filter((k) => !EXPORT_KEYS.includes(k))
  return {
    ok: true,
    version: ver,
    exportedAt: o.exportedAt || '',
    data,
    skipped,
    counts: countOf(data),
  }
}

/** 裁剪：按天对象只留最近 keepDays 天；数组型（体重日志）也只留该窗口 */
export function trimBackup(data = {}, keepDays = KEEP_DAYS, now = new Date()) {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (keepDays - 1))
  const cut = dateStr(cutoff)
  const out = { ...data }
  for (const k of DAY_MAP_KEYS) {
    const m = out[k]
    if (!isPlainObject(m)) continue
    const kept = {}
    for (const d of Object.keys(m)) {
      if (d >= cut) kept[d] = m[d]
    }
    out[k] = kept
  }
  if (Array.isArray(out.fh_weight_log)) {
    out.fh_weight_log = out.fh_weight_log.filter((x) => x && (x.d || x.date) >= cut)
  }
  return out
}

/**
 * 合并策略：**以备份为准覆盖**同名键（用户导入就是想恢复），
 * 但按天对象做**并集**（备份里没有的近期数据不能被抹掉 —— 那是"恢复"变成"丢数据"）。
 */
export function mergeBackup(current = {}, incoming = {}) {
  const out = { ...current }
  for (const k of Object.keys(incoming)) {
    if (DAY_MAP_KEYS.includes(k) && isPlainObject(current[k]) && isPlainObject(incoming[k])) {
      out[k] = { ...current[k], ...incoming[k] }
    } else {
      out[k] = incoming[k]
    }
  }
  return out
}

function countOf(data) {
  return {
    weightLog: Array.isArray(data.fh_weight_log) ? data.fh_weight_log.length : 0,
    records: Array.isArray(data.fh_records) ? data.fh_records.length : 0,
    activityDays: data.fh_activity_days ? Object.keys(data.fh_activity_days).length : 0,
    dietDays: data.fh_diet_days ? Object.keys(data.fh_diet_days).length : 0,
    waterDays: data.fh_water_days ? Object.keys(data.fh_water_days).length : 0,
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function dateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 文件名：带上日期与时间，避免多次导出互相覆盖 */
export function backupFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return 'sport-health-' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + '-' + p(now.getHours()) + p(now.getMinutes()) + '.json'
}

/** 给界面用的一句话摘要 */
export function backupSummary(backup) {
  const c = (backup && backup.counts) || {}
  const bits = []
  if (c.weightLog) bits.push('体重 ' + c.weightLog + ' 条')
  if (c.records) bits.push('运动 ' + c.records + ' 条')
  if (c.activityDays) bits.push('其他运动 ' + c.activityDays + ' 天')
  if (c.dietDays) bits.push('饮食 ' + c.dietDays + ' 天')
  if (c.waterDays) bits.push('饮水 ' + c.waterDays + ' 天')
  return bits.length ? bits.join(' · ') : '没有可导出的记录'
}
