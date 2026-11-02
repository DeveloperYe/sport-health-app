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
import { readTilesViaPlusIo, TILE_FILES, tileUserPath } from './tiles.js'
import { getCurrent, isInstalled, getCity } from '@/utils/city-maps.js'
import { makeMapStatus, formatMapStatus } from './map-status.js'
// #ifdef H5
import { createTrackMap, probeWebgl, waitForSize } from './map-core.js'
import { tileUrlCandidates, loadTilesFromUrls } from './tiles.js'
// #endif

let seq = 0
// 跨层搬运 base64 的块大小：必须是 4 的倍数（base64 4 字符 = 3 字节），
// 这样视图层每块都能独立 atob，不用先 join 出一个 15MB 字符串。
const TILE_CHUNK_CHARS = 512 * 1024

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
    // App：把档案清单推给视图层（视图层与逻辑层是两个 JS 上下文，不能共享模块状态）
    archivesPayload() {
      return JSON.stringify(this.archives || [])
    },
  },
  watch: {
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
      // #ifdef H5
      if (this.core && this.core.setVisible) this.core.setVisible(v)
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
  },
  methods: {
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
      const cur = getCurrent()
      if (cur && isInstalled(cur)) {
        const c = getCity(cur)
        if (c) {
          this.archives = [{ file: c.adcode + '.pmtiles', where: 'user', adcode: c.adcode, name: c.name }]
          return this.archives
        }
      }
      this.archives = (TILE_FILES || []).map((f) => ({ file: f, where: 'bundled' }))
      return this.archives
    },
    // 切换城市后重建地图（档案换了，中心点/bbox 也要重新从包头发起）
    reloadForCity() {
      this.teardownH5()
      this.ready = false
      this.failed = false
      this.core = null
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
      for (let i = 0; i < this.archives.length; i++) {
        const a = this.archives[i]
        let bytes = null
        let srcText = ''
        if (a.where === 'user') {
          // H5 端下载的包存在 IndexedDB 里
          const mod = await import('@/utils/city-map-download.js')
          bytes = await mod.readPackedBytes(a.adcode)
          srcText = 'idb'
          if (!bytes) notes.push(a.file + '✗(未下载)')
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
          archives: archives,
          status: this.status,
          points: this.points,
          onOutOfBounds: (b) => this.$emit('outofbounds', b),
          onReady: () => {
            this.ready = true
          },
        })
      } catch (e) {
        return this.failH5('建图异常: ' + ((e && e.message) || e))
      }
      this.core.setVisible(this.visible)
      this.timer = setInterval(() => this.pushStatus(), 1000)
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
    clearWatchdog() {
      if (this.renderjsWatchdog) {
        clearTimeout(this.renderjsWatchdog)
        this.renderjsWatchdog = null
      }
    },
    teardownH5() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
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
      const absPath = a && a.where === 'user' ? tileUserPath(file) : ''
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
} from './tiles.js'

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

export default {
  data() {
    return {
      core: null,
      status: null,
      booting: false,
      lastPoints: [],
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
      if (v && !this.booting && !this.core) this.boot()
      // #endif
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
    onArchives(v) {
      const list = asObj(v)
      if (Array.isArray(list)) this.archiveList = list
    },
    onVisible(v) {
      if (this.core && this.core.setVisible) this.core.setVisible(!!v)
    },
    onChunk(payload) {
      const c = asObj(payload)
      if (!c || typeof c.i !== 'number') return
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
        this._pushRetry = 0
      } catch (e) {
        // $ownerInstance 还没就绪时（mounted 刚跑完那一刻很常见）别把状态丢掉：
        // 短延迟重试，最多约 4 秒。否则真机只会显示「视图层无回调」。
        if ((this._pushRetry || 0) < 13) {
          this._pushRetry = (this._pushRetry || 0) + 1
          setTimeout(() => this.pushStatus(), 300)
        }
      }
    },
    setSrc(src, extra) {
      this.status.src = src + (extra ? '(' + extra + ')' : '')
      this.pushStatus()
    },
    fail(reason) {
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
        this.fail('boot 异常: ' + ((e && e.message) || String(e)))
      }
    },

    async bootInner() {
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
      const collected = []
      const pending = []
      const notes = []
      for (let i = 0; i < list.length; i++) {
        const item = list[i]
        const file = item.file
        if (item.where === 'user') {
          pending.push(i)
          notes.push(file + '?')
          continue
        }
        let r = null
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
          status: this.status,
          points: this.lastPoints,
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
      } catch (e) {
        return this.fail('建图异常: ' + ((e && e.message) || e))
      }
      // src 末尾补上容器来源（byId/selector/cached/data/$el），真机诊断用
      this.setSrc(this.status.src || '', 'host:' + found.from)
      // tiles 计数是异步长出来的，定时刷回逻辑层显示
      this.timer = setInterval(() => this.pushStatus(), 1000)
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
  background: #15151a;
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
  color: rgba(255, 255, 255, 0.72);
  background: rgba(0, 0, 0, 0.42);
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
  color: rgba(255, 255, 255, 0.75);
  background: rgba(0, 0, 0, 0.45);
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
