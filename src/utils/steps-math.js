/**
 * 本场步数计算（纯函数，便于单测）。
 *
 * 背景：Android 有两路计步数据
 *   - TYPE_STEP_COUNTER：开机累计值，精度高，但**很多机型息屏后会冻在旧值**；
 *   - TYPE_STEP_DETECTOR：每落一步发一个事件，实时，但可能漏计。
 * health.js 原本把两路先合并成 max(计步器增量, 检测器累计) 再减会话基线，
 * 结果一旦「数值较大的那一路卡住」，另一路的增量就被 max 整块吞掉 ——
 * 真机现象是走了 71 步、界面上步数恒为 0（测试版 47 的实测数据）。
 *
 * 正确做法：两路各记各的会话基线，再对**增量**取 max。
 * counter / det 用 -1 表示"该路不可用"。
 */

/** 单路增量：不可用、或读数回退（重启/传感器归零）时返回 -1 */
export function branchDelta(cur, base) {
  if (!Number.isFinite(cur) || !Number.isFinite(base)) return -1
  if (cur < 0 || base < 0) return -1
  if (cur < base) return -1 // 读数回退 → 该路本次不可信，交给另一路
  return cur - base
}

/**
 * 本场步数 = max(计步器增量, 检测器增量)。
 * @param {{counter:number, det:number}} cur  当前两路读数
 * @param {{counter:number, det:number}} base 会话开始时的两路基线
 * @returns {number} 步数；两路都不可用时返回 -1（调用方应保留上一次读数，别归零）
 */
export function sessionSteps(cur, base) {
  const c = cur || {}
  const b = base || {}
  const dc = branchDelta(c.counter, b.counter)
  const dd = branchDelta(c.det, b.det)
  if (dc < 0 && dd < 0) return -1
  return Math.max(dc, dd)
}

/** 基线是否可用于计算（任一路有效即可） */
export function baseUsable(base) {
  const b = base || {}
  return (Number.isFinite(b.counter) && b.counter >= 0) || (Number.isFinite(b.det) && b.det >= 0)
}
