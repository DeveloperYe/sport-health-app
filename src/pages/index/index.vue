<template>
  <view class="page">
    <!-- 顶部问候 -->
    <view class="header">
      <view class="greet">
        <text class="hi">Hi，运动者</text>
        <text class="date">{{ todayText }}</text>
      </view>
      <view class="avatar" @click="goMine">我</view>
    </view>

    <!-- 目标圆环 -->
    <view class="ring-card">
      <view class="ring" :style="ringStyle">
        <view class="ring-inner">
          <text class="ring-num">{{ daily.steps }}</text>
          <text class="ring-unit">步</text>
        </view>
      </view>
      <view class="ring-label">
        <text class="ring-target">今日目标 {{ targets.steps }} 步</text>
        <text class="ring-tip">已完成 {{ percent }}%</text>
      </view>
    </view>

    <!-- 数据统计 -->
    <view class="stats">
      <view class="stat">
        <text class="stat-num">{{ daily.calories }}</text>
        <text class="stat-label">千卡</text>
      </view>
      <view class="stat">
        <text class="stat-num">{{ minText }}</text>
        <text class="stat-label">运动分钟</text>
      </view>
      <view class="stat">
        <text class="stat-num">{{ daily.steps }}</text>
        <text class="stat-label">今日步数</text>
      </view>
    </view>

    <!-- 快捷入口 -->
    <view class="go-sport" @click="goSport">
      <text class="go-text">开始运动</text>
      <text class="go-arrow">›</text>
    </view>

    <!-- 最近运动 -->
    <view class="recent">
      <view class="recent-head">
        <text class="recent-title">最近运动</text>
        <text class="recent-more" @click="goMine">全部 ›</text>
      </view>
      <view v-if="records.length === 0" class="empty">
        <text>还没有运动记录，去动起来吧</text>
      </view>
      <view v-for="r in records.slice(0, 3)" :key="r.id" class="record">
        <view class="record-icon" :class="r.type === 'run' ? 'icon-run' : 'icon-walk'">
          {{ r.type === 'run' ? '跑' : '走' }}
        </view>
        <view class="record-body">
          <text class="record-name">{{ r.type === 'run' ? '跑步' : '健走' }}</text>
          <text class="record-time">{{ formatTime(r.createdAt) }}</text>
        </view>
        <view class="record-right">
          <text class="record-num">{{ r.duration }}分</text>
          <text class="record-sub">{{ r.calories }}千卡</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import { getTodayData, saveTodayData, getTargets, getRecords } from '@/utils/storage.js'
import { getTodaySteps, calcCaloriesBySteps } from '@/utils/health.js'
import { syncDaily } from '@/utils/cloud.js'

export default {
  data() {
    return {
      daily: {},
      targets: {},
      records: [],
      todayText: '',
    }
  },
  computed: {
    percent() {
      if (!this.targets.steps) return 0
      return Math.min(100, Math.round((this.daily.steps / this.targets.steps) * 100))
    },
    minText() {
      return this.daily.duration || 0
    },
    ringStyle() {
      const p = this.percent
      return {
        background: `conic-gradient(#2bd45c ${p}%, #232329 ${p}% 100%)`,
      }
    },
  },
  onShow() {
    this.loadAll()
  },
  methods: {
    async loadAll() {
      this.daily = getTodayData()
      this.targets = getTargets()
      this.records = getRecords()
      this.todayText = this.formatToday()

      // 拉取当日步数（小程序：微信运动；App：原生计步器），合并后落本地 + 静默同步云端
      const steps = await getTodaySteps()
      if (steps > 0 && steps > this.daily.steps) {
        this.daily.steps = steps
        this.daily.calories = calcCaloriesBySteps(steps)
        saveTodayData(this.daily)
        syncDaily(this.daily, null)
      }
    },
    formatToday() {
      const d = new Date()
      const week = ['日', '一', '二', '三', '四', '五', '六']
      return `${d.getMonth() + 1}月${d.getDate()}日 星期${week[d.getDay()]}`
    },
    formatTime(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    },
    goSport() {
      uni.switchTab({ url: '/pages/sport/sport' })
    },
    goMine() {
      uni.switchTab({ url: '/pages/mine/mine' })
    },
  },
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 24rpx 32rpx 48rpx;
  background-color: $bg-page;
}

/* 头部 */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16rpx 0 32rpx;
}
.greet {
  display: flex;
  flex-direction: column;
}
.hi {
  font-size: 40rpx;
  font-weight: 700;
  color: $text-main;
}
.date {
  margin-top: 8rpx;
  font-size: 24rpx;
  color: $text-secondary;
}
.avatar {
  width: 80rpx;
  height: 80rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #2bd45c, #0e8f3c);
  color: #fff;
  font-size: 30rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 目标圆环卡片 */
.ring-card {
  background: $bg-card;
  border-radius: 32rpx;
  padding: 48rpx 0 40rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.ring {
  width: 320rpx;
  height: 320rpx;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ring-inner {
  width: 252rpx;
  height: 252rpx;
  border-radius: 50%;
  background: $bg-card;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.ring-num {
  font-size: 72rpx;
  font-weight: 700;
  color: $text-main;
  line-height: 1;
}
.ring-unit {
  margin-top: 8rpx;
  font-size: 26rpx;
  color: $text-secondary;
}
.ring-label {
  margin-top: 24rpx;
  display: flex;
  align-items: baseline;
}
.ring-target {
  font-size: 28rpx;
  color: $text-main;
}
.ring-tip {
  margin-left: 16rpx;
  font-size: 24rpx;
  color: $brand-primary;
}

/* 数据统计 */
.stats {
  margin-top: 24rpx;
  background: $bg-card;
  border-radius: 32rpx;
  padding: 36rpx 0;
  display: flex;
}
.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stat + .stat {
  border-left: 1rpx solid $border-subtle;
}
.stat-num {
  font-size: 44rpx;
  font-weight: 700;
  color: $text-main;
}
.stat-label {
  margin-top: 8rpx;
  font-size: 24rpx;
  color: $text-secondary;
}

/* 开始运动 */
.go-sport {
  margin-top: 24rpx;
  background: linear-gradient(135deg, #2bd45c, #17a348);
  border-radius: 32rpx;
  height: 104rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}
.go-text {
  color: #06180d;
  font-size: 34rpx;
  font-weight: 700;
}
.go-arrow {
  margin-left: 12rpx;
  color: #06180d;
  font-size: 40rpx;
}

/* 最近运动 */
.recent {
  margin-top: 24rpx;
  background: $bg-card;
  border-radius: 32rpx;
  padding: 32rpx;
}
.recent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
}
.recent-title {
  font-size: 32rpx;
  font-weight: 700;
  color: $text-main;
}
.recent-more {
  font-size: 24rpx;
  color: $text-secondary;
}
.empty {
  padding: 48rpx 0;
  text-align: center;
  color: $text-muted;
  font-size: 26rpx;
}
.record {
  display: flex;
  align-items: center;
  padding: 24rpx 0;
  border-top: 1rpx solid $border-subtle;
}
.record-icon {
  width: 72rpx;
  height: 72rpx;
  border-radius: 20rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30rpx;
  font-weight: 700;
}
.icon-run {
  background: rgba(43, 212, 92, 0.16);
  color: $brand-primary;
}
.icon-walk {
  background: rgba(87, 166, 255, 0.16);
  color: #57a6ff;
}
.record-body {
  flex: 1;
  margin-left: 20rpx;
  display: flex;
  flex-direction: column;
}
.record-name {
  font-size: 30rpx;
  color: $text-main;
  font-weight: 600;
}
.record-time {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-muted;
}
.record-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.record-num {
  font-size: 28rpx;
  color: $text-main;
  font-weight: 600;
}
.record-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-secondary;
}
</style>
