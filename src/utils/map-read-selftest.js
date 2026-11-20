/**
 * 「底图读取自检」：逐条回答「这台机器上 PMTiles 是按需读还是整包读」。
 *
 * 为什么单独成文件：
 *   - `city-map-download.js` 已经 1000+ 行，再塞会很难读；
 *   - 这个自检要同时碰「逻辑层能测的」（R2 桥接、R3 整包路径）与
 *     「只有视图层能测的」（R1 fetch(file://)）——后者测不了，只能读视图层上次建图时
 *     写进 storage 的实测记录（`fh_map_read_probe_v1`）。
 *
 * 输出行有**稳定前缀**，自动化脚本按文本断言，不依赖 UI 结构：
 *   `R1:` / `R2:` / `R3:` / `生效:` / `rd:` / `策略:` / `结论:`
 */
import {
  getCity,
  getCurrent,
  getInstalled,
  getInstalledPath,
  getSourceMode,
  isRangeBad,
  listRangeBad,
  getReadProbe,
  setSourceMode,
  clearRangeBad,
  formatBytes,
} from './city-maps.js'
import { openRangeHandle, readRangeB64, magic7Ok, tileWww } from '../components/map-view/tiles.js'

function hasPlus() {
  try {
    return typeof plus !== 'undefined' && !!plus.io
  } catch (e) {
    return false
  }
}

/** 当前该读哪个包：与 map-view 的 resolveArchives 同规则（装了城市包就用它） */
function currentPack() {
  const cur = getCurrent()
  const inst = getInstalled()
  if (cur && inst[cur]) {
    const c = getCity(cur)
    return {
      adcode: cur,
      name: (c && c.name) || cur,
      rel: getInstalledPath(cur) || '',
      wantBytes: Number((inst[cur] && inst[cur].bytes) || 0),
      bundled: false,
    }
  }
  return {
    adcode: 'builtin',
    name: '内置青岛包',
    rel: tileWww('qingdao-all.pmtiles'),
    wantBytes: 0,
    bundled: true,
  }
}

/**
 * @param {{onLines?:(lines:string[])=>void}} [opts]
 * @returns {Promise<{lines:string[], mode:string, r1:string, r2:string}>}
 */
export async function readRangeSelfTest(opts) {
  const o = opts || {}
  const lines = []
  const push = (s) => {
    lines.push(s)
    if (o.onLines) {
      try {
        o.onLines(lines.slice())
      } catch (e) {
        /* ignore */
      }
    }
    return s
  }

  const app = hasPlus()
  const pack = currentPack()
  push('策略: ' + (getSourceMode() || '(未设置 → 用代码常量 auto)') + '　包: ' + pack.name)

  // ===== R1：只有视图层能测，读上次建图的实测记录 =====
  const probe = getReadProbe()
  let r1 = '(无记录)'
  if (probe && probe.r1) {
    r1 = String(probe.r1)
    const when = probe.at ? Math.round((Date.now() - probe.at) / 1000) + 's 前' : ''
    push('R1: ' + r1 + (when ? '（' + when + '实测）' : ''))
  } else {
    push('R1: 还没记录 —— 先去运动页看一眼地图，再回来跑本自检')
  }

  // ===== R2：逻辑层现测（file.slice + FileReader），这是最可能真的走的那条 =====
  let r2 = '(未测)'
  if (!app) {
    r2 = 'H5 不适用（浏览器里没有 plus.io）'
    push('R2: ' + r2)
  } else if (!pack.rel) {
    r2 = '拿不到包路径'
    push('R2: ' + r2)
  } else {
    const t0 = Date.now()
    const file = await openRangeHandle(pack.rel, 6000)
    if (!file) {
      r2 = '打不开文件：' + pack.rel
      push('R2: ✗ ' + r2)
    } else {
      const r = await readRangeB64(file, '', 0, 16384, 5000)
      const ms = Date.now() - t0
      if (!r.ok) {
        r2 = '读不出内容：' + (r.err || '未知')
        push('R2: ✗ ' + r2 + '（' + ms + 'ms）')
      } else {
        const bytes = b64Peek(r.b64)
        const okMagic = magic7Ok(bytes)
        r2 = (okMagic ? '✓ ' : '✗ 头部不是 PMTiles ') + '16KB/' + ms + 'ms' + (r.via ? ' via ' + r.via : '')
        push('R2: ' + r2)
      }
    }
  }

  // ===== R3：整包路径还在不在（回退兜底必须永远可用）=====
  let r3 = '(未测)'
  if (!app) {
    r3 = 'H5 走 IndexedDB（整包），不在这里测'
    push('R3: ' + r3)
  } else {
    const f = await openRangeHandle(pack.rel, 6000)
    if (!f) {
      r3 = '✗ 打不开 ' + pack.rel
    } else {
      const size = f.size || 0
      const sizeOk = !pack.wantBytes || size === pack.wantBytes
      r3 = (sizeOk ? '✓ ' : '✗ ') + '整包可读 ' + formatBytes(size) + (sizeOk ? '' : '（清单声明 ' + formatBytes(pack.wantBytes) + '）')
    }
    push('R3: ' + r3)
  }

  // ===== 生效哪一级 + 读取统计（来自上次建图）=====
  const eff = (probe && probe.mode) || '(还没建过图)'
  push('生效: ' + eff + (probe && probe.r2 ? '（R2 上次：' + probe.r2 + '）' : ''))
  if (probe && probe.readStats) push('rd: ' + String(probe.readStats).replace(/^rd:/, ''))

  // ===== 坏机型记忆 =====
  const bad = listRangeBad()
  if (bad.length) {
    push('记忆: 有 ' + bad.length + ' 个包被标记 Range 不通（' + bad.map((b) => b.adcode).join(',') + '）')
  } else {
    push('记忆: 无')
  }

  // ===== 结论 =====
  const r2ok = r2.indexOf('✓') === 0
  let verdict = ''
  if (!app) {
    verdict = 'H5：按需读取只对内置包生效，已下载包仍是整包（见 task-4）'
  } else if (r2ok) {
    verdict = '按需读取可用（至少 R2 桥接通了）'
  } else {
    verdict = '按需读取不可用，会自动退回整包；大包（>60MB）可能仍加载不出来'
  }
  push('结论: ' + verdict)

  return { lines: lines, mode: eff, r1: r1, r2: r2 }
}

/** 桥接回来的 base64 只解前 8 字节，够判 PMTiles 魔数就行 */
function b64Peek(b64) {
  const s = String(b64 || '').slice(0, 16)
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch (e) {
    return new Uint8Array(0)
  }
}

/** 设置策略（自检卡上的三个按钮 + 「清除记忆并重试」） */
export function applySourceMode(mode) {
  return setSourceMode(mode)
}

/** 清掉坏机型记忆（并返回清了几条） */
export function resetRangeMemory() {
  const n = listRangeBad().length
  clearRangeBad()
  return n
}

/** 这个包在本机是否被判过 Range 不通（自检卡展示用） */
export function currentPackRangeBad() {
  const pack = currentPack()
  return { adcode: pack.adcode, bad: isRangeBad(pack.adcode) }
}
