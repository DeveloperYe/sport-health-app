import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBackup,
  serializeBackup,
  parseBackup,
  trimBackup,
  mergeBackup,
  backupFileName,
  backupSummary,
  EXPORT_KEYS,
  EXCLUDED_KEYS,
  BACKUP_VERSION,
} from '../src/utils/backup.js'

const RAW = {
  fh_age: '28',
  fh_height: '175',
  fh_weight: '75',
  fh_body: { sex: 'male', bodyFat: 20, activity: 'medium' },
  fh_goals: { calorie: 1800, water: 8, weight: 70 },
  fh_targets: { steps: 8000, calorie: 300 },
  fh_weight_log: [{ d: '2026-11-20', w: 75 }, { d: '2026-11-10', w: 76.2 }],
  fh_records: [{ id: 'r1', date: '2026-11-20', type: 'run', calories: 200 }],
  fh_activity_days: { '2026-11-20': [{ id: 'a1', name: '游泳', met: 7, minutes: 30 }] },
  fh_diet_days: { '2026-11-20': { breakfast: [{ name: '包子', kcal: 200 }] } },
  fh_water_days: { '2026-11-20': 5 },
  fh_water_prefs: { cupMl: 250 },
  fh_theme_mode: 'auto',
}

test('导出白名单：只带用户记录，不带设备状态与账号口令', () => {
  const b = buildBackup({ ...RAW, fh_perms_v1: { a: 1 }, fh_accounts: [{ phone: '1', hash: 'h', salt: 's' }], fh_map_source_mode: 'whole' })
  assert.equal(b.data.fh_perms_v1, undefined, '权限不该跨机')
  assert.equal(b.data.fh_accounts, undefined, '账号口令哈希不该进备份文件')
  assert.equal(b.data.fh_map_source_mode, undefined, '设备级读法不该继承到新机')
  for (const k of Object.keys(b.data)) assert.ok(EXPORT_KEYS.includes(k), `白名单外的键：${k}`)
})

test('空值不写进文件（空数组/空对象/空串），省体积也让"有没有"可判', () => {
  const b = buildBackup({ fh_records: [], fh_body: {}, fh_age: '', fh_weight: '75' })
  assert.equal(b.data.fh_records, undefined)
  assert.equal(b.data.fh_body, undefined)
  assert.equal(b.data.fh_age, undefined)
  assert.equal(b.data.fh_weight, '75')
})

test('计数正确（导出侧）', () => {
  const b = buildBackup(RAW)
  assert.equal(b.version, BACKUP_VERSION)
  assert.equal(b.app, 'sport-health-app')
  assert.deepEqual(b.counts, { weightLog: 2, records: 1, activityDays: 1, dietDays: 1, waterDays: 1 })
})

test('序列化 → 解析 往返一致（这是导出/导入的主通路）', () => {
  const b = buildBackup(RAW)
  const back = parseBackup(serializeBackup(b))
  assert.equal(back.ok, true)
  assert.deepEqual(back.data, b.data)
  assert.deepEqual(back.counts, b.counts)
})

test('解析拒绝：空 / 非 JSON / 非本应用 / 版本过新 / 无数据段', () => {
  assert.equal(parseBackup('').ok, false)
  assert.equal(parseBackup('{oops').ok, false)
  assert.equal(parseBackup(JSON.stringify({ app: 'other', version: 1, data: {} })).reason, '不是本应用的备份文件')
  assert.equal(parseBackup(JSON.stringify({ app: 'sport-health-app', version: 99, data: { fh_age: '1' } })).ok, false)
  assert.equal(parseBackup(JSON.stringify({ app: 'sport-health-app', version: 1 })).reason, '缺少数据段')
  assert.equal(parseBackup(JSON.stringify({ app: 'sport-health-app', version: 1, data: {} })).reason, '备份里没有任何可导入的数据')
})

test('解析丢弃白名单外的键，但把它们列进 skipped 供界面提示', () => {
  const txt = JSON.stringify({ app: 'sport-health-app', version: 1, data: { fh_age: '30', fh_map_current: 'qingdao' } })
  const r = parseBackup(txt)
  assert.equal(r.ok, true)
  assert.equal(r.data.fh_age, '30')
  assert.equal(r.data.fh_map_current, undefined)
  assert.deepEqual(r.skipped, ['fh_map_current'])
})

test('裁剪：按天对象只留最近 60 天，体重日志同窗口', () => {
  const now = new Date(2026, 10, 20) // 2026-11-20
  const days = {}
  for (let i = 0; i < 90; i++) {
    const d = new Date(2026, 10, 20 - i)
    days[d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')] = i
  }
  const out = trimBackup({ fh_water_days: days, fh_weight_log: [{ d: '2026-11-20', w: 75 }, { d: '2026-01-01', w: 80 }] }, 60, now)
  assert.equal(Object.keys(out.fh_water_days).length, 60)
  assert.ok(out.fh_water_days['2026-11-20'] !== undefined)
  assert.equal(out.fh_water_days['2026-01-01'], undefined)
  assert.equal(out.fh_weight_log.length, 1, '2026-01-01 的体重也要被裁掉')
})

test('合并：普通键以备份覆盖，按天对象做并集（不能把近期数据抹掉）', () => {
  const cur = { fh_weight: '80', fh_water_days: { '2026-11-19': 3, '2026-11-20': 4 } }
  const inc = { fh_weight: '75', fh_water_days: { '2026-11-18': 1 } }
  const out = mergeBackup(cur, inc)
  assert.equal(out.fh_weight, '75', '恢复应以备份为准')
  assert.equal(out.fh_water_days['2026-11-19'], 3, '备份里没有的近期天不能被抹掉')
  assert.equal(out.fh_water_days['2026-11-18'], 1, '备份里的天要并进来')
})

test('文件名带日期时间，避免多次导出互相覆盖；H5 与 App 都能用', () => {
  const n = backupFileName(new Date(2026, 10, 20, 9, 5))
  assert.equal(n, 'sport-health-20261120-0905.json')
})

test('摘要只列有数据的项，没有数据时给明确说法', () => {
  assert.equal(backupSummary(buildBackup(RAW)), '体重 2 条 · 运动 1 条 · 其他运动 1 天 · 饮食 1 天 · 饮水 1 天')
  assert.equal(backupSummary(buildBackup({})), '没有可导出的记录')
})

test('排除清单里没有重复，且与导出清单不重叠（防止两边同时加同一个键）', () => {
  assert.equal(new Set(EXCLUDED_KEYS).size, EXCLUDED_KEYS.length)
  for (const k of EXCLUDED_KEYS) assert.ok(!EXPORT_KEYS.includes(k), `${k} 同时出现在两个清单里`)
})
