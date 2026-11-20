/**
 * 同心环的几何计算（纯函数，供健康页 rings() / ringCaps() 共用）。
 *
 * 为什么抽到这里：
 *   ① 端帽圆心必须落在环带中线上，若 rings() 与 ringCaps() 各算一遍 band/gap，
 *      以后改一处忘另一处，端帽就会偏离环带——很难查的视觉 bug；
 *   ② 放 utils 才能在 node --test 里覆盖（SFC 里的导出 node 读不到）。
 *
 * 注意：不能写成组件 computed。实测 computed 版本在运行时解析不到
 * （this.ringGeometry is not a function），Vue 会把整棵 .ring-box 丢弃、页面只剩图例。
 */

/** 环带宽度：容器宽度的 6.2%，最小 9px（390px 屏 → 17px，430px → 18px，320px → 14px） */
export function ringBand(size) {
  return Math.max(9, Math.round(size * 0.062))
}

/** 环间距：环带的 0.85 倍 */
export function ringGap(band) {
  return Math.round(band * 0.85)
}

/**
 * @param {number} size 环盒边长（px）
 * @returns {{size:number,band:number,gap:number,rOuter:number,rMid:number,rInner:number,cx:number}|null}
 */
export function ringGeometryOf(size) {
  if (!size) return null
  const band = ringBand(size)
  const gap = ringGap(band)
  const rOuter = size / 2 - 2
  const rMid = rOuter - band - gap
  const rInner = rMid - band - gap
  return { size, band, gap, rOuter, rMid, rInner, cx: size / 2 }
}

/**
 * 端帽几何：每条弧两端各一个圆，圆心落在环带中线上（R = r − band/2）。
 * 三态边界（缺一个都是视觉 bug）：
 *   ratio <= 0     → 不画，否则"今天还没动却有个绿点"
 *   ratio >= 0.999 → 不画，满环时两端重合在 12 点会多出一个疙瘩
 * @param {{r:number,ratio:number,key:string,band:number,cx:number,capD:number}} p
 * @returns {Array<{key:string,x:number,y:number}>}
 */
export function capCenters({ r, ratio, key, band, cx, capD }) {
  const k = Math.min(1, Math.max(0, Number(ratio) || 0))
  if (k <= 0 || k >= 0.999) return []
  const R = r - band / 2
  const th = ((-90 + k * 360) * Math.PI) / 180
  return [
    { key: key + '-start', x: cx, y: cx - R },
    { key: key + '-end', x: cx + R * Math.cos(th), y: cx + R * Math.sin(th) },
  ]
}
