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
      <text class="card-hint">
        缺口 = 摄入 −（基础消耗 + 运动消耗）。体重曲线、周报等功能后续补上。
      </text>

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
import { getBody, getGoals, today } from '@/utils/body-store.js'
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
