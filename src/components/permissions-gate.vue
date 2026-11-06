<template>
  <!-- 首次进入的权限闸门：一次把该要的权限要完，之后不再打断用户 -->
  <view class="pg-mask" :class="themeClass" v-if="show">
    <view class="pg-panel">
      <!-- 头部固定，正文可滚动：内容再多也不会把面板顶出屏幕 -->
      <view class="pg-head">
        <text class="pg-title">{{ step === 'intro' ? '开始前，先把权限配齐' : '授权结果' }}</text>
        <text class="pg-sub">{{
          step === 'intro' ? '一次性授权，之后跑步、计步都不会再弹窗打断你' : resultHint
        }}</text>
      </view>

      <scroll-view class="pg-body" scroll-y :show-scrollbar="false">
        <view class="pg-item" v-for="it in items" :key="it.key">
          <text class="pg-icon">{{ it.icon }}</text>
          <view class="pg-item-main">
            <view class="pg-item-head">
              <text class="pg-item-title">{{ it.title }}</text>
              <text class="pg-tag" v-if="step === 'intro' && !it.required">可选</text>
            </view>
            <text class="pg-item-desc" :class="step === 'result' ? 'st-' + statusOf(it.key) : ''">{{
              step === 'intro' ? it.desc : statusText(it.key)
            }}</text>
          </view>
        </view>
      </scroll-view>

      <!-- 底部操作固定，不随内容滚走 -->
      <view class="pg-foot-btns">
        <template v-if="step === 'intro'">
          <view class="pg-btn primary" :class="{ disabled: asking }" @click="allowAll">
            {{ asking ? '正在申请…' : '全部允许，开始使用' }}
          </view>
          <view class="pg-btn ghost" @click="skip">先跳过，稍后再说</view>
          <text class="pg-foot">随时可在系统设置里修改；只做饮食记录的话，不授权定位也能用。</text>
        </template>
        <template v-else>
          <view class="pg-btn primary" @click="close">继续使用</view>
          <view class="pg-btn ghost" v-if="batteryDenied" @click="askBattery">去关闭电池优化</view>
          <view class="pg-btn ghost" @click="allowAll">再申请一次</view>
        </template>
      </view>
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
/* 全屏遮罩：上下都留出安全区，面板永不超过可视高度 */
.pg-mask {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 200;
  background: var(--mask);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(env(safe-area-inset-top) + 40rpx) 32rpx calc(env(safe-area-inset-bottom) + 40rpx);
  box-sizing: border-box;
}

/* 面板：纵向三段式（头 / 可滚动正文 / 固定按钮），高度受限于遮罩 */
.pg-panel {
  width: 100%;
  max-width: 660rpx;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  padding: 34rpx 28rpx 26rpx;
  border-radius: 32rpx;
  background: var(--bg-card);
  border: 1rpx solid var(--line);
  box-shadow: var(--shadow-pop);
}

.pg-head {
  flex: none;
}

.pg-title {
  display: block;
  font-size: 38rpx;
  font-weight: 800;
  letter-spacing: -0.4rpx;
  color: var(--text-1);
}

.pg-sub {
  display: block;
  margin-top: 10rpx;
  font-size: 24rpx;
  color: var(--text-2);
  line-height: 1.6;
}

/* 正文滚动区：内容再多也只在这里滚 */
.pg-body {
  flex: 1;
  min-height: 0;
  max-height: 62vh;
  margin-top: 6rpx;
}

.pg-item {
  display: flex;
  gap: 18rpx;
  margin-top: 18rpx;
  padding: 20rpx;
  border-radius: 20rpx;
  background: var(--bg-card-2);
  border: 1rpx solid var(--line);
}

.pg-icon {
  font-size: 38rpx;
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
  color: var(--text-1);
}

.pg-tag {
  font-size: 18rpx;
  color: var(--text-2);
  border: 1rpx solid var(--line-strong);
  border-radius: 999rpx;
  padding: 2rpx 12rpx;
}

.pg-item-desc {
  margin-top: 8rpx;
  font-size: 22rpx;
  color: var(--text-2);
  line-height: 1.55;
}

.st-granted {
  color: var(--accent);
}
.st-denied {
  color: var(--warm-text);
}

/* 底部按钮：固定，平面设计 */
.pg-foot-btns {
  flex: none;
  padding-top: 20rpx;
}

.pg-btn {
  margin-top: 16rpx;
  text-align: center;
  padding: 26rpx 0;
  border-radius: 999rpx;
  font-size: 28rpx;
  transition: transform 0.12s var(--ease), opacity 0.18s var(--ease),
    background-color 0.18s var(--ease);
}
.pg-btn:active {
  transform: scale(0.97);
  opacity: 0.9;
}
.pg-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
  letter-spacing: 0.5rpx;
}
.pg-btn.primary.disabled {
  opacity: 0.6;
}
.pg-btn.ghost {
  background: transparent;
  color: var(--text-2);
  border: 1rpx solid var(--line-strong);
}
.pg-foot {
  display: block;
  margin-top: 18rpx;
  font-size: 20rpx;
  color: var(--text-3);
  line-height: 1.6;
  text-align: center;
}
</style>
