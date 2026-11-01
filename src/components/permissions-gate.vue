<template>
  <!-- 首次进入的权限闸门：一次把该要的权限要完，之后不再打断用户 -->
  <view class="pg-mask" v-if="show">
    <view class="pg-panel">
      <template v-if="step === 'intro'">
        <text class="pg-title">开始前，先把权限配齐</text>
        <text class="pg-sub">一次性授权，之后跑步、计步都不会再弹窗打断你</text>

        <view class="pg-item" v-for="it in items" :key="it.key">
          <text class="pg-icon">{{ it.icon }}</text>
          <view class="pg-item-main">
            <view class="pg-item-head">
              <text class="pg-item-title">{{ it.title }}</text>
              <text class="pg-tag" v-if="!it.required">可选</text>
            </view>
            <text class="pg-item-desc">{{ it.desc }}</text>
          </view>
        </view>

        <view class="pg-btn primary" :class="{ disabled: asking }" @click="allowAll">
          {{ asking ? '正在申请…' : '全部允许，开始使用' }}
        </view>
        <view class="pg-btn ghost" @click="skip">先跳过，稍后再说</view>
        <text class="pg-foot">
          随时可在系统设置里修改；只做饮食记录的话，不授权定位也能用。
        </text>
      </template>

      <template v-else>
        <text class="pg-title">授权结果</text>
        <text class="pg-sub">{{ resultHint }}</text>

        <view class="pg-item" v-for="it in items" :key="it.key">
          <text class="pg-icon">{{ it.icon }}</text>
          <view class="pg-item-main">
            <text class="pg-item-title">{{ it.title }}</text>
            <text class="pg-item-desc" :class="'st-' + statusOf(it.key)">{{ statusText(it.key) }}</text>
          </view>
        </view>

        <view class="pg-btn primary" @click="close">继续使用</view>
        <view class="pg-btn ghost" v-if="batteryDenied" @click="askBattery">去关闭电池优化</view>
        <view class="pg-btn ghost" @click="allowAll">再申请一次</view>
      </template>
    </view>
  </view>
</template>

<script>
import {
  PERMISSION_ITEMS,
  hasAskedPermissions,
  requestAllPermissions,
  savePermState,
  getPermState,
  refreshBatteryState,
  askBatteryAgain,
} from '@/utils/permissions.js'

export default {
  name: 'permissions-gate',
  data() {
    return {
      show: false,
      step: 'intro', // intro / result
      asking: false,
      items: PERMISSION_ITEMS,
      state: null,
    }
  },
  computed: {
    resultHint() {
      const s = this.state || {}
      if (!s.supported) return '当前平台不需要集中授权，直接开始即可'
      const missing = PERMISSION_ITEMS.filter((it) => s[it.key] === 'denied')
      if (!missing.length) return '都拿到了 👍'
      return `有 ${missing.length} 项没允许，相关功能会受限；可以再申请一次，或到系统设置里开。`
    },
    batteryDenied() {
      const s = this.state || {}
      return s.battery === 'denied'
    },
  },
  mounted() {
    // 只在"从来没走过"时出现；走过一次就不再打扰
    if (!hasAskedPermissions()) this.show = true
    // #ifdef APP-PLUS
    // 电池优化对话框没有回调：用户点完「允许」回到 App 时重查一次状态
    this.onResumeHandler = () => {
      const s = refreshBatteryState()
      if (this.state) this.state = Object.assign({}, this.state, { battery: s.battery })
    }
    try {
      plus.globalEvent.addEventListener('resume', this.onResumeHandler)
    } catch (e) {}
    // #endif
  },
  beforeUnmount() {
    // #ifdef APP-PLUS
    try {
      if (this.onResumeHandler) plus.globalEvent.removeEventListener('resume', this.onResumeHandler)
    } catch (e) {}
    // #endif
  },
  methods: {
    statusOf(key) {
      const s = this.state || {}
      const v = s[key]
      if (v === 'granted') return 'granted'
      if (v === 'denied') return 'denied'
      return 'na'
    },
    statusText(key) {
      const v = this.statusOf(key)
      if (v === 'granted') return '已允许'
      if (v === 'denied') return '未允许（可在系统设置里开启）'
      return '无需授权'
    },
    async allowAll() {
      if (this.asking) return
      this.asking = true
      try {
        this.state = await requestAllPermissions()
      } catch (e) {
        this.state = getPermState() || { supported: false }
      }
      this.asking = false
      const s = this.state || {}
      // H5 / 小程序没有集中授权这回事：不展示结果，直接进入
      if (!s.supported) {
        this.show = false
        return
      }
      this.step = 'result'
      // 全绿就直接进，不用再多点一次
      const allOk = PERMISSION_ITEMS.every((it) => s[it.key] === 'granted' || s[it.key] === 'na')
      if (allOk) {
        uni.showToast({ title: '权限已配齐', icon: 'success' })
        this.show = false
      }
    },
    skip() {
      savePermState({ supported: true, location: 'skipped', background: 'na', activity: 'skipped' })
      this.show = false
    },
    // 结果视图里手动再弹一次电池优化对话框
    askBattery() {
      askBatteryAgain()
      uni.showToast({ title: '请在弹出的系统窗口选「允许」', icon: 'none' })
    },
    close() {
      this.show = false
    },
  },
}
</script>

<style lang="scss" scoped>
.pg-mask {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 200;
  background: rgba(6, 8, 10, 0.94);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32rpx;
}
.pg-panel {
  width: 100%;
  max-width: 640rpx;
  padding: 36rpx 28rpx 28rpx;
  border-radius: 28rpx;
  background: #1a1a1f;
  border: 1rpx solid #26262c;
}
.pg-title {
  display: block;
  font-size: 38rpx;
  font-weight: 800;
  color: #f2f3f5;
}
.pg-sub {
  display: block;
  margin-top: 10rpx;
  font-size: 24rpx;
  color: #8b8d94;
  line-height: 1.6;
}
.pg-item {
  display: flex;
  gap: 18rpx;
  margin-top: 24rpx;
  padding: 20rpx;
  border-radius: 18rpx;
  background: #232329;
  border: 1rpx solid #26262c;
}
.pg-icon {
  font-size: 40rpx;
  line-height: 1.1;
}
.pg-item-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.pg-item-head {
  display: flex;
  align-items: center;
  gap: 12rpx;
}
.pg-item-title {
  font-size: 28rpx;
  font-weight: 700;
  color: #f2f3f5;
}
.pg-tag {
  font-size: 18rpx;
  color: #8b8d94;
  border: 1rpx solid #3a3a42;
  border-radius: 999rpx;
  padding: 2rpx 12rpx;
}
.pg-item-desc {
  margin-top: 8rpx;
  font-size: 22rpx;
  color: #8b8d94;
  line-height: 1.55;
}
.st-granted {
  color: #2bd45c;
}
.st-denied {
  color: #ffb347;
}
.pg-btn {
  margin-top: 24rpx;
  text-align: center;
  padding: 24rpx 0;
  border-radius: 16rpx;
  font-size: 28rpx;
}
.pg-btn.primary {
  background: linear-gradient(135deg, #2bd45c, #17a348);
  color: #06180d;
  font-weight: 700;
}
.pg-btn.primary.disabled {
  opacity: 0.6;
}
.pg-btn.ghost {
  background: transparent;
  color: #8b8d94;
  border: 1rpx solid #3a3a42;
  margin-top: 14rpx;
}
.pg-foot {
  display: block;
  margin-top: 18rpx;
  font-size: 20rpx;
  color: #5c5e66;
  line-height: 1.6;
  text-align: center;
}
</style>
