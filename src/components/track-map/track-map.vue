<template>
  <view class="track-map">
    <canvas
      class="tm-canvas"
      :canvas-id="canvasId"
      :id="canvasId"
      :style="{ width: cw + 'px', height: ch + 'px' }"
    />

    <!-- 无轨迹时的占位 -->
    <view class="tm-empty" v-if="!points || points.length === 0">
      <text class="tm-empty-ico">◎</text>
      <text class="tm-empty-text">{{ emptyText }}</text>
    </view>

    <!-- 比例尺 + 指北 -->
    <view class="tm-scale" v-if="points && points.length > 1">
      <view class="tm-scale-bar" :style="{ width: barPx + 'px' }" />
      <text class="tm-scale-text">{{ barText }}</text>
    </view>
    <text class="tm-north" v-if="points && points.length > 1">N ↑</text>
  </view>
</template>

<script>
import { project } from '@/utils/geo.js'

// 自绘轨迹图（无底图）：
// 等距圆柱投影 + 网格 + 比例尺 + 起终点标记。零依赖、零网络，
// 用于青岛离线包覆盖范围之外，或底图渲染层不可用时兜底。
let seq = 0

export default {
  name: 'track-map',
  props: {
    // [{ lat, lng, ... }]
    points: { type: Array, default: () => [] },
    emptyText: { type: String, default: '开始运动后显示轨迹' },
  },
  data() {
    return {
      canvasId: 'tm-' + ++seq,
      cw: 0,
      ch: 0,
      barPx: 0,
      barText: '',
      retry: 0,
    }
  },
  watch: {
    points() {
      this.draw()
    },
  },
  mounted() {
    this.retry = 0
    this.measure()
  },
  methods: {
    // 量「容器」而不是 canvas 自己：canvas 的宽高是由量到的结果反推设置的，
    // 直接量 canvas 会拿到 0（自举问题），于是永远画不出来。
    // 布局未就绪时重试几次（App 端 mounted 常早于布局完成）。
    measure() {
      uni
        .createSelectorQuery()
        .in(this)
        .select('.track-map')
        .boundingClientRect((r) => {
          if (r && r.width && r.height) {
            this.cw = Math.round(r.width)
            this.ch = Math.round(r.height)
            this.draw()
          } else if (this.retry < 10) {
            this.retry++
            setTimeout(() => this.measure(), 120)
          }
        })
        .exec()
    },
    draw() {
      if (!this.cw || !this.ch) return
      const ctx = uni.createCanvasContext(this.canvasId, this)
      const w = this.cw
      const h = this.ch

      ctx.clearRect(0, 0, w, h)
      // 卡片底色
      ctx.setFillStyle('#15151a')
      ctx.fillRect(0, 0, w, h)
      this.drawGrid(ctx, w, h)

      const pts = this.points || []
      if (pts.length > 1) {
        const pr = project(pts, w, h, 22)
        this.drawTrack(ctx, pr.points)
        this.drawScale(pr.pxPerMeter)
      } else if (pts.length === 1) {
        // 只有一个点：中心画个位置点
        ctx.setFillStyle('#2bd45c')
        ctx.beginPath()
        ctx.arc(w / 2, h / 2, 6, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.draw()
    },
    drawGrid(ctx, w, h) {
      ctx.setStrokeStyle('rgba(255,255,255,0.045)')
      ctx.setLineWidth(1)
      const step = 32
      for (let x = step; x < w; x += step) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      for (let y = step; y < h; y += step) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
    },
    drawTrack(ctx, xy) {
      // 轨迹线
      ctx.setStrokeStyle('#2bd45c')
      ctx.setLineWidth(3.5)
      ctx.setLineCap('round')
      ctx.setLineJoin('round')
      ctx.beginPath()
      ctx.moveTo(xy[0].x, xy[0].y)
      for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i].x, xy[i].y)
      ctx.stroke()

      // 起点（绿，空心）
      const s = xy[0]
      ctx.setFillStyle('#15151a')
      ctx.beginPath()
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.setStrokeStyle('#2bd45c')
      ctx.setLineWidth(3)
      ctx.beginPath()
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2)
      ctx.stroke()

      // 终点 / 当前位置（实心亮绿 + 白边）
      const e = xy[xy.length - 1]
      ctx.setFillStyle('#7cf29d')
      ctx.beginPath()
      ctx.arc(e.x, e.y, 6.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.setStrokeStyle('#ffffff')
      ctx.setLineWidth(2)
      ctx.beginPath()
      ctx.arc(e.x, e.y, 6.5, 0, Math.PI * 2)
      ctx.stroke()
    },
    // 比例尺：从 1/2/5 × 10^n 里挑一个让条长落在 44–96px 的距离
    drawScale(pxPerMeter) {
      if (!pxPerMeter) {
        this.barPx = 0
        return
      }
      const wantMin = 44
      const wantMax = 96
      const cands = []
      for (let e = 0; e <= 5; e++) {
        for (const m of [1, 2, 5]) cands.push(m * Math.pow(10, e))
      }
      let chosen = cands[0]
      for (const c of cands) {
        const px = c * pxPerMeter
        if (px >= wantMin && px <= wantMax) {
          chosen = c
          break
        }
        if (px < wantMin) chosen = c
      }
      this.barPx = Math.round(chosen * pxPerMeter)
      this.barText = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`
    },
  },
}
</script>

<style lang="scss" scoped>
.track-map {
  position: relative;
  width: 100%;
  height: 340rpx;
  border-radius: 24rpx;
  overflow: hidden;
  background: #15151a;
}
.tm-canvas {
  display: block;
}
.tm-empty {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.tm-empty-ico {
  font-size: 56rpx;
  color: rgba(43, 212, 92, 0.5);
  line-height: 1;
}
.tm-empty-text {
  margin-top: 16rpx;
  font-size: 24rpx;
  color: $text-muted;
}
.tm-scale {
  position: absolute;
  left: 20rpx;
  bottom: 16rpx;
  display: flex;
  align-items: center;
}
.tm-scale-bar {
  height: 8rpx;
  border-left: 2rpx solid rgba(255, 255, 255, 0.75);
  border-right: 2rpx solid rgba(255, 255, 255, 0.75);
  border-bottom: 2rpx solid rgba(255, 255, 255, 0.75);
}
.tm-scale-text {
  margin-left: 10rpx;
  font-size: 20rpx;
  color: rgba(255, 255, 255, 0.65);
}
.tm-north {
  position: absolute;
  right: 24rpx;
  top: 20rpx;
  font-size: 20rpx;
  color: rgba(255, 255, 255, 0.5);
}
</style>
