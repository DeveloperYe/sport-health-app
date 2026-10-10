<template>
  <view class="page">
    <!-- 模式切换 -->
    <view class="mode-switch">
      <view
        v-for="(m, key) in MODES"
        :key="key"
        class="mode-item"
        :class="{ active: mode === key }"
        @click="switchMode(key)"
      >
        {{ m.label }}
      </view>
    </view>

    <!-- 计时器 -->
    <view class="timer-card">
      <text class="timer-time">{{ timeText }}</text>
      <view class="timer-sub">
        <view class="timer-sub-item">
          <text class="timer-sub-num">{{ caloriePreview }}</text>
          <text class="timer-sub-label">千卡</text>
        </view>
        <view class="timer-sub-item">
          <text class="timer-sub-num">{{ stepPreview }}</text>
          <text class="timer-sub-label">步数</text>
        </view>
      </view>
      <text class="timer-hint" v-if="state === 'idle'">准备好后，点击开始</text>
      <text class="timer-hint" v-else-if="state === 'running'">运动进行中…</text>
      <text class="timer-hint" v-else>已暂停</text>
      <!-- 临时诊断（定位后移除） -->
      <!-- #ifdef APP-PLUS -->
      <text v-if="diag" class="timer-diag">{{ diag }}</text>
      <!-- #endif -->
    </view>

    <!-- 操作按钮 -->
    <view class="actions">
      <!-- 未开始 -->
      <view v-if="state === 'idle'" class="btn btn-primary" @click="start">开始运动</view>

      <!-- 进行中 -->
      <template v-else-if="state === 'running'">
        <view class="btn btn-ghost" @click="pause">暂停</view>
        <view class="btn btn-primary" @click="finish">结束</view>
      </template>

      <!-- 已暂停 -->
      <template v-else>
        <view class="btn btn-ghost" @click="finish">结束</view>
        <view class="btn btn-primary" @click="resume">继续</view>
      </template>
    </view>
  </view>
</template>

<script>
import { MODES, calcCaloriesBySteps, getWorkoutSteps } from '@/utils/health.js'
// #ifdef APP-PLUS
import { getStepDiag } from '@/utils/health.js'
// #endif
import { getTodayData, saveTodayData, addRecord, getWeight } from '@/utils/storage.js'
import { syncDaily } from '@/utils/cloud.js'

export default {
  data() {
    return {
      MODES,
      mode: 'run',
      state: 'idle', // idle / running / paused
      seconds: 0,
      timer: null,
      /**
       * 运动会话真实计步：
       * stepBaseline 进入页面开始运动时记录的累计步数基线，
       * liveSteps 运动中实时累计的本场步数（= 当前累计 - 基线）。
       * 结束用真实差值入账，不再伪造。
       */
      stepBaseline: -1,
      liveSteps: 0,
      stepTimer: null,
      weight: 60,
      diag: '',
    }
  },
  computed: {
    timeText() {
      const m = String(Math.floor(this.seconds / 60)).padStart(2, '0')
      const s = String(this.seconds % 60).padStart(2, '0')
      return `${m}:${s}`
    },
    caloriePreview() {
      // 热量按真实步数 + 体重估算（每千步约 40 千卡，随体重线性折算）
      return calcCaloriesBySteps(this.liveSteps, this.weight)
    },
    stepPreview() {
      // 运动页步数 = 真实计步器会话内累计（本场走了多少步）
      return this.liveSteps
    },
  },
  onShow() {
    this.weight = getWeight()
  },
  onUnload() {
    this.clearTimer()
    this.clearStepTimer()
  },
  methods: {
    switchMode(key) {
      if (this.state !== 'idle') return
      this.mode = key
    },
    async start() {
      this.state = 'running'
      this.clearTimer()
      // 基线 = 会话开始时的累计读数（0 是合法值；-1 表示读取失败，由首个有效读数兜底）
      this.stepBaseline = await getWorkoutSteps()
      this.liveSteps = 0
      this.timer = setInterval(() => {
        this.seconds++
      }, 1000)
      // 实时刷新真实步数（读一次计步器较廉价；微信运动不走实时，结束时取差值）
      this.startStepSync()
    },
    pause() {
      this.state = 'paused'
      this.clearTimer()
      this.clearStepTimer()
    },
    resume() {
      this.state = 'running'
      this.clearTimer()
      this.timer = setInterval(() => {
        this.seconds++
      }, 1000)
      this.startStepSync()
    },
    clearTimer() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
    startStepSync() {
      this.clearStepTimer()
      // #ifdef APP-PLUS
      // Android 原生计步可廉价轮询，实时刷新本场步数
      this.stepTimer = setInterval(async () => {
        const cur = await getWorkoutSteps()
        if (this.stepBaseline < 0) {
          // 开始时读取失败：首个有效读数即作为基线
          if (cur >= 0) this.stepBaseline = cur
        } else if (cur >= this.stepBaseline) {
          this.liveSteps = cur - this.stepBaseline
        }
        // 临时诊断（定位后移除）
        const d = getStepDiag()
        this.diag = `sen:${d.sensorFound ? 1 : 0} dt:${d.detFound ? 1 : 0} cb:${d.cb} ev:${d.ev} comp:${d.comp} base:${this.stepBaseline}${d.err ? ' err:' + d.err : ''}`
      }, 5000)
      // #endif
    },
    clearStepTimer() {
      if (this.stepTimer) {
        clearInterval(this.stepTimer)
        this.stepTimer = null
      }
    },
    async finish() {
      this.clearTimer()
      this.clearStepTimer()
      const minutes = Math.round(this.seconds / 60)
      if (minutes < 1) {
        uni.showToast({ title: '运动时间太短', icon: 'none' })
        this.state = 'idle'
        this.seconds = 0
        this.liveSteps = 0
        return
      }

      // 结束读取一次累计步数，真实差值 = 当前累计 - 基线（不伪造）
      const cur = await getWorkoutSteps()
      if (this.stepBaseline < 0 && cur >= 0) this.stepBaseline = cur // 读取失败时的懒基线兜底
      const realSteps =
        this.stepBaseline >= 0 && cur >= this.stepBaseline ? cur - this.stepBaseline : 0

      const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: this.mode,
        duration: minutes,
        calories: calcCaloriesBySteps(realSteps, this.weight),
        steps: realSteps,
        createdAt: Date.now(),
      }

      // 落本地 + 更新当日统计
      addRecord(record)
      const daily = getTodayData()
      daily.duration = (daily.duration || 0) + minutes
      daily.calories = (daily.calories || 0) + record.calories
      daily.steps = (daily.steps || 0) + record.steps
      saveTodayData(daily)

      // 推云端（静默降级）
      syncDaily(daily, record)

      this.state = 'idle'
      this.seconds = 0
      this.liveSteps = 0
      uni.showToast({ title: '运动已保存', icon: 'success' })
    },
  },
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 32rpx 32rpx 48rpx;
  background-color: $bg-page;
  display: flex;
  flex-direction: column;
}

/* 模式切换 */
.mode-switch {
  display: flex;
  background: $bg-card;
  border-radius: 24rpx;
  padding: 8rpx;
}
.mode-item {
  flex: 1;
  height: 76rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30rpx;
  color: $text-secondary;
  border-radius: 18rpx;
}
.mode-item.active {
  background: rgba(43, 212, 92, 0.16);
  color: $brand-primary;
  font-weight: 700;
}

/* 计时器 */
.timer-card {
  margin-top: 40rpx;
  background: $bg-card;
  border-radius: 32rpx;
  padding: 80rpx 0 64rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.timer-time {
  font-size: 140rpx;
  font-weight: 700;
  color: $text-main;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.timer-sub {
  margin-top: 48rpx;
  display: flex;
  width: 100%;
}
.timer-sub-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.timer-sub-item + .timer-sub-item {
  border-left: 1rpx solid $border-subtle;
}
.timer-sub-num {
  font-size: 48rpx;
  font-weight: 700;
  color: $text-main;
}
.timer-sub-label {
  margin-top: 8rpx;
  font-size: 24rpx;
  color: $text-secondary;
}
.timer-hint {
  margin-top: 48rpx;
  font-size: 26rpx;
  color: $text-muted;
}
/* 临时诊断（定位后移除） */
.timer-diag {
  margin-top: 16rpx;
  font-size: 20rpx;
  color: $text-muted;
  word-break: break-all;
}

/* 操作按钮 */
.actions {
  margin-top: auto;
  padding-top: 48rpx;
  display: flex;
  gap: 24rpx;
}
.btn {
  flex: 1;
  height: 104rpx;
  border-radius: 32rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 34rpx;
  font-weight: 700;
}
.btn-primary {
  background: linear-gradient(135deg, #2bd45c, #17a348);
  color: #06180d;
}
.btn-ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}
</style>
