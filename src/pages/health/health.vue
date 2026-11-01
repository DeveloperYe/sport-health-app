<template>
  <view class="page">
    <!-- 首次进入：一次性把权限配齐 -->
    <permissions-gate />

    <!-- 顶部问候 -->
    <view class="hello">
      <text class="hello-main">{{ greeting }}</text>
      <text class="hello-sub">{{ dateText }}</text>
    </view>

    <!-- ===== 三个同心圆环：步数 / 热量消耗 / 饮水 ===== -->
    <view class="ring-card">
      <view class="ring-box">
        <!-- 用 CSS conic-gradient + mask 画环：不用 canvas。
             uni.createCanvasContext 在 H5 上会静默失败（实测画布像素为 0，环画不出来），
             而 conic-gradient 在 Chromium 内核 WebView 里稳定可用。 -->
        <view class="ring-layer" v-for="ring in rings" :key="ring.key" :style="ring.style"></view>
        <view class="ring-center">
          <text class="ring-center-num">{{ burned }}</text>
          <text class="ring-center-unit">kcal</text>
          <text class="ring-center-label">今日总消耗</text>
        </view>
      </view>

      <!-- 图例：环的颜色 → 指标达成 -->
      <view class="legend">
        <view class="legend-item">
          <view class="dot steps"></view>
          <view class="legend-main">
            <text class="legend-label">今日步数</text>
            <text class="legend-value">{{ steps }}<text class="legend-goal"> / {{ stepGoal }}</text></text>
          </view>
          <text class="legend-pct">{{ pct(steps, stepGoal) }}%</text>
        </view>
        <view class="legend-item">
          <view class="dot calorie"></view>
          <view class="legend-main">
            <text class="legend-label">热量消耗（运动）</text>
            <text class="legend-value">{{ exercise }}<text class="legend-goal"> / {{ calorieGoal }}</text></text>
          </view>
          <text class="legend-pct">{{ pct(exercise, calorieGoal) }}%</text>
        </view>
        <view class="legend-item">
          <view class="dot water"></view>
          <view class="legend-main">
            <text class="legend-label">今日饮水</text>
            <text class="legend-value">{{ water }}<text class="legend-goal"> / {{ waterGoal }} 杯</text></text>
          </view>
          <text class="legend-pct">{{ pct(water, waterGoal) }}%</text>
        </view>
      </view>
    </view>

    <!-- ===== 板块一：健康减脂 ===== -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">健康减脂</text>
        <text class="card-tag" v-if="gap7 !== null">近 7 天日均 {{ gap7 > 0 ? '+' : '' }}{{ gap7 }} kcal</text>
      </view>

      <view class="fat-row">
        <view class="fat-cell">
          <text class="fat-num">{{ weight || '—' }}</text>
          <text class="fat-label">当前体重 kg</text>
        </view>
        <text class="fat-arrow">→</text>
        <view class="fat-cell">
          <text class="fat-num goal">{{ goalWeight || '—' }}</text>
          <text class="fat-label">目标体重 kg</text>
        </view>
        <view class="fat-cell">
          <text class="fat-num">{{ bmi || '—' }}</text>
          <text class="fat-label">BMI{{ bmiTag }}</text>
        </view>
      </view>

      <view class="gap-strip">
        <text class="gap-k">今日热量缺口</text>
        <text class="gap-v" :class="{ over: todayGap > 0 }">{{ todayGapText }}</text>
      </view>

      <!-- 卡片内直接记体重，不用跳页 -->
      <view class="weigh-row">
        <input
          class="wi-input"
          type="digit"
          v-model="weightInput"
          placeholder="今天的体重（kg）"
          placeholder-class="wi-ph"
        />
        <view class="wi-btn" @click="saveWeight">记下</view>
      </view>

      <!-- 体重趋势（近 30 天）：纯 CSS 折线，避免 canvas 在 WebView 上的坑 -->
      <view class="trend">
        <view class="trend-head">
          <text class="trend-title">体重趋势</text>
          <text class="trend-tag" v-if="weightLog.length > 1">{{ minWeight }} – {{ maxWeight }} kg</text>
        </view>
        <view class="trend-box">
          <template v-if="chart.ok">
            <view
              class="trend-seg"
              v-for="(s, i) in chart.segments"
              :key="'s' + i"
              :style="{ left: s.x + 'px', top: s.y + 'px', width: s.len + 'px', transform: 'rotate(' + s.angle + 'deg)' }"
            ></view>
            <view
              class="trend-dot"
              v-for="(p, i) in chart.points"
              :key="'d' + i"
              :style="{ left: p.x + 'px', top: p.y + 'px' }"
            ></view>
          </template>
          <text class="trend-empty" v-else>{{ trendEmptyText }}</text>
        </view>
      </view>

      <!-- 目标进度 -->
      <view class="goal-bar" v-if="goalProgress !== null">
        <view class="goal-bar-head">
          <text class="goal-bar-k">{{ goalDeltaText }}</text>
          <text class="goal-bar-v">{{ goalProgress }}%</text>
        </view>
        <view class="goal-track">
          <view class="goal-fill" :style="{ width: goalProgress + '%' }"></view>
        </view>
      </view>

      <!-- 近 7 天缺口：向下为缺口（绿），向上为盈余（橙） -->
      <view class="weekg" v-if="weekBars.length">
        <view class="weekg-head">
          <text class="weekg-title">近 7 天缺口</text>
          <text class="weekg-tag">{{ weekCutDays }} 天有缺口</text>
        </view>
        <view class="weekg-bars">
          <view class="weekg-col" v-for="b in weekBars" :key="b.date">
            <view class="weekg-bar" :class="b.neg ? 'neg' : 'pos'" :style="{ height: b.h + 'rpx' }"></view>
            <text class="weekg-day">{{ b.label }}</text>
          </view>
        </view>
      </view>

      <text class="card-hint">缺口 = 摄入 −（基础消耗 + 运动消耗）。</text>

      <view class="card-actions">
        <view class="mini-btn primary" @click="goDiet">记录饮食</view>
        <view class="mini-btn ghost" @click="goProfile">完善身体信息</view>
      </view>
    </view>

    <!-- ===== 板块二：喝水打卡 ===== -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">喝水打卡</text>
        <text class="card-tag">{{ water }} / {{ waterGoal }} 杯 · {{ waterMl }} ml</text>
      </view>

      <view class="cups">
        <view
          v-for="i in 8"
          :key="i"
          class="cup"
          :class="{ on: i <= water }"
          @click="setCups(i)"
        >
          💧
        </view>
      </view>
      <text class="card-hint">每杯约 250ml，点杯子直接设定杯数；点同一杯可取消。</text>

      <view class="card-actions">
        <view class="mini-btn ghost" @click="addCup(1)">+1 杯</view>
        <view class="mini-btn ghost" @click="addCup(-1)">−1 杯</view>
        <view class="mini-btn primary" @click="setCups(waterGoal)">喝满</view>
      </view>
    </view>
  </view>
</template>

<script>
import PermissionsGate from '@/components/permissions-gate.vue'
import { getTodayData, getTargets } from '@/utils/storage.js'
import { getTodaySteps } from '@/utils/health.js'
import { getWater, setWater } from '@/utils/diet-store.js'
import { getBody, getGoals, today, getWeightLog, upsertWeight, saveBody } from '@/utils/body-store.js'
import { dayCalories, recentAverages } from '@/utils/day-summary.js'
import { calcBMI, bmiLabel } from '@/utils/body-calc.js'

export default {
  components: { PermissionsGate },
  data() {
    return {
      ringSize: 0, // px，量到容器宽度后计算环尺寸
      retry: 0,
      dateText: '',
      greeting: '你好',
      // 三项指标
      steps: 0,
      stepGoal: 8000,
      exercise: 0,
      calorieGoal: 300,
      water: 0,
      waterGoal: 8,
      // 中心数字
      burned: 0,
      // 减脂板块
      weight: '',
      goalWeight: '',
      bmi: 0,
      bmiTag: '',
      todayGap: 0,
      hasIntake: false,
      gap7: null,
      // 减脂板块：体重趋势 / 目标进度 / 近 7 天缺口
      weightLog: [],
      goalsWeight: 0,
      weightInput: '',
      weekDays: [],
      chartW: 0,
      chartH: 0,
      timer: null,
    }
  },
  computed: {
    waterMl() {
      return this.water * 250
    },
    todayGapText() {
      if (!this.hasIntake) return '还没记录饮食'
      const g = this.todayGap
      return g < 0 ? `缺口 ${Math.abs(g)} kcal` : `盈余 ${g} kcal`
    },
    /**
     * 三个同心环：外=步数(绿) 中=热量(橙) 内=饮水(蓝)
     * 每环是一个圆盘，用 radial-gradient 的 mask 挖掉中心，留下环带；
     * conic-gradient 的 from -90deg 让进度从 12 点方向开始。
     */
    rings() {
      const size = this.ringSize
      if (!size) return []
      const band = Math.max(9, Math.round(size * 0.062))
      const gap = Math.round(band * 0.85)
      const rOuter = size / 2 - 2
      const rMid = rOuter - band - gap
      const rInner = rMid - band - gap

      const defs = [
        { key: 'steps', r: rOuter, color: '#2bd45c', p: this.pct(this.steps, this.stepGoal) },
        { key: 'calorie', r: rMid, color: '#ffb347', p: this.pct(this.exercise, this.calorieGoal) },
        { key: 'water', r: rInner, color: '#4aa3ff', p: this.pct(this.water, this.waterGoal) },
      ]

      return defs.map((d) => {
        const diameter = Math.round(d.r * 2)
        const offset = Math.round((size - diameter) / 2)
        const ratio = Math.min(1, Math.max(0, d.p / 100))
        const deg = ratio * 360
        const maskFor = `radial-gradient(farthest-side, transparent calc(100% - ${band}px), #000 calc(100% - ${band}px))`
        return {
          key: d.key,
          style: {
            position: 'absolute',
            left: offset + 'px',
            top: offset + 'px',
            width: diameter + 'px',
            height: diameter + 'px',
            borderRadius: '50%',
            background: `conic-gradient(from -90deg, ${d.color} 0deg ${deg}deg, rgba(255,255,255,0.07) ${deg}deg 360deg)`,
            WebkitMaskImage: maskFor,
            maskImage: maskFor,
          },
        }
      })
    },
    minWeight() {
      const ws = this.weightLog.map((p) => Number(p.w) || 0).filter((w) => w > 0)
      return ws.length ? Math.min.apply(null, ws) : 0
    },
    maxWeight() {
      const ws = this.weightLog.map((p) => Number(p.w) || 0).filter((w) => w > 0)
      return ws.length ? Math.max.apply(null, ws) : 0
    },
    trendEmptyText() {
      if (this.weightLog.length === 1) return '再记一次就能连成趋势线'
      return '还没有体重记录：在上面填一个，或用「我的」页记录'
    },
    /**
     * 体重折线：把记录点映射到容器像素坐标，再用旋转的细条画线段。
     * 不用 canvas（uni.createCanvasContext 在 H5 上静默失败，前面吃过这个亏），
     * 也不用 SVG（uni-app 模板里不是一等公民），纯 view + transform 最稳。
     */
    chart() {
      const log = this.weightLog
      const w = this.chartW
      const h = this.chartH
      if (!w || !h || log.length < 2) return { ok: false, points: [], segments: [] }

      const ws = log.map((p) => Number(p.w) || 0)
      const min = Math.min.apply(null, ws)
      const max = Math.max.apply(null, ws)
      const span = max - min || 1
      const padX = 10
      const padY = 12
      const innerW = Math.max(1, w - padX * 2)
      const innerH = Math.max(1, h - padY * 2)

      const points = log.map((p, i) => ({
        x: padX + (i / (log.length - 1)) * innerW,
        y: padY + (1 - ((Number(p.w) || 0) - min) / span) * innerH,
      }))

      const segments = []
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]
        const b = points[i]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.sqrt(dx * dx + dy * dy)
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI
        segments.push({ x: a.x, y: a.y, len: len, angle: angle })
      }
      return { ok: true, points: points, segments: segments }
    },
    // 目标进度：起点取 30 天内最早一条，当前取最新一条
    goalProgress() {
      const goal = Number(this.goalsWeight) || 0
      if (!goal || this.weightLog.length < 2) return null
      const start = Number(this.weightLog[0].w) || 0
      const cur = Number(this.weightLog[this.weightLog.length - 1].w) || 0
      if (!start || !cur) return null
      if (Math.abs(start - goal) < 0.05) return Math.abs(cur - goal) < 0.05 ? 100 : 0
      const p = ((start - cur) / (start - goal)) * 100
      return Math.max(0, Math.min(100, Math.round(p)))
    },
    goalDeltaText() {
      const goal = Number(this.goalsWeight) || 0
      const cur = Number(this.weight) || 0
      if (!goal || !cur) return '还没设目标体重'
      const d = Math.round((cur - goal) * 10) / 10
      if (Math.abs(d) < 0.05) return '已达成目标体重'
      return d > 0 ? `还需减 ${d} kg` : `还可增 ${Math.abs(d)} kg`
    },
    // 近 7 天缺口柱：高度按本周最大绝对值归一
    weekBars() {
      const days = this.weekDays || []
      if (!days.length) return []
      const absList = days.filter((d) => d.hasRecord).map((d) => Math.abs(d.gap))
      const absMax = Math.max.apply(null, absList.concat([1]))
      return days.map((d) => {
        const has = !!d.hasRecord
        return {
          date: d.date,
          label: String(d.date).slice(8),
          neg: has && d.gap < 0,
          h: has ? Math.max(6, Math.round((Math.abs(d.gap) / absMax) * 96)) : 4,
        }
      })
    },
    weekCutDays() {
      return (this.weekDays || []).filter((d) => d.hasRecord && d.gap < 0).length
    },
  },
  onShow() {
    this.refresh()
    this.startTimer()
  },
  onHide() {
    this.stopTimer()
  },
  onUnload() {
    this.stopTimer()
  },
  mounted() {
    this.buildDateText()
    this.measure()
  },
  methods: {
    buildDateText() {
      const d = new Date()
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
      this.dateText = `${d.getMonth() + 1}月${d.getDate()}日 ${week}`
      const h = d.getHours()
      this.greeting = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好'
    },
    // 量容器（不能量自身：尺寸由量到的宽度反推，会自举成 0）
    measure() {
      uni
        .createSelectorQuery()
        .in(this)
        .select('.ring-box')
        .boundingClientRect((r) => {
          if (r && r.width) {
            this.ringSize = Math.round(r.width)
          } else if (this.retry < 10) {
            this.retry++
            setTimeout(() => this.measure(), 120)
          }
        })
        .exec()
      this.measureChart()
    },
    // 折线画布尺寸（要 px，才能算旋转角度）
    measureChart() {
      uni
        .createSelectorQuery()
        .in(this)
        .select('.trend-box')
        .boundingClientRect((r) => {
          if (r && r.width && r.height) {
            this.chartW = Math.round(r.width)
            this.chartH = Math.round(r.height)
          } else if (this.chartRetry === undefined || this.chartRetry < 10) {
            this.chartRetry = (this.chartRetry || 0) + 1
            setTimeout(() => this.measureChart(), 120)
          }
        })
        .exec()
    },
    // 首页直接记体重：同时更新身体信息里的当前体重，保证各处口径一致
    saveWeight() {
      const w = Number(this.weightInput)
      if (!(w > 0)) {
        uni.showToast({ title: '填一下体重', icon: 'none' })
        return
      }
      upsertWeight(today(), w)
      saveBody({ weight: w })
      this.weightInput = ''
      this.refresh()
      uni.showToast({ title: '已记录', icon: 'success' })
    },
    /** 一次性刷新全部指标 */
    async refresh() {
      const todayStr = today()
      const targets = getTargets() || {}
      const goals = getGoals()
      const body = getBody()

      this.stepGoal = Number(targets.steps) || 8000
      this.calorieGoal = Number(targets.calorie) || 300
      this.waterGoal = Number(goals.water) || 8

      // 步数：优先系统计步真值，取不到退回当日统计
      let steps = 0
      try {
        steps = Number(await getTodaySteps()) || 0
      } catch (e) {
        steps = 0
      }
      if (!steps) steps = Number((getTodayData() || {}).steps) || 0
      this.steps = steps

      // 热量 / 饮水
      const sum = dayCalories(todayStr)
      this.exercise = sum.exercise.total
      this.burned = sum.tdee
      this.water = getWater(todayStr)
      this.todayGap = sum.gap
      this.hasIntake = sum.intake > 0

      // 减脂板块
      this.weight = body.weight || ''
      this.goalWeight = goals.weight || ''
      this.bmi = calcBMI(body.weight, body.height)
      this.bmiTag = bmiLabel(this.bmi) ? `（${bmiLabel(this.bmi)}）` : ''
      const week = recentAverages(7)
      this.gap7 = week.activeCount ? Math.round(week.avgIntake - week.avgTdee) : null
      this.weekDays = week.days || []
      // 体重趋势用最近 30 天（按日期升序）
      const log = getWeightLog()
      this.weightLog = log.slice(-30)
      this.goalsWeight = Number(goals.weight) || 0
      // 数据到位后容器高度/宽度可能变了，重新量一次折线画布
      this.$nextTick(() => this.measureChart())
    },
    startTimer() {
      this.stopTimer()
      // 10 秒刷一次步数即可，别为了刷新把电耗光
      this.timer = setInterval(() => this.refresh(), 10000)
    },
    stopTimer() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
    pct(value, goal) {
      const g = Number(goal) || 0
      if (!g) return 0
      return Math.min(999, Math.round(((Number(value) || 0) / g) * 100))
    },
    // ===== 饮水 =====
    setCups(n) {
      const next = this.water === n ? n - 1 : n
      setWater(today(), next)
      this.refresh()
    },
    addCup(delta) {
      setWater(today(), this.water + delta)
      this.refresh()
    },
    // ===== 跳转 =====
    goDiet() {
      uni.navigateTo({ url: '/pages/diet/diet' })
    },
    goProfile() {
      uni.switchTab({ url: '/pages/profile/profile' })
    },
  },
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 24rpx 24rpx 160rpx;
  background: $bg-page;
}

/* 问候 */
.hello {
  padding: 8rpx 8rpx 20rpx;
}
.hello-main {
  display: block;
  font-size: 44rpx;
  font-weight: 800;
  color: $text-main;
}
.hello-sub {
  display: block;
  margin-top: 6rpx;
  font-size: 24rpx;
  color: $text-secondary;
}

/* ===== 圆环 ===== */
.ring-card {
  padding: 28rpx 24rpx 24rpx;
  border-radius: 28rpx;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}
.ring-box {
  position: relative;
  width: 520rpx;
  height: 520rpx;
  margin: 0 auto;
}
.ring-layer {
  /* 尺寸/位置/颜色由行内样式算出，这里只做兜底 */
  box-sizing: border-box;
}
.ring-center {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.ring-center-num {
  font-size: 52rpx;
  font-weight: 800;
  color: $text-main;
  line-height: 1;
  letter-spacing: -1rpx;
}
.ring-center-unit {
  margin-top: 4rpx;
  font-size: 20rpx;
  color: $text-secondary;
}
.ring-center-label {
  margin-top: 8rpx;
  font-size: 20rpx;
  color: $text-muted;
}

/* 图例 */
.legend {
  margin-top: 24rpx;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 16rpx 0;
  border-top: 1rpx solid $border-subtle;
}
.dot {
  width: 18rpx;
  height: 18rpx;
  border-radius: 50%;
}
.dot.steps {
  background: #2bd45c;
}
.dot.calorie {
  background: #ffb347;
}
.dot.water {
  background: #4aa3ff;
}
.legend-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.legend-label {
  font-size: 24rpx;
  color: $text-secondary;
}
.legend-value {
  margin-top: 4rpx;
  font-size: 32rpx;
  font-weight: 700;
  color: $text-main;
}
.legend-goal {
  font-size: 22rpx;
  color: $text-muted;
  font-weight: 400;
}
.legend-pct {
  font-size: 24rpx;
  color: $text-muted;
}

/* ===== 通用卡片 ===== */
.card {
  margin-top: 20rpx;
  padding: 26rpx 24rpx;
  border-radius: 28rpx;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.card-title {
  font-size: 32rpx;
  font-weight: 700;
  color: $text-main;
}
.card-tag {
  font-size: 22rpx;
  color: $text-secondary;
}
.card-hint {
  display: block;
  margin-top: 14rpx;
  font-size: 22rpx;
  color: $text-muted;
  line-height: 1.6;
}
.card-actions {
  display: flex;
  gap: 16rpx;
  margin-top: 20rpx;
}
.mini-btn {
  flex: 1;
  text-align: center;
  padding: 20rpx 0;
  border-radius: 16rpx;
  font-size: 26rpx;
}
.mini-btn.primary {
  background: linear-gradient(135deg, #2bd45c, #17a348);
  color: #06180d;
  font-weight: 700;
}
.mini-btn.ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}

/* 减脂 */
.fat-row {
  display: flex;
  align-items: center;
  margin-top: 20rpx;
}
.fat-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.fat-num {
  font-size: 40rpx;
  font-weight: 800;
  color: $text-main;
}
.fat-num.goal {
  color: $brand-primary;
}
.fat-label {
  margin-top: 6rpx;
  font-size: 20rpx;
  color: $text-secondary;
}
.fat-arrow {
  font-size: 28rpx;
  color: $text-muted;
  padding: 0 8rpx;
}
.gap-strip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 22rpx;
  padding: 18rpx 20rpx;
  border-radius: 16rpx;
  background: $bg-card-light;
}
.gap-k {
  font-size: 24rpx;
  color: $text-secondary;
}
.gap-v {
  font-size: 30rpx;
  font-weight: 700;
  color: $brand-primary;
}
.gap-v.over {
  color: #ffb347;
}

/* 记体重 */
.weigh-row {
  display: flex;
  gap: 14rpx;
  margin-top: 18rpx;
}
.wi-input {
  flex: 1;
  height: 72rpx;
  padding: 0 20rpx;
  border-radius: 14rpx;
  background: $bg-card-light;
  color: $text-main;
  font-size: 26rpx;
  border: 1rpx solid $border-subtle;
}
.wi-ph {
  color: $text-muted;
}
.wi-btn {
  padding: 0 30rpx;
  line-height: 72rpx;
  border-radius: 14rpx;
  background: $brand-primary;
  color: #06180d;
  font-size: 26rpx;
  font-weight: 700;
}

/* 体重趋势折线 */
.trend {
  margin-top: 22rpx;
}
.trend-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.trend-title {
  font-size: 26rpx;
  color: $text-secondary;
}
.trend-tag {
  font-size: 22rpx;
  color: $text-muted;
}
.trend-box {
  position: relative;
  height: 180rpx;
  margin-top: 10rpx;
  border-radius: 14rpx;
  background: rgba(255, 255, 255, 0.03);
  border: 1rpx solid $border-subtle;
  overflow: hidden;
}
.trend-seg {
  position: absolute;
  height: 3rpx;
  background: #2bd45c;
  opacity: 0.85;
  transform-origin: 0 50%;
  border-radius: 3rpx;
}
.trend-dot {
  position: absolute;
  width: 12rpx;
  height: 12rpx;
  margin-left: -6rpx;
  margin-top: -6rpx;
  border-radius: 50%;
  background: #2bd45c;
  box-shadow: 0 0 0 3rpx rgba(43, 212, 92, 0.22);
}
.trend-empty {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  text-align: center;
  font-size: 22rpx;
  color: $text-muted;
}

/* 目标进度 */
.goal-bar {
  margin-top: 20rpx;
}
.goal-bar-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.goal-bar-k {
  font-size: 24rpx;
  color: $text-secondary;
}
.goal-bar-v {
  font-size: 26rpx;
  font-weight: 700;
  color: $brand-primary;
}
.goal-track {
  height: 14rpx;
  margin-top: 10rpx;
  border-radius: 999rpx;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}
.goal-fill {
  height: 100%;
  border-radius: 999rpx;
  background: linear-gradient(90deg, #17a348, #2bd45c);
}

/* 近 7 天缺口 */
.weekg {
  margin-top: 22rpx;
}
.weekg-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.weekg-title {
  font-size: 26rpx;
  color: $text-secondary;
}
.weekg-tag {
  font-size: 22rpx;
  color: $text-muted;
}
.weekg-bars {
  display: flex;
  align-items: flex-end;
  gap: 10rpx;
  height: 120rpx;
  margin-top: 12rpx;
}
.weekg-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
}
.weekg-bar {
  width: 26rpx;
  border-radius: 6rpx 6rpx 0 0;
}
.weekg-bar.neg {
  background: #2bd45c;
}
.weekg-bar.pos {
  background: #ffb347;
}
.weekg-day {
  margin-top: 8rpx;
  font-size: 18rpx;
  color: $text-muted;
}

/* 饮水 */
.cups {
  display: flex;
  gap: 12rpx;
  margin-top: 20rpx;
}
.cup {
  flex: 1;
  height: 64rpx;
  border-radius: 12rpx;
  background: $bg-card-light;
  text-align: center;
  line-height: 64rpx;
  font-size: 28rpx;
  opacity: 0.4;
  border: 1rpx solid $border-subtle;
}
.cup.on {
  opacity: 1;
  border-color: rgba(74, 163, 255, 0.55);
}
</style>
