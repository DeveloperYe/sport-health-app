<template>
  <view class="page" :class="themeClass">
    <!-- 顶部类别：横向滚动、多类别。选中项靠「字号加大 + 字重 700 + 强调色」区分（不填色块）。
         轨迹类（跑步 / 健走）走 GPS + 计步；MET 类（骑行 / 游泳 / 篮球…）按 MET×体重×时长算消耗。
         原来这里是 3 个等宽页签：类别一多就挤成一团，第 3 项之后也没法再加。
         清单与选中态都由 utils/sport-categories.js 的数据算出来 —— 模板里不再有硬编码文案。 -->
    <scroll-view
      class="cat-bar"
      scroll-x
      :scroll-into-view="'cat-' + catBar.activeIndex"
      scroll-with-animation
    >
      <view
        v-for="(c, i) in catBar.items"
        :key="c.key"
        :id="'cat-' + i"
        class="cat-item"
        :class="{ active: i === catBar.activeIndex, transient: c.transient }"
        @click="pickCategory(c)"
      >
        {{ c.label }}<text class="cat-mark" v-if="c.transient">•</text>
      </view>
    </scroll-view>

    <!-- ===== A. 跑步 / 健走：离线底图 + 实时轨迹 ===== -->
    <template v-if="pageTab === 'track'">
      <!-- 二级模式条已删除：跑步 / 健走变成顶层同级页签，不再有第二层选择 -->

      <!-- 轨迹图：优先离线底图（内置青岛包或已下载的城市包）+ 轨迹叠加；底图起不来或
           轨迹越出离线包范围时，整体切回 track-map 自绘层（二选一，绝不同时显示两套）。 -->
      <view class="map-wrap">
        <map-view
          v-if="mapMode === 'basemap'"
          ref="mvm"
          :points="trackPoints"
          :hint-text="mapHintText"
          :city-key="mapCityKey"
          :visible="pageVisible"
          @fail="onMapFail"
          @outofbounds="onMapOutOfBounds"
        />
        <track-map v-else :points="trackPoints" :empty-text="mapEmptyText" />
        <text class="map-fallback" v-if="mapMode === 'fallback' && mapFallbackText">
          已回退自绘轨迹图：{{ mapFallbackText }}
        </text>
        <text class="gps-err" v-if="gpsError">{{ gpsError }}</text>
        <!-- 底图切换入口：显示当前用的是哪个城市的包 -->
        <view class="map-city-btn" @click="goMaps">
          <text class="map-city-txt">{{ mapCityName }}</text>
          <text class="map-city-arrow">切换</text>
        </view>
      </view>

      <!-- 计时器 -->
      <view class="timer-card">
        <text class="timer-time">{{ timeText }}</text>
        <view class="timer-sub">
          <view class="timer-sub-item">
            <text class="timer-sub-num">{{ distanceText }}</text>
            <text class="timer-sub-label">距离</text>
          <text class="timer-sub-note" v-if="estimatedNote">{{ estimatedNote }}</text>
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
        <!-- 口径说明（一句话，小字）：热量按时长 × MET × 体重算，与步数无关。
             没有这句，用户会问"我走了这么多步，为什么热量和以前不一样"。
             MET 值随类别变（跑步 8.0 / 健走 4.3），所以把它显示出来。 -->
        <text class="timer-metric">热量 = MET {{ modeMet }} × 体重 {{ weight }}kg × 时长（与步数无关）</text>
        <!-- 没填体重时按默认 60kg 算：MET 口径下体重直接决定热量，必须说清 -->
        <text class="timer-metric-warn" v-if="!weightKnown">按默认 60kg 估算，去「我的」填一下体重更准</text>
        <text class="timer-hint" v-if="state === 'idle'">准备好后，点击开始</text>
        <text class="timer-hint" v-else-if="state === 'running'">
          运动进行中…{{ bgGained >= 0 ? `　后台期间新增 ${bgGained} 个点` : '' }}
        </text>
        <text class="timer-hint" v-else>已暂停{{ bgGained >= 0 ? `　后台期间新增 ${bgGained} 个点` : '' }}</text>
        <!-- 临时诊断（定位后移除） -->
        <!-- #ifdef APP-PLUS -->
        <text v-if="diag" class="timer-diag">{{ diag }}</text>
        <!-- #endif -->
        <!-- 计步自检：用户报「步数算不出来」时一键摊开真值 + 判定。
             一直显示（不加 #ifdef、不限运动中）—— 出问题时用户往往还没开始运动，
             而 H5 上判定为 no-app 本身也是有用信息（说明步数要真机才有）。
             自检是一次性快照 + 判定；上面那行 diag 是实时值，两者互补。 -->
        <view class="timer-check-btn" @click="stepSelfCheck">计步自检</view>
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

      <!-- 今日跑步 / 健走记录 -->
      <view class="ot-card">
        <view class="ot-list-head">
          <text class="ot-title">今日记录</text>
          <text class="ot-sum" v-if="todayRuns.length">{{ todayRuns.length }} 次</text>
        </view>
        <view v-if="!todayRuns.length" class="ot-empty">今天还没有跑步 / 健走记录</view>
        <view class="ot-item" v-for="r in todayRuns" :key="r.id">
          <view class="ot-item-main">
            <text class="ot-item-name">{{ r.type === 'walk' ? '健走' : '跑步' }} · {{ r.duration || 0 }} 分钟</text>
            <text class="ot-item-sub">{{ r.steps || 0 }} 步 · {{ distanceBrief(r.distance) }}</text>
          </view>
          <text class="ot-item-cal">{{ r.calories || 0 }} kcal</text>
          <text class="ot-item-del" @click="delRun(r)">删除</text>
        </view>
      </view>
    </template>

    <!-- ===== B. MET 类运动：选动作 + 计时/补录 → 按 MET×体重×时长 算消耗 ===== -->
    <template v-else>
      <!-- 计时卡放在最上面：类别条已经承担了「选动作」这一步，
           用户点「游泳」进来应该立刻看到「开始计时」，而不是先滚过搜索框。 -->
      <view class="ot-card" v-if="other.met > 0">
        <view class="ot-picked">
          <text class="ot-picked-name">{{ other.name }}</text>
          <text class="ot-picked-met">MET {{ other.met }}</text>
        </view>

        <!-- 计时区：跑着的时候实时跳时间和消耗 -->
        <view class="ot-timer">
          <text class="ot-timer-time">{{ otTimeText }}</text>
          <view class="ot-timer-right">
            <text class="ot-timer-cal">{{ otCalorieLive }}</text>
            <text class="ot-timer-cal-unit">kcal</text>
          </view>
        </view>
        <text class="ot-timer-hint">{{ otHint }}</text>

        <view class="ot-actions">
          <view v-if="otState === 'idle'" class="ot-mini-btn wide" @click="otStart">开始计时</view>
          <template v-else-if="otState === 'running'">
            <view class="ot-mini-btn ghost" @click="otPause">暂停</view>
            <view class="ot-mini-btn" @click="otFinish">结束并记录</view>
            <!-- 放弃：误触开始、或开着计时去忙别的事之后，需要一条「不记账」的出口。
                 没有它的话会话永远停在 running，切类别/running 守卫会一直拦着。 -->
            <view class="ot-mini-btn ghost" @click="otCancel">放弃</view>
          </template>
          <template v-else>
            <view class="ot-mini-btn ghost" @click="otResume">继续</view>
            <view class="ot-mini-btn" @click="otFinish">结束并记录</view>
            <view class="ot-mini-btn ghost" @click="otCancel">放弃</view>
          </template>
        </view>

        <!-- 忘了开计时器时的补录通道 -->
        <view class="ot-toggle" @click="showManual = !showManual">
          {{ showManual ? '收起手动补录' : '忘了计时？手动补录时长' }}
        </view>
        <view class="ot-custom" v-if="showManual">
          <view class="ot-row">
            <text class="ot-label">时长</text>
            <input class="ot-input ot-input-min" type="digit" v-model="other.minutes" placeholder="分钟" placeholder-class="ot-ph" />
            <text class="ot-unit">分钟</text>
          </view>
          <view class="ot-row ot-row-calc">
            <text class="ot-label">预计消耗</text>
            <text class="ot-cal">{{ otherCalorie }} kcal</text>
          </view>
          <view class="ot-mini-btn" @click="addOther">记下来</view>
        </view>
      </view>

      <!-- 类别条里没有的动作：搜索 + 自定义（长尾兜底，永远留着）。
           原来的 9 个快捷 chip 已删：类别条里一模一样地都有，留着就是同一批数据的第二份界面。 -->
      <view class="ot-card">
        <text class="ot-title">没找到？搜动作或自定义</text>
        <input
          class="ot-input"
          v-model="otherQuery"
          placeholder="搜动作，如 波比跳 / 爬山 / 广场舞"
          placeholder-class="ot-ph"
          @input="searchOther"
        />
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

      <view class="ot-card">
        <view class="ot-list-head">
          <text class="ot-title">今日其他运动</text>
          <text class="ot-sum" v-if="otherSummary.count">
            {{ otherSummary.count }} 项 · {{ sumDuration(otherSummary) }} · {{ otherSummary.calorie }} kcal
          </text>
        </view>
        <view v-if="!todayOther.length" class="ot-empty">
          今天还没有记录：上面选一个动作，点「开始计时」，结束后自动记账
        </view>
        <view class="ot-item" v-for="it in todayOther" :key="it.id">
          <view class="ot-item-main">
            <text class="ot-item-name">{{ it.name }}</text>
            <text class="ot-item-sub">MET {{ it.met }} · {{ durText(it) }}</text>
          </view>
          <text class="ot-item-cal">{{ it.calorie }} kcal</text>
          <text class="ot-item-del" @click="removeOther(it.id)">删除</text>
        </view>
      </view>
    </template>

    <!-- ===== 运动历史（跨天，从「我的」页搬来） =====
         放在两个类别面板**之外**：历史是跨口径的（跑步/健走 + 其他运动），
         挂在任一面板下都会出现"切到另一类别就看不到历史"；页面级只实现一份。
         今日的记录仍在各自面板的「今日记录 / 今日其他运动」里，下面这张卡是完整时间线。
         总数取真实全量（不是当前渲染条数）；默认 10 条，按「展开更多」每次 +20。 -->
    <view class="ot-card">
      <view class="ot-list-head">
        <text class="ot-title">运动历史</text>
        <text class="ot-sum" v-if="historyView.total">共 {{ historyView.total }} 条</text>
      </view>
      <view v-if="!historyView.rows.length" class="ot-empty">
        还没有记录，完成一次运动就会出现在这里
      </view>
      <view class="ot-item" v-for="r in historyView.rows" :key="r.key">
        <view class="ot-item-main">
          <text class="ot-item-name">{{ r.name }}</text>
          <text class="ot-item-sub">{{ r.dateLabel }} · {{ formatDurationText(r.durationSeconds) }} · {{ r.sub }}</text>
        </view>
        <text class="ot-item-cal">{{ r.calorie }} kcal</text>
        <text class="ot-item-del" @click="delHistory(r)">删除</text>
      </view>
      <view class="ot-more" v-if="historyView.remaining > 0" @click="moreHistory">
        展开更多（还有 {{ historyView.remaining }} 条）
      </view>
    </view>
  </view>
</template>

<script>
import { MODES, calcCaloriesBySteps, getTodaySteps, getStepBranches } from '@/utils/health.js'
import { sessionSteps, branchDelta, baseUsable } from '@/utils/steps-math.js'
// #ifdef APP-PLUS
import { getStepDiag } from '@/utils/health.js'
// #endif
// 计步自检：静态引入而非动态 import —— App 端 file:// webview 加载独立 chunk 有失败风险，
// 真机上会表现成"点了没反应"；本模块只有 ~160 行、依赖的 health/storage 本就在主包，
// 静态引入只多约 2 KB，换来真机必可用。
// ⚠️ 必须放在 #ifdef APP-PLUS 之外：自检按钮在 H5 上也要能点（判定 no-app 本身是有用信息），
// 放进 App 专属块会让 H5 构建把 import 整行删掉，方法运行到 collectStepFacts 就报未定义。
import { collectStepFacts, buildStepReport } from '@/utils/step-selftest.js'
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
  formatActivityDuration,
} from '@/utils/activity-store.js'
import { today as todayStr, getWeightLog } from '@/utils/body-store.js'
// 运动历史（跨天）：跑步/健走与其他运动混排的记录由 allExerciseHistory 统一成同一种形状，
// 展示层（真实总数 / 日期只出现一次 / 分批渲染）在 history-view.js，配了单测。
import { allWorkoutRecords, allExerciseHistory } from '@/utils/day-summary.js'
import { buildHistoryRows, moreHistoryLimit, HISTORY_INITIAL } from '@/utils/history-view.js'
// 顶部类别条（横向滚动）：类别清单数据驱动 + 选中态纯函数解析，配 tests/sport-categories.test.mjs
import { buildSportCategories, resolveCategoryBar } from '@/utils/sport-categories.js'
// GPS 轨迹：采集/滤波/距离在 track.js，格式化在 geo.js
import { startTrack, stopTrack, pauseTrack, resumeTrack, onTrackUpdate, getTrack, elapsedMs } from '@/utils/track.js'
// 会话状态机（纯函数，配 tests/sport-session.test.mjs）：
// 修「双击结束写两条记录」与「start 的 await 窗口里点结束 → state 归位但 GPS 还在跑」。
// 那两个 bug 会让切类别（pickCategory）/ 切地图（goMaps）的守卫失真，详见该文件头注释。
import {
  guardStart,
  tapFinish,
  afterAwait,
  isCurrentSession,
  shouldDiscardSession,
  sessionMinutes,
  sessionCalorieByMet,
  mergeSessionReset,
} from '@/utils/sport-session.js'
import { formatDistance, formatPace } from '@/utils/geo.js'
import { getCurrent, getCity } from '@/utils/city-maps.js'

export default {
  data() {
    return {
      MODES,
      mode: 'run',
      state: 'idle', // idle / running / paused
      finishing: false, // 结束重入锁：一次会话只允许走一次落库（P0-1）
      sessionToken: 0, // 会话代号：每个 await 之后用它判断这一轮是否还作数（P0-2）
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
      // 用户是否真的填过体重：getWeight() 没填时返回默认 60，无法区分「真的 60kg」与「没填」。
      // 所有写入体重的入口（health 页「记下」、我的页「保存」、云端恢复）都走
      // body-store.saveBody → upsertWeight，所以体重日志非空 = 填过。
      weightKnown: false,
      diag: '',
      // 后台保活诊断：切后台时的点数，回前台后算"后台期间新增了几点"
      pointsAtHide: -1,
      bgGained: -1,
      // ===== GPS 轨迹 =====
      trackPoints: [], // 与 UI 绑定的已过滤轨迹点（每来一个点换一次引用，触发子组件重绘）
      gpsDistance: 0, // 米
      estimatedDistance: 0, // 其中信号中断期间按直线估算的米数（如实告知用户）
      gpsError: '', // 权限 / 定位失败原因，直接显示给用户
      offTrack: null, // track.js 的退订函数
      // ===== 轨迹图模式：离线底图 或 自绘兜底（二选一）=====
      mapMode: 'basemap',
      pageVisible: true, // 页面是否在前台：切走时停掉地图渲染与状态轮询
      mapCityKey: '',
      mapCityName: '青岛（内置）',
      mapBroken: false, // 底图彻底不可用（整轮会话都不再试）
      mapFallbackText: '',
      // ===== 顶部类别条（横向滚动）：轨迹类 + MET 类 =====
      // 清单数据驱动：轨迹类取 MODES（跑步 / 健走，MET 与计步口径都在 health.js 里只写一次），
      // MET 类取 nutrition.js 的快捷清单（自动剔除与轨迹类撞名的「跑步」），末尾固定兜底「其他运动」。
      // 模板里不再有硬编码的类别文案，加一个动作 = 改 nutrition.js 的数据。
      // pageTab 与 mode 仍保留为内部状态：前者决定渲染哪个面板，后者决定计步口径与记录 type。
      categories: buildSportCategories(MODES, QUICK_EXERCISES),
      pageTab: 'track',
      otherQuery: '',
      otherResults: [],
      other: { name: '', met: 0, minutes: '' },
      todayOther: [], // 今天已记录的其他运动
      otherSummary: { calorie: 0, minutes: 0, count: 0 },
      // 自定义动作（MET 库里没有的）
      showCustom: false,
      custom: { name: '', met: '' },
      // ===== 其他运动的计时会话 =====
      // 用「时间戳 + 已累计毫秒」而不是自增计数：App 切后台时定时器会被节流，
      // 但回到前台按 Date.now() 重算就不会丢时间（与跑步页同一思路）。
      otState: 'idle', // idle / running / paused
      otStartedAt: 0, // 本段开始的时间戳
      otAccumMs: 0, // 之前各段累计
      otNow: 0, // 刷新用（定时器每 250ms 更新）
      otTimer: null,
      showManual: false, // 手动补录面板
      todayRuns: [], // 今天的跑步/健走记录
      // ===== 运动历史（跨天，从「我的」页搬来）=====
      historyItems: [], // allExerciseHistory() 原始项：跑步/健走与其他运动混排
      historyToday: '', // 算「今天/昨天」用的当天日期串（进页面时取一次）
      historyLimit: HISTORY_INITIAL, // 当前渲染条数上限，「展开更多」每次 +HISTORY_PAGE_STEP
    }
  },
  computed: {
    timeText() {
      const m = String(Math.floor(this.seconds / 60)).padStart(2, '0')
      const s = String(this.seconds % 60).padStart(2, '0')
      return `${m}:${s}`
    },
    caloriePreview() {
      // 热量口径 C（2026-11-20 用户拍板）：MET × 体重 × 时长，与「其他运动」同一个函数
      // （body-calc.calcExerciseCalorie），全 App 只有这一条热量公式。
      // 与步数无关：跑步 8.0 / 健走 4.3 两个 MET 才让两个类别有了实际差别
      // （同 30 分钟跑步 ≈ 健走的 1.86 倍）；步数照旧只展示与本场记录。
      return sessionCalorieByMet({
        met: this.modeMet,
        minutes: this.seconds / 60,
        weightKg: this.weight,
      })
    },
    // 当前类别的 MET（跑步 8.0 / 健走 4.3）：界面口径说明与热量计算都用它，避免两处各写一遍
    modeMet() {
      const m = MODES[this.mode]
      return m ? m.met : 0
    },
    stepPreview() {
      // 运动页步数 = 真实计步器会话内累计（本场走了多少步）
      return this.liveSteps
    },
    distanceText() {
      return formatDistance(this.gpsDistance)
    },
    // 只在中途真的丢过信号时才提一句，平时不打扰
    estimatedNote() {
      const m = this.estimatedDistance || 0
      if (m < 30) return ''
      return '含估算 ' + formatDistance(m)
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
    // ===== 其他运动的计时 =====
    otElapsedMs() {
      if (this.otState === 'running' && this.otStartedAt) {
        return this.otAccumMs + Math.max(0, this.otNow - this.otStartedAt)
      }
      return this.otAccumMs
    },
    otTimeText() {
      const total = Math.floor(this.otElapsedMs / 1000)
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      const mm = String(m).padStart(2, '0')
      const ss = String(s).padStart(2, '0')
      return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
    },
    // 实时消耗：用毫秒精算，别等整分钟才动
    otCalorieLive() {
      const met = Number(this.other.met) || 0
      const w = Number(this.weight) || 0
      if (!(met > 0) || !(w > 0)) return 0
      return Math.round(met * w * (this.otElapsedMs / 3600000))
    },
    otHint() {
      if (this.otState === 'idle') return '选好动作后点「开始计时」，边练边看消耗'
      if (this.otState === 'running') return `计时中 · MET ${this.other.met} × 体重 ${this.weight}kg`
      return '已暂停，可继续或结束'
    },
    // 类别条要渲染的项 + 当前选中下标（选中项据此自动滚入视野）。
    // 判定逻辑全在纯函数里：轨迹面板看 mode；MET 面板按 name+met 精确匹配预设项，
    // 匹配不到就追加一个「临时项」（搜索/自定义选的动作），保证条上永远有一项是选中的。
    catBar() {
      return resolveCategoryBar(this.categories, {
        pageTab: this.pageTab,
        mode: this.mode,
        otherName: this.other.name,
        otherMet: this.other.met,
      })
    },
    // 运动历史要渲染的行 + 真实总数 + 还剩多少条没展开。
    // total 取全量长度（源实现拿 slice 之后的 length 当「共 N 条」，是假总数）；
    // name 已摘掉标题里的日期尾巴，日期只在 dateLabel 出现一次。
    historyView() {
      return buildHistoryRows(this.historyItems, {
        todayStr: this.historyToday,
        limit: this.historyLimit,
      })
    },
  },
  onShow() {
    this.pageVisible = true
    this.weight = getWeight()
    // 体重日志非空 = 用户真的填过体重（否则热量是按默认 60kg 估的，界面上要说明）
    try {
      this.weightKnown = getWeightLog().length > 0
    } catch (e) {
      this.weightKnown = false
    }
    this.loadTodayOther()
    this.loadTodayRuns()
    // 历史可能在「我的」/别的会话里被删过，进页面一律重读
    this.loadHistory()
    // 底图城市可能刚在地图页换掉：刷新一下，city-key 一变 map-view 就重建
    this.refreshMapCity()
    // 主题可能在别的页切过：回来的这一刻地图必须已经是对的颜色
    if (this.$refs && this.$refs.mvm && this.$refs.mvm.syncThemeNow) {
      this.$refs.mvm.syncThemeNow()
    }
    // 计时按真实时间校正：tick 会因系统节流丢，切回来数字不能偏
    if (this.state === 'running') {
      const ms = elapsedMs()
      if (ms >= 0) this.seconds = Math.floor(ms / 1000)
    }
    // 从后台回来时立刻按真实时间刷新一次，不用等下一个 tick
    if (this.otState === 'running') this.startOtTimer()
    // 后台保活是否真的在工作：对比切后台前后的轨迹点数，直接显示出来
    if (this.pointsAtHide >= 0) {
      this.bgGained = this.trackPoints.length - this.pointsAtHide
      this.pointsAtHide = -1
    }
  },
  onHide() {
    this.pageVisible = false
    // 只要在采集中就记下当前点数，回前台时算增量
    if (this.state !== 'idle') this.pointsAtHide = this.trackPoints.length
  },
  onUnload() {
    this.clearTimer()
    this.clearStepTimer()
    this.stopOtTimer()
    // 页面销毁时绝不能留下运行中的 GPS 监听
    if (this.offTrack) {
      this.offTrack()
      this.offTrack = null
    }
    stopTrack()
  },
  methods: {
    // ===== 底图城市 =====
    // 当前用的是哪个城市的离线包：装了就用下载的，没装就用包内自带的青岛包
    refreshMapCity() {
      const cur = getCurrent()
      const c = cur ? getCity(cur) : null
      const key = c ? c.adcode : 'bundled-qingdao'
      this.mapCityName = c ? c.name : '青岛（内置）'
      // 只有真的变了才改，避免每次 onShow 都触发地图重建
      if (this.mapCityKey !== key) this.mapCityKey = key
    },
    goMaps() {
      // 运动进行中切地图会让视图层重建，禁止，先结束运动
      if (this.state !== 'idle' || this.otState !== 'idle') {
        uni.showToast({ title: '先结束当前运动再切地图', icon: 'none' })
        return
      }
      uni.navigateTo({ url: '/pages/maps/maps' })
    },

    // ===== 顶部类别条（横向滚动） =====
    /**
     * 点一个类别：
     *   track（跑步 / 健走）→ 轨迹面板，并设定计步口径 mode
     *   met（骑行 / 游泳 / 篮球…）→ MET 计时面板，并**自动带上该动作的名称与 MET**（不用再选一次）
     *   兜底「其他运动」（无 MET）→ 只切面板、不动已选动作，搜索框与自定义动作就在那下面
     * 任一运动进行中都不允许切走：地图视图会被重建、计时状态会错乱。
     */
    pickCategory(c) {
      if (!c) return
      if (this.state !== 'idle' || this.otState !== 'idle') {
        uni.showToast({ title: '先结束当前运动', icon: 'none' })
        return
      }
      if (c.kind === 'track') {
        this.pageTab = 'track'
        this.mode = c.key
        return
      }
      this.pageTab = 'other'
      this.loadTodayOther()
      // 兜底类别没有 MET：保留用户已选的动作，只是把面板露出来（搜索/自定义的入口）
      if (!(Number(c.met) > 0)) return
      this.other.name = c.label
      this.other.met = Number(c.met)
      this.other.minutes = ''
      this.otherQuery = ''
      this.otherResults = []
      this.showCustom = false
      this.showManual = false
    },

    // ===== 其他运动的计时会话 =====
    otStart() {
      if (!(Number(this.other.met) > 0)) {
        uni.showToast({ title: '先选一个动作', icon: 'none' })
        return
      }
      this.otAccumMs = 0
      this.otStartedAt = Date.now()
      this.otState = 'running'
      this.startOtTimer()
    },
    otPause() {
      if (this.otState !== 'running') return
      this.otAccumMs = this.otElapsedMs
      this.otStartedAt = 0
      this.otState = 'paused'
      this.stopOtTimer()
    },
    otResume() {
      if (this.otState !== 'paused') return
      this.otStartedAt = Date.now()
      this.otState = 'running'
      this.startOtTimer()
    },
    // 结束：按实际计时落库（不足 5 秒视为误触，不记账）
    otFinish() {
      const ms = this.otElapsedMs
      if (ms < 5000) {
        // 误触保护：不记账，但**必须复位会话**。原来只弹一句 toast 就 return，
        // otState 还停在 running → 切类别时会被「先结束当前运动」一直拦住，
        // 而结束又记不了账，用户被卡在这条死胡同里。
        this.otReset()
        uni.showToast({ title: '不到 5 秒，已放弃', icon: 'none' })
        return
      }
      // 秒是唯一真值：分钟是换算出来的，别让 5 秒被四舍五入成 1 分钟
      const seconds = Math.round(ms / 1000)
      const calorie = Math.round((Number(this.other.met) || 0) * (Number(this.weight) || 0) * (ms / 3600000))
      addActivity(todayStr(), {
        name: this.other.name,
        met: this.other.met,
        seconds,
        calorie,
        weightUsed: this.weight,
      })
      const label = this.other.name
      this.otReset()
      this.other = { name: '', met: 0, minutes: '' }
      this.loadTodayOther()
      this.loadHistory() // 跨天历史里也要立刻出现这条
      uni.showToast({ title: `${label} ${this.formatDurationText(seconds)}已记录`, icon: 'success' })
    },
    // 放弃本场计时（不记账）。保留已选动作，用户可以立刻重新开始计时。
    otCancel() {
      if (this.otState === 'idle') return
      uni.showModal({
        title: '放弃本场计时',
        content: '本场计时不会记录，确定放弃吗？',
        success: (m) => {
          if (!m.confirm) return
          this.otReset()
          uni.showToast({ title: '已放弃本场计时', icon: 'none' })
        },
      })
    },
    otReset() {
      this.stopOtTimer()
      this.otState = 'idle'
      this.otStartedAt = 0
      this.otAccumMs = 0
      this.otNow = 0
      this.showManual = false
    },
    startOtTimer() {
      this.stopOtTimer()
      this.otNow = Date.now()
      // 只负责刷新界面，真实时长永远由时间戳算，节流也不影响结果
      this.otTimer = setInterval(() => {
        this.otNow = Date.now()
      }, 250)
    },
    stopOtTimer() {
      if (this.otTimer) {
        clearInterval(this.otTimer)
        this.otTimer = null
      }
    },

    // ===== 其他运动 =====
    searchOther() {
      this.otherResults = searchExercises(this.otherQuery, 12)
    },
    pickOther(item) {
      // 计时进行中换动作会丢掉已计的时间，先让用户结束
      if (this.otState !== 'idle') {
        uni.showToast({ title: '先结束当前计时', icon: 'none' })
        return
      }
      this.other.name = item.name
      this.other.met = Number(item.met) || 0
      this.other.minutes = ''
      this.otherResults = []
      this.otherQuery = ''
      this.showManual = false
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
      this.loadHistory() // 手动补录也要进跨天历史
      uni.showToast({ title: '已记录', icon: 'success' })
    },
    removeOther(id) {
      removeActivity(todayStr(), id)
      this.loadTodayOther()
      this.loadHistory()
    },
    // 时长文案：条目用 formatActivityDuration（秒为真值），汇总用 sumDuration
    durText(item) {
      return formatActivityDuration(item)
    },
    formatDurationText(seconds) {
      return formatActivityDuration({ seconds })
    },
    sumDuration(sum) {
      return formatActivityDuration({ seconds: sum.seconds })
    },
    loadTodayOther() {
      const list = getDayActivities(todayStr())
      this.todayOther = list
      this.otherSummary = summarizeActivities(list)
    },
    // 自定义动作：名称 + MET 都自己填，然后走同一条 MET 计算链
    useCustom() {
      if (this.otState !== 'idle') {
        uni.showToast({ title: '先结束当前计时', icon: 'none' })
        return
      }
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
      this.other.minutes = ''
      this.showCustom = false
      this.showManual = false
      this.custom = { name: '', met: '' }
    },

    // ===== 今日跑步 / 健走记录 =====
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
          this.loadHistory() // 同一份数据也在跨天历史里，一起刷
          uni.showToast({ title: '已删除', icon: 'success' })
        },
      })
    },
    distanceBrief(meters) {
      return formatDistance(meters)
    },

    // ===== 运动历史（跨天）=====
    loadHistory() {
      this.historyToday = todayStr()
      this.historyItems = allExerciseHistory()
    },
    moreHistory() {
      this.historyLimit = moreHistoryLimit(this.historyLimit, this.historyItems.length)
    },
    /**
     * 删除一条历史记录。两类记录存在**不同的表**里，必须按类型分流：
     *   跑步 / 健走 → storage.records，按 id 删（removeRecord）
     *   其他运动   → activity-store 按天存的表，要 date + id 删（removeActivity）
     * 必须二次确认：删掉就没了，没有撤销。
     */
    delHistory(r) {
      if (!r) return
      uni.showModal({
        title: '删除这条记录',
        content: `${r.date} 的${r.name}（${r.calorie} kcal），删除后当日运动消耗会同步减少。确定吗？`,
        success: (m) => {
          if (!m.confirm) return
          if (r.kind === 'activity') removeActivity(r.date, r.id)
          else removeRecord(r.id)
          // 同一份数据被三处展示（历史 / 今日记录 / 今日其他运动），一起刷新
          this.loadHistory()
          this.loadTodayRuns()
          this.loadTodayOther()
          uni.showToast({ title: '已删除', icon: 'success' })
        },
      })
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
      // 只有 idle 才允许开新会话。模板虽然只在 idle 渲染「开始运动」，
      // 但连点 / 程序化调用仍会进到这里（见 utils/sport-session.js 的 P0-2 说明）
      if (!guardStart(this.state)) return
      const token = ++this.sessionToken
      this.state = 'running'
      this.clearTimer()
      // 基线 = 会话开始时两路各自的读数（-1 表示该路尚未就绪，由首个有效读数兜底）
      const base0 = await getStepBranches()
      // ⚠️ await 窗口（非原生计步最长 3 s）里用户可能已经点了结束/暂停：
      // 那时 state 已归位，这里绝不能再往下建会话，否则会出现
      // 「state=idle 但 GPS 在采集、计时在自增」的幽灵会话，把切页签的守卫全废掉。
      if (!isCurrentSession(token, this.sessionToken)) return
      if (!afterAwait(this.state)) return this.abortSession(token)
      this.stepBase = base0.ok
        ? { counter: base0.counter, det: base0.det }
        : { counter: -1, det: -1 }
      this.liveSteps = 0

      // 启动 GPS 轨迹采集：App 端 track.js 会传 type='wgs84'，
      // 运行时透传 plus.geolocation 走系统定位，不需要任何地图厂商 key
      this.trackPoints = []
      this.gpsDistance = 0
      this.estimatedDistance = 0
      this.gpsError = ''
      // 新一轮回到底图（上一轮可能因越界降级了）；底图彻底坏了才继续用自绘层
      if (!this.mapBroken) {
        this.mapMode = 'basemap'
        this.mapFallbackText = ''
      }
      await startTrack() // ⚠️ 首次运行会弹系统定位授权框，是更长的 await 窗口
      if (!isCurrentSession(token, this.sessionToken)) {
        // 结束流程已经把本场作废了：刚建起来的采集必须撤掉，别留幽灵轨迹
        stopTrack()
        return
      }
      if (!afterAwait(this.state)) return this.abortSession(token)

      // 上一轮的订阅先退掉再挂新的：否则旧回调会继续写进已被复位的实例
      if (this.offTrack) {
        this.offTrack()
        this.offTrack = null
      }
      const first = getTrack()
      if (first && first.error) this.gpsError = first.error
      this.offTrack = onTrackUpdate((snap) => {
        if (!snap) return
        // 换引用以触发子组件重绘
        this.trackPoints = snap.points.slice()
        this.gpsDistance = snap.distance
        this.estimatedDistance = snap.estimatedDistance || 0
        if (snap.error) this.gpsError = snap.error
      })

      // 建计时器之前先清：两套 setInterval 会让秒数跑成两倍
      this.clearTimer()
      this.timer = setInterval(() => {
        this.seconds++
      }, 1000)
      // 实时刷新真实步数（读一次计步器较廉价；微信运动不走实时，结束时取差值）
      this.startStepSync()
    },
    // await 期间被暂停/结束：撤掉刚建的采集，整场回到 idle
    // （不留「state=paused 但采集/计时不在」的幽灵会话，用户可重新开始）
    abortSession(token) {
      if (!isCurrentSession(token, this.sessionToken)) return
      if (this.offTrack) {
        this.offTrack()
        this.offTrack = null
      }
      this.clearTimer()
      this.clearStepTimer()
      stopTrack()
      this.resetSession()
      // 用户是在「已显示暂停」之后才发现回到 idle 的，得给一句话解释，
      // 否则会以为点了暂停却丢了整场（这里只可能是窗口期点暂停这一条路径进来）
      uni.showToast({ title: '本场运动已取消', icon: 'none' })
    },
    pause() {
      if (this.state !== 'running') return
      this.state = 'paused'
      this.clearTimer()
      this.clearStepTimer()
      pauseTrack()
    },
    resume() {
      if (this.state !== 'paused') return
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
    /**
     * 计步自检：一次性快照 + 判定，解释「步数为什么算不出来」。
     * 判定逻辑与采集都在 utils/step-selftest.js（纯函数那半有 13 条单测），这里只负责弹窗。
     * 结论**同时写进剪贴板**：用户截不到屏也能直接粘给开发者。
     * 自检本身绝不能把页面搞崩 —— 任何异常都降级成一句 toast。
     */
    async stepSelfCheck() {
      try {
        // 静态 import（不用动态 import）：App 端 file:// webview 加载独立 chunk 有失败风险，
        // 真机上会表现成"点了没反应"；模块只有 ~160 行、依赖的 health/storage 本就在主包，
        // 静态引入只多约 2 KB，换来真机必成功。
        const r = buildStepReport(await collectStepFacts())
        uni.setClipboardData({ data: r.line + '\n' + r.verdictText, showToast: false })
        uni.showModal({
          title: '计步自检',
          content: r.line + '\n\n' + r.verdictText,
          showCancel: false,
          confirmText: '知道了',
        })
      } catch (e) {
        uni.showToast({ title: '自检失败：' + ((e && e.message) || e), icon: 'none' })
      }
    },
    async finish() {
      // 🔒 重入锁（P0-1）：结束流程里有两处 await（读计步、读当日步数），
      // 这期间「结束」按钮仍然在（state 还没归 idle），双击会 addRecord 两条、
      // daily.duration 加两次、syncDaily 推两次。锁必须在这里**同步**上。
      const gate = tapFinish({ state: this.state, finishing: this.finishing })
      if (!gate.proceed) return
      this.finishing = true
      // 作废在途的 start()：它在 await 之后还会把计时器/采集建起来（P0-2）
      this.sessionToken++

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

      // 阈值按秒真值判（P2-8）：原来先 Math.round 成分钟再比 <1，
      // 31 秒会被四舍五入成 1 分钟照样入库，与「不足 1 分钟丢弃」不符。
      const seconds = this.seconds
      if (shouldDiscardSession(seconds)) {
        uni.showToast({ title: '运动时间太短', icon: 'none' })
        this.resetSession()
        return
      }
      const minutes = sessionMinutes(seconds)

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
        // 热量口径 C：MET × 体重 × 时长（与计时卡上的实时值、与「其他运动」同一个公式）。
        // 用整场 seconds 而不是取整后的 minutes，长尾时长不会因为进位而虚增。
        calories: sessionCalorieByMet({
          met: this.modeMet,
          minutes: seconds / 60,
          weightKg: this.weight,
        }),
        // 把当时用的 MET 与体重一并落库：以后体重变了也能解释"这条为什么是这个数"
        // （与 activity-store 记 weightUsed 同一个思路）
        met: this.modeMet,
        weightUsed: this.weight,
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
      // 👇 这里的 daily.calories 与上面 record.calories **不是一回事**，故意保持按步数折算：
      //   record.calories = 这一场运动的消耗（口径 C：MET × 体重 × 时长）
      //   daily.calories  = 当日**全部**步数折算的总消耗（含日常走动），是每日总账的一环
      // 已验证不会重复计：day-summary 的 dayExercise/dayCalories 只读 records 与
      // activity-store，**从不读 getTodayData()**；daily.{steps,calories} 目前只有
      // cloud.syncDaily 在上传时读。所以把运动消耗改成 MET 口径不影响当日总账，
      // 也不能把 daily.calories 改成 MET —— 那会把"全天步数消耗"变成"运动消耗"，含义就错了。
      const todaySteps = await getTodaySteps()
      if (todaySteps > 0) daily.steps = todaySteps
      daily.calories = calcCaloriesBySteps(daily.steps || 0, this.weight)
      saveTodayData(daily)

      // 推云端（静默降级）
      syncDaily(daily, record)

      this.resetSession()
      uni.showToast({ title: '运动已保存', icon: 'success' })
      // 保存后刷新今日记录与跨天历史，否则要切页回来才看到
      this.loadTodayRuns()
      this.loadHistory()
    },
    resetSession() {
      // 一次清干净：字段清单在 utils/sport-session.js 的 mergeSessionReset（配了单测）。
      // 除了会话本字段，还包括**重入锁 finishing**、estimatedDistance（否则 idle 下
      // 仍显示「含估算 X 米」）、gpsError、mapMode/mapFallbackText（上一轮越界降级
      // 不该让用户下次还在自绘层）、pointsAtHide/bgGained（下次首屏的后台增点）。
      Object.assign(this, mergeSessionReset(this))
    },
  },
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  /* 底部多留一些，避免最后一张卡被固定 tabBar 压住 */
  padding: calc(var(--status-bar-height) + 32rpx) 32rpx 160rpx;
  background-color: $bg-page;
  display: flex;
  flex-direction: column;
}


/* 轨迹图 */
.map-wrap {
  margin-top: 32rpx;
  position: relative;
}
/* 底图切换入口：浮在地图右下角 */
.map-city-btn {
  position: absolute;
  right: 16rpx;
  bottom: 16rpx;
  display: flex;
  align-items: center;
  gap: 10rpx;
  padding: 10rpx 20rpx;
  border-radius: 999rpx;
  /* 之前写死深色底：亮色主题下变成"深色片+深色字"，字就看不见了 */
  background: var(--chip-bg);
  border: 1rpx solid var(--chip-line);
}
.map-city-txt {
  font-size: 22rpx;
  color: $text-main;
}
.map-city-arrow {
  font-size: 20rpx;
  color: var(--accent-text);
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
  border-radius: $btn-radius;
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
/* 热量口径说明：热量 = MET × 体重 × 时长，与步数无关（2026-11-20 口径 C） */
.timer-metric {
  margin-top: 24rpx;
  padding: 0 24rpx;
  font-size: 20rpx;
  color: $text-muted;
  text-align: center;
}
/* 未填体重时的提示：MET 口径下体重直接影响热量，按默认 60kg 算就得说清 */
.timer-metric-warn {
  margin-top: 6rpx;
  padding: 0 24rpx;
  font-size: 20rpx;
  color: var(--warm-text);
  text-align: center;
}
/* 临时诊断（定位后移除） */
.timer-diag {
  margin-top: 16rpx;
  font-size: 20rpx;
  color: $text-muted;
  word-break: break-all;
}
/* 计步自检按钮：单行小按钮 → 胶囊（卡片 28rpx / 方块 16rpx / 胶囊 999rpx 的设计语言），
   ghost 观感与卡片里的次要按钮一致，平面无渐变、颜色全走变量 */
.timer-check-btn {
  margin-top: 20rpx;
  padding: 14rpx 36rpx;
  border-radius: 999rpx;
  background: $bg-card-light;
  color: $text-main;
  font-size: 24rpx;
  border: 1rpx solid $border-subtle;
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
  border-radius: $btn-radius;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: $btn-font-lg;
  font-weight: 700;
}
.btn-primary {
  background: var(--accent);
  color: var(--on-accent);
}
.btn-ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}

/* ===== 顶部类别条：横向滚动、多类别 =====
   结构用 uni 官方横向滚动写法：scroll-view 上 white-space:nowrap，子项是 inline-flex
   （不再套一层 flex 容器 —— uni 的 scroll-view 内层包裹层布局随版本变，
   套 flex 容器有被压成容器宽、滚不动的风险）。
   选中态用「字号加大 + 字重 700 + 强调色」三重表达，**不填色块**（设计语言：平面无渐变）；
   强调色必须保留 —— 灰度/低饱和下它是唯一还能分辨选中项的维度。
   项高固定 88rpx（触摸目标 ≥88rpx），宽度随字号变化的过渡交给 transition 平滑，
   避免选中瞬间整条 bar 的后续项一起跳动。 */
.cat-bar {
  width: auto;
  /* 抵消 .page 的左右 padding：横向滑动时可以一路滑到屏幕边缘，不留死白边 */
  margin: 8rpx -32rpx 0;
  white-space: nowrap;
}
/* H5 / 桌面端藏掉横向滚动条，免得和卡片圆角打架 */
.cat-bar::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.cat-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 万一下层被包成 flex 容器也不会被压扁 */
  flex: 0 0 auto;
  height: 88rpx;
  min-width: 88rpx;
  margin-right: 6rpx;
  padding: 0 18rpx;
  font-size: 28rpx;
  font-weight: 400;
  color: $text-secondary;
  transition: font-size 0.18s ease, color 0.18s ease;
}
.cat-item:first-child {
  margin-left: 32rpx;
}
.cat-item:last-child {
  margin-right: 32rpx;
}
.cat-item.active {
  font-size: 34rpx;
  font-weight: 700;
  color: var(--accent-text);
}
/* 临时项标记（搜索/自定义选的动作）：一个极轻的点，不上底色 */
.cat-mark {
  margin-left: 2rpx;
  font-size: 20rpx;
  color: $text-muted;
  transform: translateY(-10rpx);
}

/* ===== 其他运动面板 ===== */
.ot-card {
  margin: 20rpx 24rpx 0;
  padding: $card-pad;
  border-radius: $card-radius;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}
.ot-title {
  font-size: $card-title-font;
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
  color: var(--accent-text);
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
  border-radius: $btn-radius;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 26rpx;
  font-weight: 700;
}
/* 计时区 */
.ot-timer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: 20rpx;
  padding: 22rpx 24rpx;
  border-radius: 18rpx;
  background: $bg-card-light;
  border: 1rpx solid $border-subtle;
}
.ot-timer-time {
  font-size: 72rpx;
  font-weight: 800;
  color: $text-main;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.ot-timer-right {
  display: flex;
  align-items: baseline;
  gap: 6rpx;
}
.ot-timer-cal {
  font-size: 40rpx;
  font-weight: 700;
  color: var(--warm-text);
  font-variant-numeric: tabular-nums;
}
.ot-timer-cal-unit {
  font-size: 20rpx;
  color: $text-secondary;
}
.ot-timer-hint {
  display: block;
  margin-top: 12rpx;
  font-size: 22rpx;
  color: $text-muted;
}
.ot-actions {
  display: flex;
  gap: 16rpx;
}
.ot-actions .ot-mini-btn {
  flex: 1;
}
.ot-mini-btn.ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}
.ot-mini-btn.wide {
  width: 100%;
}
.ot-picked {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.ot-picked-name {
  font-size: 32rpx;
  font-weight: 700;
  color: var(--accent-text);
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
  color: var(--warm-text);
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
  color: var(--warm-text);
}
.ot-item-del {
  font-size: 24rpx;
  color: $text-muted;
  padding-left: 8rpx;
}
/* 运动历史「展开更多」：整行可点的文字按钮，不描边不填色（与列表同层，不抢视觉） */
.ot-more {
  margin-top: 20rpx;
  padding: 16rpx 0;
  text-align: center;
  font-size: 24rpx;
  color: var(--accent-text);
}

/* 估算距离提示：只在信号中断后出现，说明这几十米是直线估算的 */
.timer-sub-note {
  display: block;
  margin-top: 2rpx;
  font-size: 18rpx;
  color: var(--text-3);
}

/* flat-press:2026-11-06 */
.btn:active,
.ot-mini-btn:active,
.map-city-btn:active,
.timer-check-btn:active {
  transform: scale(0.97);
  opacity: 0.9;
}
</style>
