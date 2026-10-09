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
import { MODES, calcSportCalories } from '@/utils/health.js'
import { getTodayData, saveTodayData, addRecord } from '@/utils/storage.js'
import { syncDaily } from '@/utils/cloud.js'

export default {
  data() {
    return {
      MODES,
      mode: 'run',
      state: 'idle', // idle / running / paused
      seconds: 0,
      timer: null,
    }
  },
  computed: {
    timeText() {
      const m = String(Math.floor(this.seconds / 60)).padStart(2, '0')
      const s = String(this.seconds % 60).padStart(2, '0')
      return `${m}:${s}`
    },
    caloriePreview() {
      return calcSportCalories(MODES[this.mode].met, this.seconds / 60)
    },
    stepPreview() {
      return Math.round(MODES[this.mode].stepPerMin * (this.seconds / 60))
    },
  },
  onUnload() {
    this.clearTimer()
  },
  methods: {
    switchMode(key) {
      if (this.state !== 'idle') return
      this.mode = key
    },
    start() {
      this.state = 'running'
      this.clearTimer()
      this.timer = setInterval(() => {
        this.seconds++
      }, 1000)
    },
    pause() {
      this.state = 'paused'
      this.clearTimer()
    },
    resume() {
      this.state = 'running'
      this.clearTimer()
      this.timer = setInterval(() => {
        this.seconds++
      }, 1000)
    },
    clearTimer() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
    finish() {
      this.clearTimer()
      const minutes = Math.round(this.seconds / 60)
      if (minutes < 1) {
        uni.showToast({ title: '运动时间太短', icon: 'none' })
        this.state = 'idle'
        this.seconds = 0
        return
      }

      const m = MODES[this.mode]
      const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: this.mode,
        duration: minutes,
        calories: calcSportCalories(m.met, minutes),
        steps: Math.round(m.stepPerMin * minutes),
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
