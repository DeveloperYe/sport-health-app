<template>
  <view class="page">
    <!-- 顶层切换：有轨迹的运动 / 其他运动（按 MET × 时长算消耗） -->
    <view class="page-tab">
      <view class="page-tab-item" :class="{ active: pageTab === 'track' }" @click="switchTab('track')">
        跑步 / 走路
      </view>
      <view class="page-tab-item" :class="{ active: pageTab === 'other' }" @click="switchTab('other')">
        其他运动
      </view>
    </view>

    <!-- ===== A. 跑步 / 走路：离线底图 + 实时轨迹 ===== -->
    <template v-if="pageTab === 'track'">
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

      <!-- 今日跑步 / 走路记录 -->
      <view class="ot-card">
        <view class="ot-list-head">
          <text class="ot-title">今日记录</text>
          <text class="ot-sum" v-if="todayRuns.length">{{ todayRuns.length }} 次</text>
        </view>
        <view v-if="!todayRuns.length" class="ot-empty">今天还没有跑步 / 走路记录</view>
        <view class="ot-item" v-for="r in todayRuns" :key="r.id">
          <view class="ot-item-main">
            <text class="ot-item-name">{{ r.type === 'walk' ? '走路' : '跑步' }} · {{ r.duration || 0 }} 分钟</text>
            <text class="ot-item-sub">{{ r.steps || 0 }} 步 · {{ distanceBrief(r.distance) }}</text>
          </view>
          <text class="ot-item-cal">{{ r.calories || 0 }} kcal</text>
          <text class="ot-item-del" @click="delRun(r)">删除</text>
        </view>
      </view>
    </template>

    <!-- ===== B. 其他运动：选动作 + 填时长 → 按体重算消耗 ===== -->
    <template v-else>
      <view class="ot-card">
        <text class="ot-title">选一个动作</text>
        <input
          class="ot-input"
          v-model="otherQuery"
          placeholder="搜动作，如 游泳 / 深蹲 / 篮球"
          placeholder-class="ot-ph"
          @input="searchOther"
        />
        <view class="ot-chips">
          <view class="ot-chip" v-for="q in quick" :key="q.name" @click="pickOther(q)">
            + {{ q.name }}
          </view>
        </view>
        <view class="ot-results" v-if="otherResults.length">
          <view class="ot-result" v-for="r in otherResults" :key="r.name + r.met" @click="pickOther(r)">
            <text class="ot-result-name">{{ r.name }}</text>
            <text class="ot-result-met">MET {{ r.met }}</text>
          </view>
        </view>

        <!-- 库里没有的动作：自己填名称 + MET -->
        <view class="ot-toggle" @click="showCustom = !showCustom">
          {{ showCustom ? '收起自定义动作' : '+ 自定义动作（自己填名称和 MET）' }}
        </view>
        <view class="ot-custom" v-if="showCustom">
          <input class="ot-input" v-model="custom.name" placeholder="动作名称，如 波比跳" placeholder-class="ot-ph" />
          <input class="ot-input" type="digit" v-model="custom.met" placeholder="MET 值，如 8" placeholder-class="ot-ph" />
          <view class="ot-mini-btn" @click="useCustom">用这个动作</view>
        </view>
      </view>

      <view class="ot-card" v-if="other.met > 0">
        <view class="ot-picked">
          <text class="ot-picked-name">{{ other.name }}</text>
          <text class="ot-picked-met">MET {{ other.met }}</text>
        </view>
        <view class="ot-row">
          <text class="ot-label">时长</text>
          <input class="ot-input ot-input-min" type="number" v-model="other.minutes" placeholder="分钟" />
          <text class="ot-unit">分钟</text>
        </view>
        <view class="ot-row ot-row-calc">
          <text class="ot-label">预计消耗</text>
          <text class="ot-cal">{{ otherCalorie }} kcal</text>
        </view>
        <text class="ot-hint">按 MET × 体重 {{ weight }} kg × 时长 估算</text>
        <view class="btn btn-primary ot-btn" @click="addOther">记下来</view>
      </view>

      <view class="ot-card">
        <view class="ot-list-head">
          <text class="ot-title">今日其他运动</text>
          <text class="ot-sum" v-if="otherSummary.count">
            {{ otherSummary.count }} 项 · {{ otherSummary.minutes }} 分钟 · {{ otherSummary.calorie }} kcal
          </text>
        </view>
        <view v-if="!todayOther.length" class="ot-empty">
          今天还没有记录：上面选一个动作、填时长，点「记下来」
        </view>
        <view class="ot-item" v-for="it in todayOther" :key="it.id">
          <view class="ot-item-main">
            <text class="ot-item-name">{{ it.name }}</text>
            <text class="ot-item-sub">MET {{ it.met }} · {{ it.minutes }} 分钟</text>
          </view>
          <text class="ot-item-cal">{{ it.calorie }} kcal</text>
          <text class="ot-item-del" @click="removeOther(it.id)">删除</text>
        </view>
      </view>
    </template>
  </view>
</template>

<script>
import { MODES, calcCaloriesBySteps, getTodaySteps, getStepBranches } from '@/utils/health.js'
import { sessionSteps, branchDelta, baseUsable } from '@/utils/steps-math.js'
// #ifdef APP-PLUS
import { getStepDiag } from '@/utils/health.js'
// #endif
import { getTodayData, saveTodayData, addRecord, getWeight, removeRecord } from '@/utils/storage.js'
import { syncDaily } from '@/utils/cloud.js'
// 其他运动：MET 库检索 + 按 MET×体重×时长 算消耗 + 当日记录存储
import { QUICK_EXERCISES, searchExercises } from '@/utils/nutrition.js'
import { calcExerciseCalorie } from '@/utils/body-calc.js'
import {
  getDayActivities,
  addActivity,
  removeActivity,
  summarizeActivities,
} from '@/utils/activity-store.js'
import { today as todayStr } from '@/utils/body-store.js'
import { allWorkoutRecords } from '@/utils/day-summary.js'
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
       * stepBase 进入运动时记录的「两路各自」的累计读数基线
       *   { counter: 开机累计（TYPE_STEP_COUNTER）, det: 检测器累计（TYPE_STEP_DETECTOR） }
       * liveSteps 运动中实时累计的本场步数。
       *
       * 为什么必须两路各记基线：早期把两路先 max 合并、再减同一个基线，
       * 一旦数值大的那一路卡住（很多机型息屏后 counter 冻住），另一路的增量
       * 就被 max 整块吞掉 —— 走了 71 步、界面恒为 0。见 utils/steps-math.js。
       */
      stepBase: { counter: -1, det: -1 },
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
      // ===== 顶层页签：跑步/走路（有轨迹） vs 其他运动（按 MET 时长） =====
      pageTab: 'track',
      quick: QUICK_EXERCISES,
      otherQuery: '',
      otherResults: [],
      other: { name: '', met: 0, minutes: '' },
      todayOther: [], // 今天已记录的其他运动
      otherSummary: { calorie: 0, minutes: 0, count: 0 },
      // 自定义动作（MET 库里没有的）
      showCustom: false,
      custom: { name: '', met: '' },
      todayRuns: [], // 今天的跑步/走路记录
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
    // 其他运动：MET × 体重 × 时长（与跑步页同一口径，保证热量缺口能对上）
    otherCalorie() {
      return calcExerciseCalorie(this.other.met, this.weight, this.other.minutes)
    },
  },
  onShow() {
    this.weight = getWeight()
    this.loadTodayOther()
    this.loadTodayRuns()
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
    // ===== 顶层页签 =====
    switchTab(tab) {
      // 运动进行中不允许切走，避免地图与计时状态错乱
      if (this.state !== 'idle') {
        uni.showToast({ title: '先结束当前运动', icon: 'none' })
        return
      }
      this.pageTab = tab
      if (tab === 'other') this.loadTodayOther()
    },

    // ===== 其他运动 =====
    searchOther() {
      this.otherResults = searchExercises(this.otherQuery, 12)
    },
    pickOther(item) {
      this.other.name = item.name
      this.other.met = Number(item.met) || 0
      this.otherResults = []
      this.otherQuery = ''
    },
    addOther() {
      const minutes = Number(this.other.minutes)
      if (!this.other.met) {
        uni.showToast({ title: '先选一个动作', icon: 'none' })
        return
      }
      if (!(minutes > 0)) {
        uni.showToast({ title: '填一下时长', icon: 'none' })
        return
      }
      addActivity(todayStr(), {
        name: this.other.name,
        met: this.other.met,
        minutes,
        calorie: calcExerciseCalorie(this.other.met, this.weight, minutes),
        weightUsed: this.weight,
      })
      this.other = { name: '', met: 0, minutes: '' }
      this.loadTodayOther()
      uni.showToast({ title: '已记录', icon: 'success' })
    },
    removeOther(id) {
      removeActivity(todayStr(), id)
      this.loadTodayOther()
    },
    loadTodayOther() {
      const list = getDayActivities(todayStr())
      this.todayOther = list
      this.otherSummary = summarizeActivities(list)
    },
    // 自定义动作：名称 + MET 都自己填，然后走同一条 MET 计算链
    useCustom() {
      const name = String(this.custom.name || '').trim()
      const met = Number(this.custom.met)
      if (!name) {
        uni.showToast({ title: '填一下动作名称', icon: 'none' })
        return
      }
      if (!(met > 0) || met > 25) {
        uni.showToast({ title: 'MET 填 1–25 之间的数', icon: 'none' })
        return
      }
      this.other.name = name
      this.other.met = Math.round(met * 10) / 10
      this.showCustom = false
      this.custom = { name: '', met: '' }
    },

    // ===== 今日跑步 / 走路记录 =====
    loadTodayRuns() {
      const d = todayStr()
      this.todayRuns = allWorkoutRecords().filter((r) => r.date === d)
    },
    delRun(r) {
      uni.showModal({
        title: '删除这次记录',
        content: '删除后今日的运动消耗会同步减少，确定吗？',
        success: (m) => {
          if (!m.confirm) return
          removeRecord(r.id)
          this.loadTodayRuns()
          uni.showToast({ title: '已删除', icon: 'success' })
        },
      })
    },
    distanceBrief(meters) {
      return formatDistance(meters)
    },

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
      // 基线 = 会话开始时两路各自的读数（-1 表示该路尚未就绪，由首个有效读数兜底）
      const base0 = await getStepBranches()
      this.stepBase = base0.ok
        ? { counter: base0.counter, det: base0.det }
        : { counter: -1, det: -1 }
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
        const cur = await getStepBranches()
        if (cur.ok) {
          if (!baseUsable(this.stepBase)) {
            // 开始时读取失败：首个有效读数即作为基线
            this.stepBase = { counter: cur.counter, det: cur.det }
          } else {
            const s = sessionSteps(cur, this.stepBase)
            if (s >= 0) this.liveSteps = s
          }
        }
        // 临时诊断（定位后移除）：c+/d+ 分别是两路自基线起的增量，
        // 走动时两路至少有一路应该增长；都停住才是传感器问题。
        const d = getStepDiag()
        const dc = branchDelta(cur.counter, this.stepBase.counter)
        const dd = branchDelta(cur.det, this.stepBase.det)
        this.diag = `sen:${d.sensorFound ? 1 : 0} dt:${d.detFound ? 1 : 0} cb:${d.cb} ev:${d.ev} c+${dc} d+${dd} comp:${d.comp}${d.err ? ' err:' + d.err : ''}`
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

      // 结束读取一次两路读数，按各自增量取 max（不伪造）
      const cur = await getStepBranches()
      if (cur.ok && !baseUsable(this.stepBase)) {
        // 全程没读到过基线（极少见）：用当前读数兜底，避免把历史值算进本场
        this.stepBase = { counter: cur.counter, det: cur.det }
      }
      const counted = cur.ok ? sessionSteps(cur, this.stepBase) : -1
      const realSteps = counted > 0 ? counted : this.liveSteps > 0 ? this.liveSteps : 0

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
      // 保存后刷新今日记录列表，否则要切页回来才看到
      this.loadTodayRuns()
    },
    resetSession() {
      this.state = 'idle'
      this.seconds = 0
      this.liveSteps = 0
      this.stepBase = { counter: -1, det: -1 }
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
  /* 底部多留一些，避免最后一张卡被固定 tabBar 压住 */
  padding: 32rpx 32rpx 160rpx;
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

/* ===== 顶层页签：跑步/走路 · 其他运动 ===== */
.page-tab {
  display: flex;
  gap: 12rpx;
  padding: 16rpx 24rpx 0;
}
.page-tab-item {
  flex: 1;
  text-align: center;
  padding: 18rpx 0;
  border-radius: 16rpx;
  background: $bg-card;
  color: $text-secondary;
  font-size: 28rpx;
  border: 1rpx solid $border-subtle;
}
.page-tab-item.active {
  color: #06180d;
  font-weight: 700;
  background: linear-gradient(135deg, #2bd45c, #17a348);
  border-color: transparent;
}

/* ===== 其他运动面板 ===== */
.ot-card {
  margin: 20rpx 24rpx 0;
  padding: 26rpx;
  border-radius: 24rpx;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}
.ot-title {
  font-size: 30rpx;
  font-weight: 700;
  color: $text-main;
}
.ot-input {
  margin-top: 18rpx;
  height: 76rpx;
  padding: 0 20rpx;
  border-radius: 16rpx;
  background: $bg-card-light;
  color: $text-main;
  font-size: 28rpx;
  border: 1rpx solid $border-subtle;
}
.ot-ph {
  color: $text-muted;
}
.ot-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 14rpx;
  margin-top: 18rpx;
}
.ot-chip {
  padding: 12rpx 22rpx;
  border-radius: 999rpx;
  background: $bg-card-light;
  color: $text-main;
  font-size: 26rpx;
  border: 1rpx solid $border-subtle;
}
.ot-results {
  margin-top: 16rpx;
  border-top: 1rpx solid $border-subtle;
}
.ot-result {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20rpx 4rpx;
  border-bottom: 1rpx solid $border-subtle;
}
.ot-result-name {
  font-size: 28rpx;
  color: $text-main;
  flex: 1;
}
.ot-result-met {
  font-size: 24rpx;
  color: $text-secondary;
}
/* 自定义动作 */
.ot-toggle {
  margin-top: 20rpx;
  padding: 16rpx 0;
  text-align: center;
  font-size: 24rpx;
  color: $brand-primary;
  border: 1rpx dashed rgba(43, 212, 92, 0.45);
  border-radius: 14rpx;
}
.ot-custom {
  margin-top: 12rpx;
}
.ot-mini-btn {
  margin-top: 16rpx;
  padding: 18rpx 0;
  text-align: center;
  border-radius: 14rpx;
  background: linear-gradient(135deg, #2bd45c, #17a348);
  color: #06180d;
  font-size: 26rpx;
  font-weight: 700;
}
.ot-picked {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.ot-picked-name {
  font-size: 32rpx;
  font-weight: 700;
  color: $brand-primary;
}
.ot-picked-met {
  font-size: 24rpx;
  color: $text-secondary;
}
.ot-row {
  display: flex;
  align-items: center;
  margin-top: 20rpx;
  gap: 16rpx;
}
.ot-label {
  width: 120rpx;
  font-size: 28rpx;
  color: $text-secondary;
}
.ot-input-min {
  flex: 1;
  margin-top: 0;
  text-align: center;
}
.ot-unit {
  font-size: 26rpx;
  color: $text-muted;
}
.ot-row-calc {
  padding-top: 16rpx;
  border-top: 1rpx solid $border-subtle;
}
.ot-cal {
  font-size: 40rpx;
  font-weight: 700;
  color: #ffb347;
}
.ot-hint {
  display: block;
  margin-top: 10rpx;
  font-size: 22rpx;
  color: $text-muted;
}
.ot-btn {
  margin-top: 22rpx;
}
.ot-list-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.ot-sum {
  font-size: 22rpx;
  color: $text-secondary;
}
.ot-empty {
  margin-top: 18rpx;
  font-size: 24rpx;
  color: $text-muted;
  line-height: 1.6;
}
.ot-item {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 22rpx 0;
  border-bottom: 1rpx solid $border-subtle;
}
.ot-item-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.ot-item-name {
  font-size: 28rpx;
  color: $text-main;
}
.ot-item-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-secondary;
}
.ot-item-cal {
  font-size: 28rpx;
  font-weight: 700;
  color: #ffb347;
}
.ot-item-del {
  font-size: 24rpx;
  color: $text-muted;
  padding-left: 8rpx;
}
</style>
