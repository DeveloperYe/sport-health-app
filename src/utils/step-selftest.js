/**
 * 计步自检：一键把「步数为什么不动」摊开。
 *
 * 步数由两条链路提供：
 *   ① App 端原生常驻服务（android/.../StepCounter.java，test-87 起）
 *   ② JS 传感器兜底（只有 App 在前台时才计）
 * 失效原因很多、表现却一样（都是 0）：服务被杀、权限被收回、重启后 BOOT_COMPLETED 被拦、
 * 传感器无数据、跨天基线算错。只看「0」区分不出来，所以这里输出一行结构化诊断并直接给判定。
 *
 * 分两半：
 *   buildStepReport(facts)  纯函数，只做判定与拼串 —— node --test 全覆盖
 *   collectStepFacts()      采集真值（依赖 uni/plus），只在 App 内调用
 *
 * 字段来源（原生 getDiagJson，见 StepCounter.java）：
 *   registered 监听是否注册 / counter 计步传感器累计 / det 检测器累计 / cb 计步回调次数 /
 *   ev 检测器事件次数 / base 当日基线 / lastRaw 上次原始读数 / offset 当日偏移 / date 归属日期
 *   今日步数 = fBase 之后的累计（滚动到新一天时 base 取零点附近读数）
 */

/** 结论码 → 人能看懂的说法 */
export const VERDICTS = {
  ok: '正常：今日步数有值',
  'no-app': 'H5 环境没有原生计步 —— 步数要真机才有，这是设计不是故障',
  'native-unavailable': '原生计步不可用，已降级 JS 传感器（只有开着 App 才计）',
  'not-registered': '原生监听没注册上 —— 服务没起来或传感器权限被收回',
  'no-events': '监听在、但本次进程一条事件都没收到 —— 走几步再看，仍为 0 就是服务被杀或权限被收',
  'zero-today': '两路读数都在涨，但今日步数为 0 —— 基线/跨天解算有问题（把这一行发我）',
  'stale-store': '今日步数为 0，但当天存档有值 —— 读取链路或跨天清理不一致（把这一行发我）',
  'date-drift': '原生归属日期与系统日期不一致 —— 零点滚动没生效（把这一行发我）',
  unknown: '数据不完整，不足以判定（把这一行发我）',
}

/**
 * @param {object} f
 * @param {'app'|'h5'} f.platform
 * @param {boolean} f.nativeAvailable
 * @param {boolean|null} f.registered   监听是否注册
 * @param {number|null} f.cb            计步传感器回调次数
 * @param {number|null} f.ev            检测器事件次数
 * @param {number|null} f.counter       计步传感器原始累计
 * @param {number|null} f.det           检测器原始累计
 * @param {number|null} f.comp          复合今日值（两路合并，-1=未就绪）
 * @param {number|null} f.base          当日基线
 * @param {number|null} f.lastRaw       上次原始读数
 * @param {number|null} f.offset        当日偏移
 * @param {string|null} f.date          原生归属日期
 * @param {string|null} f.sysDate       系统日期
 * @param {number|null} f.today         今日步数（getTodaySteps 结果）
 * @param {number|null} f.stored        当天存档 steps
 * @param {string|null} f.err
 * @returns {{verdict:string, verdictText:string, line:string}}
 */
export function buildStepReport(f = {}) {
  const platform = f.platform === 'app' ? 'app' : 'h5'
  const verdict = decide({ ...f, platform })
  const parts = ['平台:' + platform, '原生:' + (f.nativeAvailable ? 'ok' : 'no')]
  if (platform === 'app' && f.nativeAvailable) {
    parts.push('注册:' + tri(f.registered))
    parts.push('事件:' + nn(f.cb) + '/' + nn(f.ev))
    parts.push('读数:' + nn(f.counter) + '/' + nn(f.det))
    parts.push('复合:' + nn(f.comp))
    parts.push('基线:' + nn(f.base))
    parts.push('原始:' + nn(f.lastRaw))
    parts.push('偏移:' + nn(f.offset))
    parts.push('日期:' + (f.date || '?') + (f.sysDate ? '/' + f.sysDate : ''))
  }
  parts.push('今日:' + nn(f.today))
  parts.push('存档:' + nn(f.stored))
  parts.push('判定:' + verdict)
  if (f.err) parts.push('err:' + String(f.err).slice(0, 40))
  return { verdict, verdictText: VERDICTS[verdict] || VERDICTS.unknown, line: parts.join(' ') }
}

function tri(v) {
  return v === true ? '1' : v === false ? '0' : '?'
}

function nn(v) {
  return typeof v === 'number' && isFinite(v) ? String(v) : '?'
}

/** 判定优先级：先排除环境，再看事件量，再看数据一致性，最后才怀疑解算 */
function decide(f) {
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null)
  const today = n(f.today)
  const stored = n(f.stored)
  const cb = n(f.cb) || 0
  const ev = n(f.ev) || 0
  const counter = n(f.counter)
  const det = n(f.det)
  const comp = n(f.comp)

  if (f.platform !== 'app') return 'no-app'
  if (!f.nativeAvailable) return 'native-unavailable'
  if (f.registered === false) return 'not-registered'
  if (f.registered === true && cb + ev === 0) return 'no-events'
  // 日期漂移比步数为 0 更隐蔽：先抓
  if (f.date && f.sysDate && f.date !== f.sysDate) return 'date-drift'
  if (today === 0) {
    if (stored !== null && stored > 0) return 'stale-store'
    const rawAlive = (counter !== null && counter > 0) || (det !== null && det > 0) || (comp !== null && comp > 0)
    if (rawAlive) return 'zero-today'
    return 'no-events'
  }
  if (today !== null && today > 0) return 'ok'
  return 'unknown'
}

/** 采集真值（仅 App 内可用；任何一步失败都降级为 null，绝不抛） */
export async function collectStepFacts() {
  const facts = { platform: 'h5', nativeAvailable: false, today: null, stored: null }
  try {
    // #ifdef APP-PLUS
    facts.platform = 'app'
    const [nativeMod, health, storage] = await Promise.all([
      import('./native-steps.js'),
      import('./health.js'),
      import('./storage.js'),
    ])
    facts.nativeAvailable = !!nativeMod.nativeStepsAvailable()
    if (facts.nativeAvailable) {
      try {
        nativeMod.nativeStepsEnsure() // 服务没起就顺手拉起：自检本身也算一次修复尝试
      } catch (e) {
        facts.err = 'ensure:' + ((e && e.message) || e)
      }
      const d = nativeMod.nativeDiag() || {}
      facts.registered = d.registered === undefined ? null : !!d.registered
      facts.cb = numOrNull(d.cb)
      facts.ev = numOrNull(d.ev)
      facts.counter = numOrNull(d.counter)
      facts.det = numOrNull(d.det)
      facts.comp = numOrNull(d.comp)
      facts.base = numOrNull(d.base)
      facts.lastRaw = numOrNull(d.lastRaw)
      facts.offset = numOrNull(d.offset)
      facts.date = d.date || null
      if (d.err) facts.err = d.err
    }
    facts.today = Number(await health.getTodaySteps()) || 0
    const daily = storage.getTodayData() || {}
    facts.stored = Number(daily.steps) || 0
    facts.sysDate = (daily && daily.date) || null
    // #endif
  } catch (e) {
    facts.err = (e && e.message) || String(e)
  }
  return facts
}

function numOrNull(v) {
  const n = Number(v)
  return isFinite(n) ? n : null
}
