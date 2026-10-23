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

    <!-- 轨迹图：优先青岛离线底图 + 轨迹叠加；底图起不来或轨迹越出离线包
         范围时，整体切回 track-map 自绘层（二选一，绝不同时显示两套）。 -->
    <view class="map-wrap">
      <map-view
        v-if="mapMode === 'basemap'"
        :points="trackPoints"
        :hint-text="mapHintText"
        @fail="onMapFail"
        @outofbounds="onMapOutOfBounds"
      />
      <track-map v-else :points="trackPoints" :empty-text="mapEmptyText" />
      <text class="map-fallback" v-if="mapMode === 'fallback' && mapFallbackText">
        已回退自绘轨迹图：{{ mapFallbackText }}
      </text>
      <text class="gps-err" v-if="gpsError">{{ gpsError }}</text>
    </view>

    <!-- 计时器 -->
    <view class="timer-card">
      <text class="timer-time">{{ timeText }}</text>
      <view class="timer-sub">
        <view class="timer-sub-item">
          <text class="timer-sub-num">{{ distanceText }}</text>
          <text class="timer-sub-label">距离</text>
        </view>
        <view class="timer-sub-item">
          <text class="timer-sub-num">{{ paceText }}</text>
          <text class="timer-sub-label">配速</text>
        </view>
        <view class="timer-sub-item">
          <text class="timer-sub-num">{{ stepPreview }}</text>
          <text class="timer-sub-label">步数</text>
        </view>
        <view class="timer-sub-item">
          <text class="timer-sub-num">{{ caloriePreview }}</text>
          <text class="timer-sub-label">千卡</text>
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
import { MODES, calcCaloriesBySteps, getWorkoutSteps, getTodaySteps } from '@/utils/health.js'
// #ifdef APP-PLUS
import { getStepDiag } from '@/utils/health.js'
// #endif
import { getTodayData, saveTodayData, addRecord, getWeight } from '@/utils/storage.js'
import { syncDaily } from '@/utils/cloud.js'
// GPS 轨迹：采集/滤波/距离在 track.js，格式化在 geo.js
import { startTrack, stopTrack, pauseTrack, resumeTrack, onTrackUpdate, getTrack } from '@/utils/track.js'
import { formatDistance, formatPace } from '@/utils/geo.js'

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
      // ===== GPS 轨迹 =====
      trackPoints: [], // 与 UI 绑定的已过滤轨迹点（每来一个点换一次引用，触发子组件重绘）
      gpsDistance: 0, // 米
      gpsError: '', // 权限 / 定位失败原因，直接显示给用户
      offTrack: null, // track.js 的退订函数
      // ===== 轨迹图模式：离线底图 或 自绘兜底（二选一）=====
      mapMode: 'basemap',
      mapBroken: false, // 底图彻底不可用（整轮会话都不再试）
      mapFallbackText: '',
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
    distanceText() {
      return formatDistance(this.gpsDistance)
    },
    paceText() {
      // 配速用与显示时间同一个口径（暂停时两者都停）
      return formatPace(this.seconds, this.gpsDistance)
    },
    mapEmptyText() {
      if (this.state === 'idle') return '开始运动后显示轨迹'
      return '等待 GPS 定位…（室外更快）'
    },
    // 底图在 idle 时就已经渲染好了，这里的提示跟自绘层不是一回事
    mapHintText() {
      if (this.state === 'idle') return '青岛离线底图已就绪，开始运动后叠加轨迹'
      return '等待 GPS 定位…（室外更快）'
    },
  },
  onShow() {
    this.weight = getWeight()
  },
  onUnload() {
    this.clearTimer()
    this.clearStepTimer()
    // 页面销毁时绝不能留下运行中的 GPS 监听
    if (this.offTrack) {
      this.offTrack()
      this.offTrack = null
    }
    stopTrack()
  },
  methods: {
    switchMode(key) {
      if (this.state !== 'idle') return
      this.mode = key
    },
    // 底图彻底不可用（WebGL/瓦片读取失败）：本轮不再尝试，直接自绘层兜底
    onMapFail(reason) {
      this.mapBroken = true
      this.mapFallbackText = reason || '底图不可用'
      this.mapMode = 'fallback'
    },
    // 轨迹跑出离线包 bbox：只对本次会话降级，下次开始运动再试底图
    onMapOutOfBounds() {
      this.mapFallbackText = '轨迹超出离线底图范围（青岛市区）'
      this.mapMode = 'fallback'
    },
    async start() {
      this.state = 'running'
      this.clearTimer()
      // 基线 = 会话开始时的累计读数（0 是合法值；-1 表示读取失败，由首个有效读数兜底）
      this.stepBaseline = await getWorkoutSteps()
      this.liveSteps = 0

      // 启动 GPS 轨迹采集：App 端 track.js 会传 type='wgs84'，
      // 运行时透传 plus.geolocation 走系统定位，不需要任何地图厂商 key
      this.trackPoints = []
      this.gpsDistance = 0
      this.gpsError = ''
      // 新一轮回到底图（上一轮可能因越界降级了）；底图彻底坏了才继续用自绘层
      if (!this.mapBroken) {
        this.mapMode = 'basemap'
        this.mapFallbackText = ''
      }
      await startTrack()
      const first = getTrack()
      if (first && first.error) this.gpsError = first.error
      this.offTrack = onTrackUpdate((snap) => {
        if (!snap) return
        // 换引用以触发子组件重绘
        this.trackPoints = snap.points.slice()
        this.gpsDistance = snap.distance
        if (snap.error) this.gpsError = snap.error
      })

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
      pauseTrack()
    },
    resume() {
      this.state = 'running'
      this.clearTimer()
      resumeTrack()
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
      }, 2000)
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

      // 先结束 GPS 采集并退订，拿到本场轨迹与距离
      const gps = stopTrack()
      if (this.offTrack) {
        this.offTrack()
        this.offTrack = null
      }
      const gpsDistance = gps ? gps.distance : this.gpsDistance
      const track = gps ? gps.track : []

      const minutes = Math.round(this.seconds / 60)
      if (minutes < 1) {
        uni.showToast({ title: '运动时间太短', icon: 'none' })
        this.resetSession()
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
        distance: Math.round(gpsDistance), // 米（GPS 累计）
        hasTrack: track.length > 1,
        track, // 抽稀后的轨迹点，供后续地图回放
        createdAt: Date.now(),
      }

      // 落本地 + 更新当日统计
      addRecord(record)
      const daily = getTodayData()
      daily.duration = (daily.duration || 0) + minutes
      // ⚠️ 步数与热量不再叠加进当日统计：当日步数由计步传感器口径统一供给，
      // 运动期间走的步数本就包含在传感器累计里，这里再 += record.steps 会把
      // 同一批步数算两次（运动中途切后台再切回时尤其明显）。
      // 改为拉一次当天真值，热量按它重算，保证口径一致。
      const todaySteps = await getTodaySteps()
      if (todaySteps > 0) daily.steps = todaySteps
      daily.calories = calcCaloriesBySteps(daily.steps || 0, this.weight)
      saveTodayData(daily)

      // 推云端（静默降级）
      syncDaily(daily, record)

      this.resetSession()
      uni.showToast({ title: '运动已保存', icon: 'success' })
    },
    resetSession() {
      this.state = 'idle'
      this.seconds = 0
      this.liveSteps = 0
      this.stepBaseline = -1
      this.trackPoints = []
      this.gpsDistance = 0
      this.diag = ''
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

/* 轨迹图 */
.map-wrap {
  margin-top: 32rpx;
  position: relative;
}
.gps-err {
  display: block;
  margin-top: 12rpx;
  font-size: 22rpx;
  color: #f0ad4e;
  line-height: 1.5;
}
.map-fallback {
  display: block;
  margin-top: 12rpx;
  font-size: 20rpx;
  color: $text-muted;
  line-height: 1.4;
}

/* 计时器 */
.timer-card {
  margin-top: 32rpx;
  background: $bg-card;
  border-radius: 32rpx;
  padding: 56rpx 0 48rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.timer-time {
  font-size: 108rpx;
  font-weight: 700;
  color: $text-main;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.timer-sub {
  margin-top: 40rpx;
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
  font-size: 36rpx;
  font-weight: 700;
  color: $text-main;
}
.timer-sub-label {
  margin-top: 8rpx;
  font-size: 22rpx;
  color: $text-secondary;
}
.timer-hint {
  margin-top: 32rpx;
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
