<template>
  <view class="mv-root">
    <!-- 地图挂载点：
         App 端只有 renderjs（视图层）能拿到 DOM，用 :change: 把数据推给它；
         H5 端由普通 script 直接建图。两个平台共用 map-core.js 里的同一份建图逻辑。 -->
    <!-- #ifdef APP-PLUS -->
    <view
      class="mv-host"
      :id="hostId"
      :mvappmode="appMode"
      :change:mvappmode="mapView.onAppMode"
      :mvtheme="mapTheme"
      :change:mvtheme="mapView.onTheme"
      :mvsync="syncTick"
      :change:mvsync="mapView.onSync"
      :mvreset="resetTick"
      :change:mvreset="mapView.onReset"
      :mvhostid="hostId"
      :change:mvhostid="mapView.onHostId"
      :mvpoints="pointsPayload"
      :change:mvpoints="mapView.onPoints"
      :mvchunk="chunk"
      :change:mvchunk="mapView.onChunk"
      :mvvisible="visible"
      :change:mvvisible="mapView.onVisible"
      :mvsize="hostSize"
      :change:mvsize="mapView.onSize"
      :mvarchives="archivesPayload"
      :change:mvarchives="mapView.onArchives"
    ></view>
    <!-- #endif -->
    <!-- #ifdef H5 -->
    <view class="mv-host" ref="host" :id="hostId"></view>
    <!-- #endif -->

    <!-- 还没开始 / 还没定位到：地图本身照常显示（底图就在那儿） -->
    <view class="mv-hint" v-if="!failed && !hasPoints">
      <text class="mv-hint-text">{{ hintText }}</text>
    </view>

    <!-- ODbL 强制署名：右下角，常显，不藏 -->
    <view class="mv-attr"><text class="mv-attr-text">© OpenStreetMap</text></view>

    <!-- 诊断行：正常时 CSS 隐藏（不占可视面积），一旦有异常自动浮现。
         仍保留 DOM，方便自动化脚本读取 diagText。 -->
    <view class="mv-diag" :class="{ 'mv-diag-off': !diagShow }">
      <text class="mv-diag-text">{{ diagText }}</text>
    </view>
  </view>
</template>

<script>
// ===== 逻辑层 =====
// H5：在这里直接建图（H5 有 DOM，不需要 renderjs）。
// App：这里不建图，只负责「用 plus.io 把瓦片读出来、分块过桥」以及显示诊断行。
//      注意 App 逻辑层绝不能引 map-core.js（会把 maplibre 拖进没有 window 的 v8 层）。
import { readTilesViaPlusIo, TILE_FILES, tileUserPath, tileWww, plusLocalPath, openRangeHandle, readRangeB64 } from './tiles.js'
import { archivesChanged } from './archives-key.js'
import {
  getCurrent,
  isInstalled,
  getCity,
  getInstalledPath,
  getSourceMode,
  isRangeBad,
  markRangeBad,
  setReadProbe,
} from '@/utils/city-maps.js'
import { makeMapStatus, formatMapStatus } from './map-status.js'
// #ifdef H5
import { createTrackMap, probeWebgl, waitForSize } from './map-core.js'
import { tileUrlCandidates, loadTilesFromUrls, probeRangeRead, fetchRange } from './tiles.js'
// #endif

let seq = 0
// 跨层搬运 base64 的块大小：必须是 4 的倍数（base64 4 字符 = 3 字节），
// 这样视图层每块都能独立 atob，不用先 join 出一个 15MB 字符串。
const TILE_CHUNK_CHARS = 512 * 1024

// ===== R2 桥接用的文件句柄缓存（task-1）=====
// 必须放模块级、不能用 data()：Vue 会把 File 包成响应式代理，既浪费又可能破坏原生句柄。
// 键 = 档案 key + 落盘路径（多城市同名不会串）。
const RANGE_HANDLES = new Map()
function handleKeyOf(adcode, rel) {
  return String(adcode || 'builtin') + '|' + String(rel || '')
}
/** 切城市 / 卸载时清空并让句柄可回收（显式 dispose 语义：去掉引用即可） */
function clearRangeHandles() {
  try {
    RANGE_HANDLES.forEach((rec) => {
      if (rec) rec.file = null
    })
    RANGE_HANDLES.clear()
  } catch (e) {
    /* ignore */
  }
}

// H5 侧的「按需探测次数」计数（App 侧在 renderjs 里另有一份）。
// whole 模式下它必须保持 0 —— e2e 用 window.__mvDebug.rangeProbes() 断言。
let RANGE_PROBE_H5 = 0
function bumpH5Probe() {
  RANGE_PROBE_H5++
  try {
    if (typeof window !== 'undefined') {
      const dbg = window.__mvDebug || (window.__mvDebug = {})
      dbg.rangeProbes = () => RANGE_PROBE_H5
    }
  } catch (e) {
    /* ignore */
  }
}

export default {
  name: 'map-view',
  props: {
    // [{ lat, lng, ts, accuracy }]
    points: { type: Array, default: () => [] },
    visible: { type: Boolean, default: true },
    hintText: { type: String, default: '底图已就绪，开始运动后叠加轨迹' },
    // 当前底图城市的 adcode；变化时重建地图（切换城市后回到运动页生效）
    cityKey: { type: String, default: '' },
  },
  data() {
    return {
      hostId: 'mv-host-' + ++seq,
      hostSize: null, // App：逻辑层量好的容器像素尺寸，跨层给视图层用（见 measureHost）
      appMode: false, // App：置 true 触发 renderjs 启动（H5 永远 false，renderjs 保持惰性）
      booted: false, // 本平台是否真的走了建图分支（H5 / App），其它平台直接回退
      tick: 0, // 每次轨迹更新自增，保证过桥的值一定「变了」
      chunk: null, // App：跨层搬运的 base64 分块 { i, n, b64 }
      archives: [], // 当前要加载的档案 [{file, where:'bundled'|'user', adcode}]
      diagText: '',
      diagShow: false, // 诊断行是否可见：正常时隐藏，出错才露出
      ready: false,
      failed: false,
      status: null,
      core: null, // H5：map-core 控制器
      timer: null, // 诊断行定时刷新
      renderjsAlive: false, // App：视图层是否回过状态
      renderjsWatchdog: null,
      // 逻辑层侧的分块状态（App 专用）
      tileB64: '',
      tileChunkCount: 0,
      currentFile: 0, // 当前正在传的档案下标（多档案逐个过桥）
      mapTheme: 'dark', // 地图色标：dark / light（跟随全局主题）
      syncTick: 0, // 切回本页时自增，强制把主题对齐一次
      resetTick: 0, // 切城市时自增：让视图层彻底销毁旧地图再重建
      sourceModeSel: 'auto', // 数据源策略（storage 覆盖 > 代码常量），随档案一起推给视图层
    }
  },
  computed: {
    hasPoints() {
      return !!(this.points && this.points.length)
    },
    // 新对象 + 自增 tick：即使数组引用被复用，change 也一定会触发
    pointsPayload() {
      return { n: this.tick, list: this.points }
    },
    // App：把档案清单推给视图层（视图层与逻辑层是两个 JS 上下文，不能共享模块状态）。
    // task-1 起顺带带上数据源策略与本机「Range 判不通」的标记：
    // 策略一变，payload 就变，视图层据此重建（改完 storage 下次进运动页即生效）。
    archivesPayload() {
      const bad = []
      try {
        const cur = getCurrent()
        if (cur && isRangeBad(cur)) bad.push(cur)
        if (isRangeBad('builtin')) bad.push('builtin')
      } catch (e) {
        /* ignore */
      }
      return JSON.stringify({
        list: this.archives || [],
        mode: this.sourceModeSel || 'auto',
        bad: bad,
      })
    },
  },
  watch: {
    // 全局主题变化 → 地图跟着换色标（只重建 style，不重新读瓦片）
    theme: {
      immediate: true,
      handler(v) {
        const next = v === 'light' ? 'light' : 'dark'
        this.mapTheme = next
        // H5 走的是逻辑层建图（没有 renderjs），所以要在这里也切一次；
        // App 端由 renderjs 的 onTheme 负责，这条对它是重复调用但有幂等保护。
        if (this.core && this.core.setTheme) {
          // 用户要求：App 开着就要一直渲染，别为省电把渲染攒到可见再补。
          // 换色标是一次性事件（不是每帧），开销可忽略，直接应用。
          try {
            this.core.setTheme(next)
          } catch (e) {
            /* ignore */
          }
        }
      },
    },
    // 城市变了就整图重建：档案换了、中心点和 bbox 都要重新从包头发起
    cityKey() {
      if (this.booted || this.appMode) this.reloadForCity()
    },
    points() {
      this.tick++
      // #ifdef H5
      if (this.core && this.core.setPoints) this.core.setPoints(this.points)
      // #endif
    },
    visible(v) {
      // 每次回到本页都对一次「数据源策略」：用户可能刚在地图页把整包/按需切过。
      // 不在这里对，storage 改了也得等下次切城市才生效。
      if (v) {
        try {
          const m = getSourceMode() || 'auto'
          if (m !== this.sourceModeSel) {
            this.sourceModeSel = m
            this.reloadForCity()
            return
          }
        } catch (e) {
          /* ignore */
        }
      }
      // #ifdef H5
      // 只做尺寸恢复；轮询与渲染**不停**（App 开着就连续渲染）
      if (this.core && this.core.setVisible) this.core.setVisible(v)
      if (v) this.pushStatus()
      // #endif
    },
  },
  mounted() {
    this.status = makeMapStatus()
    // #ifdef H5
    this.booted = true
    this.status.webgl = probeWebgl() ? 'ok' : 'fail'
    this.status.renderjs = 'n/a' // H5 走普通 script，不用 renderjs
    this.pushStatus()
    this.$nextTick(() => this.bootH5())
    // #endif
    // #ifdef APP-PLUS
    this.booted = true
    this.status.webgl = '-'
    this.status.renderjs = '-'
    this.pushStatus()
    // 置 true -> 触发 :change:mvappmode -> renderjs 启动
    this.appMode = true
    // 尺寸必须在逻辑层量：真机实测视图层（renderjs）量 .mv-host 恒为 0，
    // 而逻辑层的 createSelectorQuery 同一时机能量到（同页自绘轨迹图就是靠它正常铺满的）。
    this.measureHost()
    // 视图层迟迟没有任何回调：说明 renderjs 根本没跑起来（和「跑了但 WebGL 不行」
    // 是两回事）。这条诊断行是这轮 APK 的主要目的，必须能区分开。
    this.renderjsWatchdog = setTimeout(() => {
      if (!this.renderjsAlive) {
        this.status.renderjs = 'fail'
        this.status.err = 'renderjs 未启动（视图层无回调）'
        this.pushStatus()
      }
    }, 6000)
    // #endif
    // 既没有 H5 的 DOM、也没有 App 的 renderjs 的平台（小程序等）：本轮不支持底图，
    // 立刻上报失败，让父级切回 track-map 自绘层 —— 否则会留下一块空白地图。
    if (!this.booted) this.$nextTick(() => this.failH5('当前平台不支持离线底图'))
  },
  beforeUnmount() {
    this.clearWatchdog()
    this.teardownH5()
    // 组件卸载：把 R2 桥接用的文件句柄全部放掉，别留悬空引用
    clearRangeHandles()
  },
  methods: {
    /**
     * 切回本页时调用：确保"回来的那一刻地图已经是当前主题"。
     * 做法是把 mapTheme 重新赋值并自增 syncTick —— 值变化才会触发 renderjs 的 change 回调，
     * 光改 mapTheme 在"值没变"的情况下根本不会通知视图层。
     */
    syncThemeNow() {
      const want = this.theme === 'light' ? 'light' : 'dark'
      this.mapTheme = want
      this.syncTick = (this.syncTick || 0) + 1
      // H5 走逻辑层建图，可以立刻切
      if (this.core && this.core.setTheme) {
        try {
          this.core.setTheme(want)
        } catch (e) {
          /* ignore */
        }
      }
    },
    pushStatus() {
      this.diagText = formatMapStatus(this.status)
      // 只有「出问题」时才把诊断行露出来：正常跑步时不该有一行调试字挡在地图上。
      // 判断口径：硬失败 / 视图层或建图失败 / err 里有非空内容。
      const s = this.status || {}
      const err = String(s.err || '').trim()
      this.diagShow = !!(
        this.failed ||
        s.renderjs === 'fail' ||
        s.maplibre === 'fail' ||
        (err && err !== '-')
      )
    },

    // 逻辑层量地图容器尺寸，跨层推给 renderjs（视图层自己量不到，见 mounted 注释）。
    // 布局未就绪就重试几次，量到即写 hostSize；量不到就让视图层走视口兜底。
    measureHost(attempt) {
      const n = attempt || 0
      uni
        .createSelectorQuery()
        .in(this)
        .select('.mv-host')
        .boundingClientRect((r) => {
          const w = r && Math.round(r.width)
          const h = r && Math.round(r.height)
          if (w > 0 && h > 0) {
            this.hostSize = { w: w, h: h }
          } else if (n < 15) {
            setTimeout(() => this.measureHost(n + 1), 120)
          }
        })
        .exec()
    },

    // 决定这次要加载哪些档案：装了城市包就用它，否则用包内自带的青岛包
    resolveArchives() {
      // 数据源策略：storage 覆盖优先（改完下次建图即生效），否则用代码常量（map-core 里的 auto）
      try {
        this.sourceModeSel = getSourceMode() || 'auto'
      } catch (e) {
        this.sourceModeSel = 'auto'
      }
      const cur = getCurrent()
      if (cur && isInstalled(cur)) {
        const c = getCity(cur)
        if (c) {
          const rel = getInstalledPath(c.adcode) || ''
          // abs 给视图层的 R1 探测用（fetch 需要设备绝对路径，逻辑层才拿得到）
          this.archives = [{ file: c.adcode + '.pmtiles', where: 'user', adcode: c.adcode, name: c.name, path: rel, abs: rel ? plusLocalPath(rel) || '' : '', center: Array.isArray(c.center) ? c.center : null }]
          return this.archives
        }
      }
      // 内置青岛包：包自带中心落在胶州湾水面，这里改用市南区坐标
      this.archives = (TILE_FILES || []).map((f) => ({
        file: f,
        where: 'bundled',
        center: [120.3845, 36.0605],
        abs: plusLocalPath(tileWww(f)) || '',
      }))
      return this.archives
    },
    // 切换城市后重建地图（档案换了，中心点/bbox 也要重新从包头发起）
    reloadForCity() {
      // ★ 必须先重算档案：以前只在 H5 分支里调 resolveArchives()，
      //   App 端切城市时 archives 还是旧城市 → 视图层建出来的还是旧底图。
      this.resolveArchives()
      // 旧城市的文件句柄不再需要（留着只会拖着已删除/被替换的文件）
      clearRangeHandles()
      this.teardownH5()
      this.ready = false
      this.failed = false
      this.core = null
      // 诊断字段归零：新城市建图前不该还挂着旧城市的瓦片数与错误（P2-13/P2-14）。
      // App 端的诊断行由视图层 mwStatus 覆盖，那边也有同样的归零（resetDiag）。
      if (this.status) {
        this.status.tiles = 0
        this.status.err = ''
        this.status.src = ''
        this.pushStatus()
      }
      // 通知视图层：销毁旧地图重新建。
      // 光把 appMode 抖成 false→true 不够 —— 视图层 onAppMode 的守卫是 !this.core，
      // 旧 core 还在，boot() 会被直接跳过，地图就永远停在旧城市。
      this.resetTick = (this.resetTick || 0) + 1
      // #ifdef APP-PLUS
      this.appMode = false
      this.$nextTick(() => {
        this.appMode = true
      })
      // #endif
      // #ifdef H5
      this.$nextTick(() => this.bootH5())
      // #endif
    },

    // ===== H5 =====
    async bootH5() {
      // #ifdef H5
      const el = this.resolveHostEl()
      if (!el) return this.failH5('找不到地图容器 DOM')
      const size = await waitForSize(el, 6000)
      if (!size.w || !size.h) return this.failH5('地图容器尺寸为 0（布局未就绪）')
      this.resolveArchives()
      // 逐个档案加载，取到几个用几个（缺文件不致命）
      const archives = []
      const notes = []
      let rangeSize = 0 // H5 走按需读取时的整包大小（诊断/自检要显示）
      for (let i = 0; i < this.archives.length; i++) {
        const a = this.archives[i]
        let bytes = null
        let srcText = ''
        if (a.where === 'user') {
          // H5 端下载的包存在 IndexedDB 里（IDB 不支持部分读 → 本轮仍整包，见 task-4）
          const mod = await import('@/utils/city-map-download.js')
          bytes = await mod.readPackedBytes(a.adcode)
          srcText = 'idb'
          if (!bytes) notes.push(a.file + '✗(未下载)')
        } else if (this.sourceModeSel !== 'whole') {
          // task-1：H5 的包内档案走 fetch+Range（静态服务器支持 206 时生效）。
          // 服务器不支持 Range（返回 200 整包）时探测会判成 whole-file，这里自动落回整包。
          const cands = tileUrlCandidates(a.file)
          let picked = null
          for (let k = 0; k < cands.length; k++) {
            bumpH5Probe()
            const pr = await probeRangeRead(cands[k], { timeoutMs: 800 })
            // 要求 size 合理（>1 KB）：探测若只拿到分片长度，后续所有读取都会被截成 0
            // → pmtiles 静默放弃、地图纯灰空白（真机已复现），所以这里必须挡住。
            if (pr && pr.ok && pr.size > 1024) {
              picked = { url: cands[k], size: pr.size }
              break
            }
            if (pr && pr.kind === 'whole-file') break
          }
          if (picked) {
            rangeSize = picked.size
            archives.push({
              key: a.file,
              size: picked.size,
              via: 'range-H5',
              reader: (o, l) => fetchRange(picked.url, o, l, { timeoutMs: 8000 }),
            })
            notes.push(a.file + '←range')
            continue
          }
          // 探测不通：走下面的整包 fetch（老路径）
          let r = null
          try {
            r = await loadTilesFromUrls(cands)
          } catch (e) {
            r = { bytes: null, err: (e && e.message) || String(e) }
          }
          if (r && r.bytes) {
            bytes = r.bytes
            srcText = String(r.src || '').replace(/^[a-z]+@/, '')
          } else {
            notes.push(a.file + '✗')
          }
        } else {
          let r = null
          try {
            r = await loadTilesFromUrls(tileUrlCandidates(a.file))
          } catch (e) {
            r = { bytes: null, err: (e && e.message) || String(e) }
          }
          if (r && r.bytes) {
            bytes = r.bytes
            srcText = String(r.src || '').replace(/^[a-z]+@/, '')
          } else {
            notes.push(a.file + '✗')
          }
        }
        if (bytes) {
          archives.push({ key: a.file, bytes: bytes })
          notes.push(a.file + '←' + srcText)
        }
      }
      if (!archives.length) return this.failH5('读取底图数据失败: 一个档案都没读到')
      this.status.src = notes.join(' ')
      this.pushStatus()
      try {
        this.core = createTrackMap({
          container: el,
        center: (this.archives[0] && this.archives[0].center) || null,
          archives: archives,
          status: this.status,
          theme: this.mapTheme,
          points: this.points,
          // task-1：H5 也走同一处分派（auto/range/whole）
          sourceMode: this.sourceModeSel === 'whole' ? 'whole' : this.sourceModeSel === 'range' ? 'range' : 'auto',
          onOutOfBounds: (b) => this.$emit('outofbounds', b),
          onReady: () => {
            this.ready = true
            // 建图成功就开始盯主题 class（App 端主题切换的主通道）
            this.watchThemeClass()
            // H5 也在逻辑层，直接写记录（不必走跨层 callMethod）
            try {
              setReadProbe({
                mode: this.core && this.core.getSourceMode ? this.core.getSourceMode() : this.sourceModeSel,
                r1: 'h5:' + (this.status.srcMode || '') + (rangeSize ? ' size=' + rangeSize : ''),
                r2: '(H5 不用桥接)',
                readStats: this.status.readStats || '',
              })
            } catch (e) {
              /* ignore */
            }
          },
        })
      } catch (e) {
        return this.failH5('建图异常: ' + ((e && e.message) || e))
      }
      this.core.setVisible(this.visible)
      this.startStatusTimer()
      // #endif
    },
    resolveHostEl() {
      // #ifdef H5
      const ref = this.$refs && this.$refs.host
      const el = (ref && (ref.$el || ref)) || null
      if (el && el.appendChild) return el
      return document.getElementById(this.hostId) || null
      // #endif
      return null
    },
    /** 状态轮询：只在页面可见时跑，切走就停（省电，回来立刻补一次） */
    startStatusTimer() {
      this.stopStatusTimer()
      this.timer = setInterval(() => this.pushStatus(), 1000)
    },
    stopStatusTimer() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },
    isVisibleNow() {
      return this.visible !== false
    },
    clearWatchdog() {
      if (this.renderjsWatchdog) {
        clearTimeout(this.renderjsWatchdog)
        this.renderjsWatchdog = null
      }
    },
    teardownH5() {
      this.stopStatusTimer()
      // #ifdef H5
      if (this.core) {
        this.core.destroy()
        this.core = null
      }
      // #endif
    },
    failH5(reason) {
      this.failed = true
      if (this.status) {
        this.status.err = reason
        this.pushStatus()
      }
      this.$emit('fail', reason)
    },

    // ===== App：renderjs 回调（逻辑层方法，被视图层 callMethod 调用）=====
    mwStatus(text) {
      this.renderjsAlive = true
      this.clearWatchdog()
      if (text) this.diagText = text
    },
    mwReady() {
      this.ready = true
    },
    mwFail(reason) {
      this.failed = true
      this.$emit('fail', reason || '底图视图层初始化失败')
    },
    mwOutOfBounds(b) {
      this.$emit('outofbounds', b)
    },
    // 视图层自己拿不到字节时，请求逻辑层用 plus.io 读（多档案：payload.f 指哪一份）
    mwNeedTiles(payload) {
      // #ifdef APP-PLUS
      const p = payload && typeof payload === 'object' ? payload : {}
      const f = typeof p.f === 'number' ? p.f : 0
      const a = (this.archives && this.archives[f]) || null
      const file = a ? a.file : TILE_FILES[f]
      if (!file) {
        this.chunk = { f: f, i: 0, n: 0, b64: '', err: '档案下标越界: ' + f }
        return
      }
      this.currentFile = f
      this.tileB64 = ''
      this.tileChunkCount = 0
      // 用户下载包在 _doc/maps/，包内自带的在 _www/static/tiles/
      const absPath = a && a.where === 'user' ? getInstalledPath(a.adcode) || tileUserPath(file) : ''
      const started = readTilesViaPlusIo(
        file,
        (b64) => {
          // 分块时按 4 字符对齐（base64 4 字符 = 3 字节），每块都能独立解码
          this.tileB64 = b64
          this.tileChunkCount = Math.ceil(b64.length / TILE_CHUNK_CHARS)
          this.pushChunk(0)
        },
        // 这一份读失败不该拖垮整个底图：用 n=0 的错误块告诉视图层「跳过这份，继续下一份」
        (err) => {
          this.chunk = { f: f, i: 0, n: 0, b64: '', err: String(err) }
        },
        absPath
      )
      if (!started) {
        this.chunk = { f: f, i: 0, n: 0, b64: '', err: '逻辑层 plus.io 不可用' }
      }
      // #endif
    },
    // 视图层收一块回一次，别一次性把 15MB 字符串压过桥
    mwChunkAck(i) {
      // #ifdef APP-PLUS
      this.pushChunk(i + 1)
      // #endif
    },
    pushChunk(i) {
      // 不预先切好整份数组（那会多留一份 ~15MB 拷贝），按需 slice
      const b64 = this.tileB64
      const n = this.tileChunkCount
      if (!b64 || i >= n) {
        if (b64) this.tileB64 = '' // 发完就放，别攥着 15MB
        return
      }
      this.chunk = { f: this.currentFile, i: i, n: n, b64: b64.slice(i * TILE_CHUNK_CHARS, (i + 1) * TILE_CHUNK_CHARS) }
    },

    // ===== R2 桥接：视图层请求读一段字节（task-1）=====
    // 与 mwNeedTiles（整包过桥）完全独立；whole 模式下这个方法永远不会被调用。
    //
    // 三条纪律：
    //  ① 读不到就回 `err`，**绝不回空数据**（空数据会被 pmtiles 当成"瓦片全黑"）；
    //  ② 句柄失效只重开一次，第二次还失败立即回 err（不许无限重试）；
    //  ③ 句柄缓存在模块级 Map 里，切城市/卸载时清空。
    mwReadRange(payload) {
      // #ifdef APP-PLUS
      const p = payload && typeof payload === 'object' ? payload : {}
      const reqId = p.reqId
      const f = typeof p.f === 'number' ? p.f : 0
      const offset = Math.max(0, Math.floor(Number(p.offset) || 0))
      const length = Math.max(0, Math.floor(Number(p.length) || 0))
      const a = (this.archives && this.archives[f]) || null
      const file = a ? a.file : TILE_FILES[f]
      const respond = (obj) => {
        this.chunk = Object.assign({ f: f, reqId: reqId }, obj)
      }
      if (!file) {
        respond({ err: '档案下标越界: ' + f })
        return
      }
      // 用户下载包在 _doc/maps/（或保存退路目录），包内自带在 _www/static/tiles/
      const rel = a && a.where === 'user' ? getInstalledPath(a.adcode) || tileUserPath(file) : tileWww(file)
      const key = handleKeyOf(a && a.adcode, rel)
      const absPath = plusLocalPath(rel) || ''
      const readOnce = (handle) =>
        readRangeB64(handle, absPath, offset, length, 4000).catch((e) => ({ ok: false, err: (e && e.message) || String(e) }))
      const work = async () => {
        let rec = RANGE_HANDLES.get(key)
        let handle = rec && rec.file
        if (!handle) {
          handle = await openRangeHandle(rel, 6000)
          if (handle) RANGE_HANDLES.set(key, { file: handle, rel: rel })
        }
        if (!handle) {
          respond({ err: '打不开文件: ' + rel })
          return
        }
        let r = await readOnce(handle)
        if (!r || !r.ok) {
          // 只允许重开一次：切城市/文件被替换后旧句柄会失效，但无限重试会把桥堵死
          const again = await openRangeHandle(rel, 6000)
          if (!again) {
            respond({ err: (r && r.err) || '读取失败（重开句柄也失败）' })
            return
          }
          RANGE_HANDLES.set(key, { file: again, rel: rel })
          r = await readOnce(again)
        }
        if (!r || !r.ok) {
          respond({ err: (r && r.err) || '读取失败' })
          return
        }
        respond({ b64: r.b64, size: (handle && handle.size) || 0 })
      }
      work().catch((e) => respond({ err: (e && e.message) || String(e) }))
      // #endif
    },
    /** 视图层建图完成后回报实测结果（视图层没有 uni，只能由逻辑层代写 storage） */
    mwRecordProbe(rec) {
      try {
        setReadProbe(rec && typeof rec === 'object' ? rec : {})
      } catch (e) {
        /* ignore */
      }
    },
    /** 视图层判定「这台机器这个包 Range 不通」→ 记住，下次自动模式直接跳级 */
    mwMarkRangeBad(p) {
      try {
        const o = p && typeof p === 'object' ? p : {}
        const ad = o.adcode || (this.archives[0] && this.archives[0].adcode) || 'builtin'
        markRangeBad(ad, o.why || '')
      } catch (e) {
        /* ignore */
      }
    },
  },
}
</script>

<script module="mapView" lang="renderjs">
// ===== 视图层（App）：只有 renderjs 能拿到 DOM =====
// 建图逻辑一行都不在这里重复：全部走 map-core.js。
import { createTrackMap, probeWebgl, waitForSize, prepareWorker } from './map-core.js'
import { looksLikeElement, describeValue } from './dom.js'
import { makeMapStatus, formatMapStatus } from './map-status.js'
import {
  tileUrlCandidates,
  loadTilesFromUrls,
  readTilesViaPlusIo,
  base64ToBytes,
  hasPlusIo,
  TILE_FILES,
  toPlusUrl,
  probeRangeRead,
  fetchRange,
  magic7Ok,
} from './tiles.js'
import { archivesChanged } from './archives-key.js'
import { createBridgeReader } from './range-bridge.js'
import { formatReadStats } from './range-source.js'

// 「新代码是否真的零进入」的判据（task-1）：whole 模式下这个计数必须保持 0。
// 暴露到 window.__mvDebug.rangeProbes()，e2e 直接断言，不依赖 UI 点击。
let RANGE_PROBE_COUNT = 0
function bumpProbe(n) {
  RANGE_PROBE_COUNT += n || 1
  try {
    if (typeof window !== 'undefined') {
      const dbg = window.__mvDebug || (window.__mvDebug = {})
      dbg.rangeProbes = () => RANGE_PROBE_COUNT
    }
  } catch (e) {
    /* ignore */
  }
}

// 视图层拿到的过桥数据在不同运行时可能是对象、也可能是 JSON 串，两种都认
function asObj(v) {
  if (v && typeof v === 'object') return v
  if (typeof v === 'string') {
    try {
      return JSON.parse(v)
    } catch (e) {
      return null
    }
  }
  return null
}

// 真机实测：renderjs 里的 `this.$el` 不是 DOM 元素（是个真值包装对象），
// 直接当 container 传给 MapLibre 会抛：
//   Invalid type: 'container' must be a String or HTMLElement.
// 所以容器一律按 nodeType 校验（looksLikeElement 见 dom.js），并缓存在模块作用域
// ——不随 data() 重建而丢失。
let HOST_EL = null

// R2 桥接渠道：**放模块级 Map**，键 = 实例 id + 档案下标。
//
// 为什么不再挂到组件实例上：真机 webview 会**静默丢弃**「未在 data() 里声明」的新字段
// （`this.bridges = {}` 不生效），紧接着的 `this.bridges[key] = …` 就成了给 undefined
// 赋属性 —— 报 "Cannot set properties of undefined (setting '0')"，整张底图退回自绘层。
// 模块级 Map 既不依赖实例是否可扩展，也天然随实例 id 隔离。
const BRIDGE_MAP = new Map()
let BRIDGE_INST_SEQ = 0

// 主题 MutationObserver 同理放模块级：MutationObserver 有品牌检查，
// 放进 data() 会被 Vue 包成响应式代理，个别 WebView 上调 .observe() 会报 Illegal invocation。
const THEME_MO_MAP = new Map()

export default {
  data() {
    return {
      core: null,
      status: null,
      booting: false,
      lastPoints: [],
      mapTheme: 'dark', // 地图色标：dark / light
      hostId: '',
      el: null,
      hostSize: null, // 逻辑层推下来的容器像素尺寸（首选，视图层自己量不到）
      tileAbs: '', // 成功读通瓦片的绝对 URL（用于推导同源 worker 地址）
      archiveList: [], // 逻辑层推下来的档案清单 [{file, where, adcode}]
      collected: null, // 已拿到的档案 [{ key, bytes }]
      pending: null, // 还没拿到、排队走 plus.io 过桥的档案下标
      curFile: 0, // 当前正在过桥的档案下标
      chunkParts: null, // 每块 base64 立刻解码成字节，避免最后拼一个 15MB 字符串
      chunkN: 0,
      chunkGot: 0,
      chunkBytes: 0,
      instId: 'mvi-' + ++BRIDGE_INST_SEQ, // 桥接渠道按实例 id 存在模块级 Map 里
      sourceMode: 'auto', // 逻辑层推下来的数据源策略：auto / range / whole
      badRanges: [], // 逻辑层推下来的「本机 Range 判不通」档案标记
      bridgeSize: 0, // R2 探测时逻辑层回报的文件字节数
      r1Text: '', // R1 探测结论（写进诊断）
      // 以下三项原来是"未声明字段"（this.__lastReset / this._pushRetry），
      // 在 renderjs 里写未声明字段可能被静默丢弃（表现为防抖失效 / 状态重试失效），
      // 一律改成 data 里的正经字段。
      lastResetAt: 0, // onReset 防抖时间戳
      pushRetry: 0, // pushStatus 在 $ownerInstance 未就绪时的重试计数
      timer: null,
    }
  },
  mounted() {
    this.status = makeMapStatus()
    // 最早的存活信号：视图层模块只要加载成功就会走到这里。
    // 逻辑层 watchdog 靠这一条区分「模块根本没加载」和「加载了但 boot 中途失败」。
    this.status.renderjs = 'ok'
    this.pushStatus()
  },
  beforeDestroy() {
    this.stop()
  },
  methods: {
    // 逻辑层第一次把 appMode 推成 true -> 真正启动
    onAppMode(v) {
      // #ifdef APP-PLUS
      if (v && !this.booting && !this.core) {
        // 首帧 prop 不会触发 change 回调 → 直接问 DOM 要主题（页面根节点带 t-dark / t-light）。
        // 之前靠 this.mvtheme，真机上拿不到就一直按暗色建图，表现就是"切了白天，地图还是黑的"。
        this.syncThemeFromDom()
        this.boot()
      }
      // #endif
    },
    /**
     * 切城市：把旧地图彻底销毁后重建。
     * 一定要 destroy() —— 否则旧 core 里的 PMTiles 协议注册、source、canvas 都留着，
     * 新档案即使传进来也可能被旧实例吞掉。
     */
    onReset() {
      // onArchives（档案变了）与 mvreset（逻辑层信号）几乎同时到达，防抖避免建两次图
      const now = Date.now()
      if (this.lastResetAt && now - this.lastResetAt < 500) return
      this.lastResetAt = now
      try {
        if (this.core && this.core.destroy) this.core.destroy()
      } catch (e) {
        /* ignore */
      }
      this.booting = false
      this.core = null
      this.collected = null
      this.pending = null
      this.curFile = 0
      // 跨层分块状态必须一起清干净（P1-7）：
      // 切城市完全可能正好发生在 base64 过桥的中途，残留的 chunkParts/chunkGot
      // 会把旧档案的半块并进新档案的拼装（拼装完成判据是 chunkGot >= chunkN），
      // 拼出错误字节 → PMTiles 头校验不过 → 真机上表现成「一个瓦片档案都没读到」。
      this.chunkParts = null
      this.chunkN = 0
      this.chunkGot = 0
      this.chunkBytes = 0
      // 桥接渠道也要收尾：在途请求全部 reject，别让旧城市的读请求挂到新地图上
      this.destroyBridges('切城市/重建')
      this.bridgeSize = 0
      this.r1Text = ''
      this.tileAbs = ''
      // 视图层没有 `ready` 字段（那是逻辑层的）：原来这里写 this.ready = false
      // 属于「给未声明字段赋值」，真机可能被静默丢弃 —— 删掉，避免同类隐患。
      // 新城市建图前不该显示上一个城市的瓦片数与错误（P2-13/P2-14）
      this.resetDiag()
      this.syncThemeFromDom()
      this.boot()
    },
    /** 重建地图前把诊断字段归零：避免旧城市的 tiles 计数与 err 挂在新地图上 */
    resetDiag() {
      if (!this.status) return
      this.status.tiles = 0
      this.status.err = ''
      this.status.src = ''
      this.pushStatus()
    },
    /** 逻辑层要求强制对齐（切回页面时）：以 DOM 为准再切一次 */
    onSync() {
      this.syncThemeFromDom()
      if (this.core && this.core.setTheme) {
        try {
          this.core.setTheme(this.mapTheme)
        } catch (e) {
          /* ignore */
        }
      }
      // 页面重新可见：把状态轮询拉起来
      this.startStatusTimer()
      this.pushStatus()
    },
    /** 从 DOM 读当前主题：页面根节点的 class 是唯一不会滞后的事实来源 */
    readThemeFromDom() {
      try {
        const el = this.el || document.querySelector('.mv-root')
        const host = el && el.closest ? el.closest('.t-light, .t-dark') : null
        if (host) return host.classList.contains('t-light') ? 'light' : 'dark'
        const page = document.querySelector('.page')
        if (page && page.className) {
          return String(page.className).indexOf('t-light') >= 0 ? 'light' : 'dark'
        }
      } catch (e) {
        /* ignore */
      }
      return ''
    },
    /** 对齐一次 DOM 主题（建图前调用） */
    syncThemeFromDom() {
      const t = this.readThemeFromDom()
      if (t) this.mapTheme = t
      else if (typeof this.mvtheme === 'string') this.mapTheme = this.mvtheme === 'light' ? 'light' : 'dark'
    },
    /**
     * 盯住页面根节点的 class 变化：主题一变立刻换色标。
     * 不走逻辑层 props 通道 —— 那条通道在 App 上是批处理投递的，会慢一拍。
     */
    watchThemeClass() {
      try {
        const id = this.instId || 'mvi-0'
        if (THEME_MO_MAP.get(id) || typeof MutationObserver === 'undefined') return
        const el = this.el || document.querySelector('.mv-root')
        const host = (el && el.closest && el.closest('.t-light, .t-dark')) || document.querySelector('.page')
        if (!host) return
        const mo = new MutationObserver(() => {
          const t = this.readThemeFromDom()
          if (t && t !== this.mapTheme) {
            this.mapTheme = t
            if (this.core && this.core.setTheme) {
              // 直接应用：渲染不等可见（用户要求连续渲染）
              try {
                this.core.setTheme(t)
              } catch (e) {
                /* ignore */
              }
            }
          }
        })
        mo.observe(host, { attributes: true, attributeFilter: ['class'] })
        THEME_MO_MAP.set(id, mo)
      } catch (e) {
        /* ignore */
      }
    },
    destroyThemeObserver() {
      const id = this.instId || 'mvi-0'
      const mo = THEME_MO_MAP.get(id)
      if (!mo) return
      try {
        mo.disconnect()
      } catch (e) {
        /* ignore */
      }
      THEME_MO_MAP.delete(id)
    },
    /** 逻辑层主题变化：先记住，建图时用；已有地图则原地换色标 */
    onTheme(v) {
      const dom = this.readThemeFromDom()
      const t = dom || (v === 'light' ? 'light' : 'dark')
      if (this.mapTheme === t) return
      this.mapTheme = t
      if (this.core && this.core.setTheme) {
        try {
          this.core.setTheme(t)
        } catch (e) {
          /* ignore */
        }
      }
    },
    // 兜底：万一拿不到 this.$el（不同运行时差异），还能靠 id 找到容器
    onHostId(id) {
      if (typeof id === 'string') this.hostId = id
    },
    // 逻辑层量好的容器尺寸（真机实测视图层量不出来，只能靠它）
    onSize(v) {
      const s = asObj(v)
      if (s && s.w > 0 && s.h > 0) this.hostSize = { w: s.w, h: s.h }
    },
    onPoints(payload) {
      const p = asObj(payload)
      const list = (p && p.list) || []
      this.lastPoints = list
      if (this.core && this.core.setPoints) this.core.setPoints(list)
    },
    // 逻辑层推下来的档案清单（视图层与逻辑层是两个上下文，不能共享模块状态）
    // task-1 起 payload 是 `{ list, mode, bad }`（兼容老的"纯数组"形态）
    onArchives(v) {
      const payload = asObj(v)
      const list = Array.isArray(payload)
        ? payload
        : payload && Array.isArray(payload.list)
          ? payload.list
          : null
      if (!list) return
      const mode = payload && !Array.isArray(payload) && payload.mode ? String(payload.mode) : this.sourceMode
      const bad = payload && !Array.isArray(payload) && Array.isArray(payload.bad) ? payload.bad : this.badRanges
      const changed = archivesChanged(this.archiveList, list)
      const modeChanged = !!mode && mode !== this.sourceMode
      this.archiveList = list
      if (mode) this.sourceMode = mode
      this.badRanges = bad || []
      // 档案或数据源策略变了就重建：即使 reset 信号丢了也不会停在旧城市/旧策略（自愈）
      if ((changed || modeChanged) && this.core) this.onReset()
    },
    onVisible(v) {
      // 只做尺寸恢复；渲染与轮询不停（保持轨迹连续）
      if (this.core && this.core.setVisible) this.core.setVisible(!!v)
      if (v) {
        this.pushStatus()
        this.startStatusTimer()
      }
    },
    onChunk(payload) {
      const c = asObj(payload)
      if (!c) return
      // ① R2 桥接的应答（task-1）：带 reqId，按档案下标找到对应桥接渠道配对。
      //    注意这里**绝不把 err 吞掉**：accept 收到 err 会让对应请求 reject，
      //    绝不能伪装成"读到 0 字节"，否则表现为"瓦片全黑"而查不出原因。
      if (c.reqId !== undefined && c.reqId !== null) {
        if (c.size) this.bridgeSize = Number(c.size) || 0
        // ★ 必须按 c.f 找"本档案"的桥接：早期这里写成 this.bridge（单数、且从未被赋值），
        //   结果 R2 的应答全部石沉大海，每个请求都要干等到 3 秒超时才降级。
        const b = this.bridgeFor(typeof c.f === 'number' ? c.f : 0)
        if (b) b.accept({ reqId: c.reqId, b64: c.b64, err: c.err })
        return
      }
      // ② 整包分块协议（whole 模式走这里，原样保留）
      if (typeof c.i !== 'number') return
      // n === 0 是「这一份读失败」的控制块：跳过它，接着要下一份，不拖垮整张底图
      if (!c.n) {
        if (c.err) this.setSrc('skip:' + ((this.archiveList[c.f] || {}).file || c.f) + '(' + c.err + ')')
        return this.askNextFile()
      }
      if (typeof c.b64 !== 'string') return
      // 收一块解一块（chunk 按 4 字符对齐切，每块都能独立 atob），
      // 避免最后 join 出一个 15MB 的 base64 字符串把手机内存顶爆
      if (!this.chunkParts) this.chunkParts = []
      try {
        const u8 = base64ToBytes(c.b64)
        this.chunkParts[c.i] = u8
        this.chunkBytes += u8.length
      } catch (e) {
        return this.fail('base64 解码失败: ' + ((e && e.message) || e))
      }
      if (c.n) this.chunkN = c.n
      this.chunkGot++
      // 回执：逻辑层收到回执才发下一块
      try {
        this.$ownerInstance.callMethod('mwChunkAck', c.i)
      } catch (e) {
        /* ignore */
      }
      if (this.chunkN > 0 && this.chunkGot >= this.chunkN) {
        const parts = this.chunkParts
        this.chunkParts = null
        this.chunkGot = 0
        try {
          const total = this.chunkBytes
          const all = new Uint8Array(total)
          let off = 0
          for (let i = 0; i < parts.length; i++) {
            if (!parts[i]) continue
            all.set(parts[i], off)
            off += parts[i].length
          }
          this.chunkBytes = 0
          this.setSrc('plusio@logic', total)
          if (!this.collected) this.collected = []
          this.collected.push({ key: (this.archiveList[c.f] || {}).file || 'file' + c.f, bytes: all })
          this.askNextFile()
        } catch (e) {
          this.fail('分块拼装失败: ' + ((e && e.message) || e))
        }
      }
    },

    pushStatus() {
      try {
        this.$ownerInstance.callMethod('mwStatus', formatMapStatus(this.status))
        this.pushRetry = 0
      } catch (e) {
        // $ownerInstance 还没就绪时（mounted 刚跑完那一刻很常见）别把状态丢掉：
        // 短延迟重试，最多约 4 秒。否则真机只会显示「视图层无回调」。
        if ((this.pushRetry || 0) < 13) {
          this.pushRetry = (this.pushRetry || 0) + 1
          setTimeout(() => this.pushStatus(), 300)
        }
      }
    },
    setSrc(src, extra) {
      // status 可能还没建（个别运行时 onAppMode 早于 mounted）：写 null/undefined 会抛
      // "Cannot set properties of null (setting 'src')"，直接把 boot 打断。
      if (!this.status) this.status = makeMapStatus()
      this.status.src = src + (extra ? '(' + extra + ')' : '')
      this.pushStatus()
    },
    fail(reason) {
      if (!this.status) this.status = makeMapStatus()
      this.status.err = reason
      this.status.maplibre = 'fail'
      this.pushStatus()
      try {
        this.$ownerInstance.callMethod('mwFail', reason)
      } catch (e) {
        /* ignore */
      }
    },
    stop() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
      if (this.core) {
        this.core.destroy()
        this.core = null
      }
      // R2 桥接在途请求一律 reject，别让视图层销毁后还有请求挂着
      this.destroyBridges('视图层销毁')
      // 主题观察器也要断开，否则旧实例的观察器会一直盯着 DOM
      this.destroyThemeObserver()
    },

    // 按可靠性顺序找容器：id（最稳）-> 选择器 -> 模块缓存 -> data.el -> $el
    // 每个候选都要过 looksLikeElement，$el 放最后且必须校验——真机上它不是元素。
    resolveHost() {
      const cands = []
      const push = (el, from) => {
        if (looksLikeElement(el)) cands.push({ el: el, from: from })
      }
      try {
        if (this.hostId) push(document.getElementById(this.hostId), 'byId')
        push(document.querySelector('.mv-host'), 'selector')
        push(HOST_EL, 'cached')
        push(this.el, 'data')
        push(this.$el, '$el')
      } catch (e) {
        /* ignore */
      }
      return cands[0] || null
    },
    // 把可疑候选描述成短字符串，进诊断行，下次真机一眼看出它到底是什么
    describeEl(v) {
      return describeValue(v)
    },

    // 尺寸解析：逻辑层推来的 -> 自己量 -> 视口反推（对齐 .mv-host 的 340rpx）
    async resolveSize(el) {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (this.hostSize && this.hostSize.w > 0 && this.hostSize.h > 0) {
          return { w: this.hostSize.w, h: this.hostSize.h }
        }
        const w = el.clientWidth || el.offsetWidth
        const h = el.clientHeight || el.offsetHeight
        if (w > 0 && h > 0) return { w: w, h: h }
        await new Promise((r) => setTimeout(r, 100))
      }
      const vw = Math.round((typeof window !== 'undefined' && window.innerWidth) || 360)
      return { w: vw, h: Math.round((vw * 340) / 750) }
    },

    async boot() {
      // 整个启动流程兜住异常：任何一步抛错都要能上报到逻辑层，
      // 否则真机上只会看到「视图层无回调」，无从判断死在哪。
      try {
        await this.bootInner()
      } catch (e) {
        const msg = (e && e.message) || String(e)
        // 真机上诊断行只能显示一行字，带上第一条栈帧才能定位到具体语句。
        // （"Cannot set properties of undefined" 这类错误如果不带栈帧，只能靠猜）
        let frame = ''
        try {
          const stack = e && e.stack ? String(e.stack).split('\n') : []
          for (let i = 1; i < stack.length; i++) {
            const line = stack[i].trim()
            if (line && line.indexOf('boot') < 0) {
              frame = line.replace(/^at\s+/, '').slice(0, 90)
              break
            }
          }
        } catch (err) {
          /* ignore */
        }
        this.fail('boot 异常: ' + msg + (frame ? ' @' + frame : ''))
      }
    },

    async bootInner() {
      // status 由 mounted 创建；万一 onAppMode 比 mounted 更早触发（个别运行时顺序不同），
      // 这里兜一下，否则第一行 `this.status.webgl = …` 就是 "Cannot set properties of null"。
      if (!this.status) this.status = makeMapStatus()
      this.booting = true
      this.status.webgl = probeWebgl() ? 'ok' : 'fail'
      this.status.renderjs = 'ok'
      this.pushStatus()
      if (this.status.webgl !== 'ok') {
        return this.fail('WebGL 不可用（视图层拿不到 webgl context）')
      }
      // worker 源要等瓦片读通后再定：用「真正读成功的那条绝对 URL」推导最可靠，
      // 见 finishBuild() 里的 prepareWorker(status, tileAbs)。
      this.pushStatus()
      // 容器：绝不能直接信 this.$el（它是包装对象，不是元素），逐候选校验 nodeType
      const found = this.resolveHost()
      if (!found) {
        return this.fail(
          '拿不到地图容器 DOM（id=' + this.hostId + '，$el=' + this.describeEl(this.$el) + '）'
        )
      }
      const el = found.el
      HOST_EL = el
      this.el = el
      // 尺寸来源优先级：逻辑层推下来的 hostSize -> 视图层自己量 -> 按视口反推 340rpx。
      // 真机实测视图层量 .mv-host 恒为 0（uni-view 此刻尚未布局），所以不能只靠它。
      const sz = await this.resolveSize(el)
      if (!sz.w || !sz.h) return this.fail('地图容器尺寸为 0（布局未就绪）')
      // 强制写内联像素：不赌 rpx 在视图层已生效，MapLibre 的 canvas 才有真实高度
      try {
        el.style.width = sz.w + 'px'
        el.style.height = sz.h + 'px'
      } catch (e) {
        /* 写不进去不致命，MapLibre 会退回父级尺寸 */
      }

      // 档案清单由逻辑层推过来（可能是包内自带的，也可能是用户下载的城市包）。
      // 消息可能比 appMode 晚到，等一会儿；实在拿不到就退回包内自带清单。
      if (!this.archiveList || !this.archiveList.length) {
        const deadline = Date.now() + 1500
        while (Date.now() < deadline && (!this.archiveList || !this.archiveList.length)) {
          await new Promise((r) => setTimeout(r, 60))
        }
      }
      const list =
        this.archiveList && this.archiveList.length
          ? this.archiveList
          : TILE_FILES.map((f) => ({ file: f, where: 'bundled' }))
      // 逐个档案加载：包内档案先让视图层自己 fetch / XHR（相对路径、_www、plus 绝对路径都试），
      // 拿不到的排队，最后逐个走 plus.io 过桥。用户下载的城市包没有 URL，直接排队过桥。
      //
      // task-1：`sourceMode !== 'whole'` 时先试「按需读取」（R1 fetch+Range / R2 跨层桥接），
      // 成功就不再整包下载；失败/不适用则**原样落到下面的整包老路径**。
      // ★ whole 模式下 rangeMode 恒为 false —— 探测、桥接创建、mwReadRange 都不会被调用，
      //   这条是「回退等价性」的唯一保证（e2e 用 __mvDebug.rangeProbes()===0 断言）。
      const rangeMode = this.sourceMode !== 'whole'
      const collected = []
      const pending = []
      const notes = []
      for (let i = 0; i < list.length; i++) {
        const item = list[i]
        const file = item.file
        let r = null
        if (rangeMode) {
          let got = null
          try {
            got = await this.tryRangeArchive(item, i)
          } catch (e) {
            got = null
          }
          if (got) {
            collected.push(got)
            notes.push(file + '←' + got.via)
            if (got.url && !this.tileAbs) this.tileAbs = got.url
            continue
          }
        }
        if (item.where === 'user') {
          // 用户下载的包在 _doc/maps/（或保存退路目录）。先让**视图层自己 fetch**
          // 这个 file:// 绝对路径 —— WebView 读文件不走 plus.io.FileReader，
          // 实测有的机型 FileReader 读不出来、fetch 却能读；而且 fetch 是流式的，更快。
          // 只有这里失败才退回逻辑层（plus.io / Native）过桥。
          const cands = []
          try {
            const rel = item.path || '_doc/maps/' + file
            // 下载退路可能给的是裸绝对路径，toPlusUrl 会补成 file://；
            // 两个变体都试，不同 WebView 认的形式不一样
            const url = toPlusUrl(rel)
            if (url) {
              cands.push(url)
              if (url.indexOf('file://') === 0) cands.push(url.slice(7))
              else cands.push('file://' + (url.charAt(0) === '/' ? url : '/' + url))
            }
          } catch (e) {
            /* ignore */
          }
          if (cands.length) {
            try {
              r = await loadTilesFromUrls(cands)
            } catch (e) {
              r = null
            }
          }
          if (r && r.bytes) {
            collected.push({ key: file, bytes: r.bytes })
            notes.push(file + '←viewfetch')
            if (r.abs && !this.tileAbs) this.tileAbs = r.abs
          } else {
            pending.push(i)
            notes.push(file + '?')
          }
          continue
        }
        try {
          r = await loadTilesFromUrls(tileUrlCandidates(file))
        } catch (e) {
          r = null
        }
        if (r && r.bytes) {
          collected.push({ key: file, bytes: r.bytes })
          notes.push(file + '←' + String(r.src || '').replace(/^[a-z]+@/, ''))
          // 记住读通的那条绝对地址：worker 地址由它推导（同一源必可访问）
          if (r.abs && !this.tileAbs) this.tileAbs = r.abs
        } else {
          pending.push(i)
          notes.push(file + '?')
        }
      }
      this.collected = collected
      this.pending = pending
      this.setSrc(notes.join(' '))
      if (!pending.length) return this.finishBuild()
      this.askNextFile()
    },

    /**
     * task-1：把某个档案做成「按需读取」形态。
     * 返回 null = 放弃按需（调用方走原整包路径）；返回对象 = createTrackMap 的 range 档案。
     *
     * 判定顺序：
     *  ① R2 桥接探测（16 KB）：验证「逻辑层能读到这个包」，并顺手拿到文件字节数 size
     *  ② R1 fetch+Range 探测：R2 通了才试（file:// 响应常常没有 Content-Length，
     *     拿不到 size 就没法做末尾截断，所以 size 一律以 R2 为准）
     *  R1 能用就用 R1（省掉每次瓦片一次跨层往返），否则用 R2。
     */
    async tryRangeArchive(item, index) {
      // 这道 try 是"新代码不许拖垮底图"的最后一道闸：
      // 任何意外（桥接建不起来、运行时拒绝写实例字段、fetch 行为差异……）都只让
      // 本次走整包，绝不冒泡到 boot() 让整张地图退回自绘层。
      try {
        return await this.tryRangeArchiveInner(item, index)
      } catch (e) {
        this.r1Text = '按需探测异常: ' + ((e && e.message) || String(e)).slice(0, 60)
        return null
      }
    },
    async tryRangeArchiveInner(item, index) {
      if (!item || !item.file) return null
      const adcode = item.adcode || 'builtin'
      const bad = (this.badRanges || []).indexOf(adcode) >= 0
      bumpProbe()
      // ① R2 探测（本机判过不通的包，auto 模式直接跳过；range 模式仍然试）
      let r2ok = false
      if (!bad || this.sourceMode === 'range') {
        const bridge = this.ensureBridge(index)
        if (bridge) {
          try {
            const head = await bridge.request(0, 16384)
            r2ok = !!head && head.byteLength >= 7 && magic7Ok(head)
          } catch (e) {
            r2ok = false
          }
        }
      }
      // ② R1 探测
      let r1 = null
      if (r2ok && this.sourceMode !== 'range') {
        const cands = this.rangeUrlCandidates(item)
        for (let k = 0; k < cands.length; k++) {
          const p = await probeRangeRead(cands[k], { timeoutMs: 400 })
          if (p && p.ok) {
            r1 = { url: cands[k], kind: p.kind }
            break
          }
          // 这个源明确忽略 Range：换候选也没用，直接停
          if (p && p.kind === 'whole-file') break
        }
      }
      const size = this.bridgeSize || 0
      // size 必须合理（>1 KB）：太小说明探测拿到的不是整包大小，按需读取必然读不出东西
      if (!(size > 1024)) return null
      if (r1) {
        this.r1Text = 'R1:' + r1.kind + '✓ size=' + size
        return {
          key: item.file,
          size: size,
          via: 'range-R1',
          url: r1.url,
          reader: (o, l) => fetchRange(r1.url, o, l, { timeoutMs: 8000 }),
          dispose: () => {},
        }
      }
      if (r2ok) {
        const bridge = this.ensureBridge(index)
        if (bridge) {
          this.r1Text = 'R1:不可用 → R2'
          return {
            key: item.file,
            size: size,
            via: 'range-R2',
            reader: (o, l) => bridge.request(o, l),
            dispose: () => {},
          }
        }
      }
      // 都失败：让逻辑层记住「这台机器这个包不通」，auto 模式下次直接跳级
      this.r1Text = 'R1/R2 均失败'
      try {
        this.$ownerInstance.callMethod('mwMarkRangeBad', { adcode: adcode, why: this.r1Text })
      } catch (e) {
        /* ignore */
      }
      return null
    },
    /** 本实例的桥接渠道表（模块级 Map，不写组件实例字段） */
    bridgesOf() {
      const id = this.instId || 'mvi-0'
      let m = BRIDGE_MAP.get(id)
      if (!m) {
        m = {}
        BRIDGE_MAP.set(id, m)
      }
      return m
    },
    hasBridges() {
      const m = BRIDGE_MAP.get(this.instId || 'mvi-0')
      return !!(m && Object.keys(m).length)
    },
    bridgeFor(index) {
      const m = BRIDGE_MAP.get(this.instId || 'mvi-0')
      return (m && m[String(index)]) || null
    },
    destroyBridges(reason) {
      const id = this.instId || 'mvi-0'
      const m = BRIDGE_MAP.get(id)
      if (m) {
        Object.keys(m).forEach((k) => {
          try {
            m[k].destroy(reason || '销毁')
          } catch (e) {
            /* ignore */
          }
        })
      }
      BRIDGE_MAP.delete(id)
    },
    /** 每个档案一条桥接渠道（多档案时 f 必须对应得上前端下标） */
    ensureBridge(index) {
      try {
        const m = this.bridgesOf()
        const key = String(index)
        if (m[key]) return m[key]
        const self = this
        m[key] = createBridgeReader({
          send(p) {
            try {
              self.$ownerInstance.callMethod('mwReadRange', {
                reqId: p.reqId,
                offset: p.offset,
                length: p.length,
                f: index,
              })
            } catch (e) {
              /* 调用不通就让 bridge 自己超时，超时只会 reject 那一个请求 */
            }
          },
        })
        return m[key]
      } catch (e) {
        return null
      }
    },
    /** 这个档案可以尝试哪些 URL（R1 探测/读取用） */
    rangeUrlCandidates(item) {
      const out = []
      const push = (u) => {
        if (u && out.indexOf(u) < 0) out.push(u)
      }
      if (item && item.abs) {
        const a = String(item.abs)
        push(a.indexOf('file://') === 0 ? a : 'file://' + (a.charAt(0) === '/' ? a : '/' + a))
        push(a)
      }
      if (item && item.where === 'user') {
        try {
          const rel = item.path || '_doc/maps/' + (item.file || '')
          const url = toPlusUrl(rel)
          push(url)
          if (url && url.indexOf('file://') === 0) push(url.slice(7))
          else push('file://' + (url.charAt(0) === '/' ? url : '/' + url))
        } catch (e) {
          /* ignore */
        }
      } else if (item && item.file) {
        const cands = tileUrlCandidates(item.file)
        for (let i = 0; i < cands.length; i++) push(cands[i])
      }
      return out
    },

    // 一次只过桥一份档案，避免同时压多份 base64 把手机内存顶爆
    askNextFile() {
      if (!this.pending || !this.pending.length) return this.finishBuild()
      this.curFile = this.pending.shift()
      this.setSrc('bridge:' + (((this.archiveList || [])[this.curFile] || {}).file || this.curFile))
      try {
        this.$ownerInstance.callMethod('mwNeedTiles', { f: this.curFile })
      } catch (e) {
        this.askNextFile() // 问不动就跳过这一份
      }
    },

    // 手上有几份就建几份，一份都没有才算失败
    async finishBuild() {
      if (this.core) return
      if (!this.collected || !this.collected.length) {
        return this.fail('一个瓦片档案都没读到')
      }
      // 建图前把 worker 源定好（真机禁 blob:，用与瓦片同一源的静态文件）
      await prepareWorker(this.status, this.tileAbs)
      this.pushStatus()
      this.build(this.collected)
    },

    build(archives) {
      if (this.core) return
      // 建图这一步必须重新确认容器：组件重渲染可能让 data 里的 el 失效，
      // 而 $el 不是元素。拿不到元素就明确报错，别把 undefined 丢给 MapLibre。
      const found = this.resolveHost()
      if (!found) {
        return this.fail(
          '建图前容器丢失（id=' + this.hostId + '，$el=' + this.describeEl(this.$el) + '）'
        )
      }
      HOST_EL = found.el
      this.el = found.el
      try {
        this.core = createTrackMap({
          container: found.el,
          archives: archives,
        center: (this.archiveList[0] && this.archiveList[0].center) || null,
          status: this.status,
          theme: this.mapTheme,
          points: this.lastPoints,
          // task-1：三级分派由 map-core 的 makeSource 统一做，这里只转达策略
          sourceMode: this.sourceMode === 'whole' ? 'whole' : this.sourceMode === 'range' ? 'range' : 'auto',
          onOutOfBounds: (b) => {
            try {
              this.$ownerInstance.callMethod('mwOutOfBounds', b)
            } catch (e) {
              /* ignore */
            }
          },
          onReady: () => {
            try {
              this.$ownerInstance.callMethod('mwReady')
            } catch (e) {
              /* ignore */
            }
          },
        })
        // App 端：建图完成后开始盯主题 class 变化
        this.watchThemeClass()
        // 把「这次到底走了哪一级 + 统计」写进 storage，地图页的「读取自检」要读它
        this.recordReadProbe()
      } catch (e) {
        return this.fail('建图异常: ' + ((e && e.message) || e))
      }
      // src 末尾补上容器来源（byId/selector/cached/data/$el），真机诊断用
      this.setSrc(this.status.src || '', 'host:' + found.from)
      // tiles 计数是异步长出来的，定时刷回逻辑层显示
      this.startStatusTimer()
    },

    /**
     * 把这次建图的实测结果写给逻辑层（视图层没有 uni，只能 callMethod 代写 storage）。
     * 地图页「读取自检」读的就是这条记录，用来回答「这台机器现在走的是哪一级」。
     */
    recordReadProbe() {
      try {
        let stats = ''
        try {
          const rs = this.core && this.core.getReadStats ? this.core.getReadStats() : null
          if (rs && rs.sources) {
            const agg = { requests: 0, hits: 0, bytes: 0, errors: 0 }
            for (let i = 0; i < rs.sources.length; i++) {
              const s = rs.sources[i] && rs.sources[i].stats
              if (!s) continue
              agg.requests += s.requests || 0
              agg.hits += s.hits || 0
              agg.bytes += s.bytes || 0
              agg.errors += s.errors || 0
            }
            if (agg.requests) stats = formatReadStats(agg, 0)
          }
        } catch (e) {
          /* ignore */
        }
        const mode = this.core && this.core.getSourceMode ? this.core.getSourceMode() : this.sourceMode
        this.$ownerInstance.callMethod('mwRecordProbe', {
          mode: mode || this.sourceMode,
          r1: this.r1Text || '(未探测)',
          r2: this.hasBridges() ? '桥接已建立' : '(未使用)',
          readStats: stats,
          probes: RANGE_PROBE_COUNT,
        })
      } catch (e) {
        /* ignore */
      }
    },
  },
}
</script>

<style lang="scss" scoped>
.mv-root {
  position: relative;
  width: 100%;
  height: 340rpx;
  border-radius: 24rpx;
  overflow: hidden;
  background: var(--bg-card);
}
.mv-host {
  position: relative;
  width: 100%;
  height: 340rpx;
  overflow: hidden;
}
.mv-hint {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.mv-hint-text {
  font-size: 24rpx;
  color: var(--text-1);
  background: var(--chip-bg);
  padding: 8rpx 20rpx;
  border-radius: 999rpx;
}
.mv-attr {
  position: absolute;
  right: 12rpx;
  bottom: 8rpx;
  pointer-events: none;
}
.mv-attr-text {
  font-size: 18rpx;
  color: var(--text-2);
  background: var(--chip-bg);
  padding: 2rpx 8rpx;
  border-radius: 6rpx;
}
.mv-diag {
  position: absolute;
  left: 8rpx;
  top: 8rpx;
  right: 8rpx;
  pointer-events: none;
}
/* 一切正常时整行不显示：调试信息只在出问题时才有价值，平时别挡地图 */
.mv-diag-off {
  display: none;
}
.mv-diag-text {
  font-size: 16rpx;
  line-height: 1.35;
  color: #9fe8b6;
  background: rgba(0, 0, 0, 0.5);
  padding: 2rpx 6rpx;
  border-radius: 6rpx;
  word-break: break-all;
}
</style>

<!-- MapLibre 需要的两条布局规则。不能放进 scoped：canvas 是 MapLibre 自己插进来的，
     拿不到 scoped 的属性选择器。 -->
<style>
.maplibregl-map {
  position: relative;
  overflow: hidden;
  -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
}
.maplibregl-canvas {
  position: absolute;
  left: 0;
  top: 0;
}
</style>
