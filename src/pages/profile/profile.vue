<template>
  <view class="page">
    <!-- 顶栏：标题 + 编辑/保存图标按钮 -->
    <view class="topbar">
      <view class="topbar-title">
        <text class="topbar-name">个人档案</text>
        <text class="topbar-sub">{{ editing ? '完善你的基础信息' : '基本信息' }}</text>
      </view>
      <view
        class="icon-btn"
        :class="editing ? 'icon-btn-save' : 'icon-btn-edit'"
        @click="toggleEdit"
      >
        <!-- 铅笔(编辑) / 对勾(保存) 图标 -->
        <text v-if="!editing" class="icon-edit">✎</text>
        <text v-else class="icon-save">✓</text>
      </view>
    </view>

    <!-- 档案卡片 -->
    <view class="profile-card">
      <!-- 身高 -->
      <view class="field">
        <view class="field-label">
          <view class="field-ico ico-height"></view>
          <text class="field-name">身高</text>
        </view>
        <view class="field-input-wrap">
          <input
            v-if="editing"
            class="field-input"
            type="number"
            v-model="height"
            placeholder="如 170"
          />
          <text v-else class="field-value">{{ height || '--' }}</text>
          <text class="field-unit">cm</text>
        </view>
      </view>

      <!-- 体重 -->
      <view class="field">
        <view class="field-label">
          <view class="field-ico ico-weight"></view>
          <text class="field-name">体重</text>
        </view>
        <view class="field-input-wrap">
          <input
            v-if="editing"
            class="field-input"
            type="number"
            v-model="weight"
            placeholder="如 60"
          />
          <text v-else class="field-value">{{ weight || '--' }}</text>
          <text class="field-unit">kg</text>
        </view>
      </view>

      <!-- 年龄 -->
      <view class="field">
        <view class="field-label">
          <view class="field-ico ico-age"></view>
          <text class="field-name">年龄</text>
        </view>
        <view class="field-input-wrap">
          <input
            v-if="editing"
            class="field-input"
            type="number"
            v-model="age"
            placeholder="如 25"
          />
          <text v-else class="field-value">{{ age || '--' }}</text>
          <text class="field-unit">岁</text>
        </view>
      </view>
    </view>

    <!-- 提示 -->
    <text class="tip">体重用于估算运动热量，身高与年龄用于后续健康指标</text>
  </view>
</template>

<script>
import { getHeight, saveHeight, getWeight, saveWeight, getAge, saveAge } from '@/utils/storage.js'

export default {
  data() {
    return {
      editing: false,
      height: '',
      weight: '',
      age: '',
    }
  },
  onShow() {
    this.load()
  },
  methods: {
    load() {
      this.height = getHeight()
      this.weight = getWeight()
      this.age = getAge()
    },
    toggleEdit() {
      if (this.editing) {
        this.save()
        return
      }
      this.editing = true
    },
    save() {
      const h = Number(this.height)
      const w = Number(this.weight)
      const a = Number(this.age)
      if (!(h >= 50 && h <= 250)) return this.warn('请输入有效身高（50-250cm）')
      if (!(w >= 30 && w <= 300)) return this.warn('请输入有效体重（30-300kg）')
      if (!(a >= 1 && a <= 120)) return this.warn('请输入有效年龄（1-120岁）')

      saveHeight(h)
      saveWeight(w)
      saveAge(a)
      this.height = h
      this.weight = w
      this.age = a
      this.editing = false
      uni.showToast({ title: '已保存', icon: 'success' })
    },
    warn(msg) {
      uni.showToast({ title: msg, icon: 'none' })
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

/* 顶栏 */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24rpx 0 32rpx;
}
.topbar-title {
  display: flex;
  flex-direction: column;
}
.topbar-name {
  font-size: 40rpx;
  font-weight: 700;
  color: $text-main;
}
.topbar-sub {
  margin-top: 8rpx;
  font-size: 24rpx;
  color: $text-secondary;
}

/* 图标按钮（编辑/保存） */
.icon-btn {
  width: 84rpx;
  height: 84rpx;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}
.icon-btn-edit {
  background: rgba(43, 212, 92, 0.14);
}
.icon-btn-save {
  background: linear-gradient(135deg, #2bd45c, #17a348);
  box-shadow: 0 8rpx 24rpx rgba(43, 212, 92, 0.28);
}
.icon-edit {
  font-size: 40rpx;
  color: $brand-primary;
  font-weight: 600;
}
.icon-save {
  font-size: 44rpx;
  color: #06180d;
  font-weight: 700;
}

/* 档案卡片 */
.profile-card {
  background: $bg-card;
  border-radius: 32rpx;
  padding: 8rpx 32rpx;
}
.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 36rpx 0;
}
.field + .field {
  border-top: 1rpx solid $border-subtle;
}
.field-label {
  display: flex;
  align-items: center;
}
.field-ico {
  width: 64rpx;
  height: 64rpx;
  border-radius: 16rpx;
  margin-right: 20rpx;
}
.ico-height {
  background: rgba(43, 212, 92, 0.12);
}
.ico-weight {
  background: rgba(87, 166, 255, 0.14);
}
.ico-age {
  background: rgba(255, 170, 64, 0.14);
}
/* 用迷你图形做图标（非文字按钮） */
.ico-height::after {
  content: '';
  display: block;
  width: 24rpx;
  height: 36rpx;
  margin: 14rpx auto;
  border-bottom: 2rpx solid $brand-primary;
  border-left: 2rpx solid $brand-primary;
}
.ico-weight::after {
  content: '';
  display: block;
  width: 22rpx;
  height: 22rpx;
  margin: 21rpx auto;
  border-radius: 50%;
  border: 3rpx solid rgba(87, 166, 255, 0.9);
}
.ico-age::after {
  content: '';
  display: block;
  width: 22rpx;
  height: 30rpx;
  margin: 15rpx auto;
  border: 3rpx solid rgba(255, 170, 64, 0.9);
  border-radius: 8rpx;
}
.field-name {
  font-size: 30rpx;
  color: $text-main;
  font-weight: 600;
}
.field-input-wrap {
  display: flex;
  align-items: baseline;
}
.field-input {
  width: 220rpx;
  height: 72rpx;
  background: $bg-card-light;
  border-radius: 16rpx;
  padding: 0 24rpx;
  font-size: 30rpx;
  color: $text-main;
  text-align: right;
}
.field-value {
  font-size: 32rpx;
  color: $text-main;
  font-weight: 700;
}
.field-unit {
  margin-left: 12rpx;
  font-size: 26rpx;
  color: $text-muted;
}

.tip {
  display: block;
  margin-top: 24rpx;
  padding: 0 8rpx;
  font-size: 24rpx;
  color: $text-muted;
  line-height: 1.6;
}
</style>