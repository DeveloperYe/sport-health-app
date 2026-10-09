<template>
  <view class="page">
    <!-- 用户卡片 -->
    <view class="user-card">
      <view class="avatar">运</view>
      <view class="user-info">
        <text class="user-name">运动者</text>
        <text class="user-id">ID: {{ shortId }}</text>
      </view>
    </view>

    <!-- 目标设置 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">每日目标</text>
        <text class="card-action" @click="toggleEdit">{{ editing ? '保存' : '编辑' }}</text>
      </view>
      <view class="target-row">
        <text class="target-label">步数目标</text>
        <input
          v-if="editing"
          class="target-input"
          type="number"
          v-model="targetSteps"
          placeholder="如 8000"
        />
        <text v-else class="target-value">{{ targets.steps }} 步</text>
      </view>
      <view class="target-row">
        <text class="target-label">卡路里目标</text>
        <input
          v-if="editing"
          class="target-input"
          type="number"
          v-model="targetCalorie"
          placeholder="如 300"
        />
        <text v-else class="target-value">{{ targets.calorie }} 千卡</text>
      </view>
    </view>

    <!-- 云端同步 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">云端同步</text>
      </view>
      <text class="sync-status">{{ syncText }}</text>
      <view class="btn btn-primary" @click="manualSync">立即同步</view>
    </view>

    <!-- 运动历史 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">运动历史</text>
        <text class="card-count">{{ records.length }} 条</text>
      </view>
      <view v-if="records.length === 0" class="empty">暂无记录</view>
      <view v-for="r in records" :key="r.id" class="record">
        <view class="record-icon" :class="r.type === 'run' ? 'icon-run' : 'icon-walk'">
          {{ r.type === 'run' ? '跑' : '走' }}
        </view>
        <view class="record-body">
          <text class="record-name">{{ r.type === 'run' ? '跑步' : '健走' }}</text>
          <text class="record-time">{{ formatTime(r.createdAt) }}</text>
        </view>
        <view class="record-right">
          <text class="record-num">{{ r.duration }}分 · {{ r.calories }}千卡</text>
        </view>
        <text class="record-del" @click="delRecord(r.id)">删除</text>
      </view>
    </view>
  </view>
</template>

<script>
import { getUserId, getTargets, saveTargets, getRecords, saveRecords, removeRecord, getTodayData, saveTodayData } from '@/utils/storage.js'
import { syncDaily, fetchCloudData } from '@/utils/cloud.js'

export default {
  data() {
    return {
      userId: '',
      targets: {},
      records: [],
      editing: false,
      targetSteps: '',
      targetCalorie: '',
      lastSyncAt: '',
    }
  },
  computed: {
    shortId() {
      return this.userId ? this.userId.slice(0, 8) : ''
    },
    syncText() {
      return this.lastSyncAt ? `上次同步 ${this.formatTime(this.lastSyncAt)}` : '尚未同步'
    },
  },
  onShow() {
    this.load()
  },
  methods: {
    load() {
      this.userId = getUserId()
      this.targets = getTargets()
      this.records = getRecords()
      this.lastSyncAt = getTodayData().lastSyncAt || ''
      this.targetSteps = String(this.targets.steps)
      this.targetCalorie = String(this.targets.calorie)
    },
    toggleEdit() {
      if (this.editing) {
        // 保存
        this.targets = {
          steps: Number(this.targetSteps) || 8000,
          calorie: Number(this.targetCalorie) || 300,
        }
        saveTargets(this.targets)
        uni.showToast({ title: '目标已保存', icon: 'success' })
      }
      this.editing = !this.editing
    },
    delRecord(id) {
      removeRecord(id)
      this.records = getRecords()
    },
    async manualSync() {
      uni.showLoading({ title: '同步中' })
      const daily = getTodayData()
      // 先推本地当日数据，再拉云端
      await syncDaily(daily, null)
      const res = await fetchCloudData()
      uni.hideLoading()

      if (res.ok) {
        const data = res.result || {}
        if (Array.isArray(data.records) && data.records.length) {
          // 云端记录覆盖本地（云端为权威备份）
          saveRecords(data.records)
          this.records = getRecords()
        }
        daily.lastSyncAt = Date.now()
        saveTodayData(daily)
        this.lastSyncAt = daily.lastSyncAt
        uni.showToast({ title: '同步完成', icon: 'success' })
      } else {
        uni.showToast({ title: '同步失败，请检查云空间', icon: 'none' })
      }
    },
    formatTime(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

/* 用户卡片 */
.user-card {
  display: flex;
  align-items: center;
  background: $bg-card;
  border-radius: 32rpx;
  padding: 40rpx 32rpx;
}
.avatar {
  width: 112rpx;
  height: 112rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #2bd45c, #0e8f3c);
  color: #fff;
  font-size: 44rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.user-info {
  margin-left: 28rpx;
  display: flex;
  flex-direction: column;
}
.user-name {
  font-size: 36rpx;
  font-weight: 700;
  color: $text-main;
}
.user-id {
  margin-top: 10rpx;
  font-size: 24rpx;
  color: $text-muted;
}

/* 通用卡片 */
.card {
  margin-top: 24rpx;
  background: $bg-card;
  border-radius: 32rpx;
  padding: 32rpx;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20rpx;
}
.card-title {
  font-size: 32rpx;
  font-weight: 700;
  color: $text-main;
}
.card-action {
  font-size: 26rpx;
  color: $brand-primary;
}
.card-count {
  font-size: 24rpx;
  color: $text-muted;
}

/* 目标设置 */
.target-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 0;
}
.target-row + .target-row {
  border-top: 1rpx solid $border-subtle;
}
.target-label {
  font-size: 28rpx;
  color: $text-secondary;
}
.target-value {
  font-size: 28rpx;
  color: $text-main;
  font-weight: 600;
}
.target-input {
  width: 240rpx;
  height: 64rpx;
  background: $bg-card-light;
  border-radius: 12rpx;
  padding: 0 20rpx;
  font-size: 28rpx;
  color: $text-main;
  text-align: right;
}

/* 同步 */
.sync-status {
  font-size: 26rpx;
  color: $text-secondary;
}
.btn {
  margin-top: 24rpx;
  height: 88rpx;
  border-radius: 24rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30rpx;
  font-weight: 700;
}
.btn-primary {
  background: linear-gradient(135deg, #2bd45c, #17a348);
  color: #06180d;
}

/* 历史 */
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
  font-size: 24rpx;
  color: $text-secondary;
}
.record-del {
  margin-left: 20rpx;
  font-size: 24rpx;
  color: $text-muted;
  padding: 8rpx 0 8rpx 16rpx;
}
</style>
