<template>
  <view class="page">
    <!-- 当前状态 -->
    <view class="card hero">
      <view class="hero-top">
        <view class="hero-l">
          <text class="hero-label">当前底图</text>
          <text class="hero-city">{{ currentName }}</text>
        </view>
        <view class="hero-r">
          <text class="hero-count">{{ installedCount }} 个城市</text>
          <text class="hero-size">{{ installedSizeText }}</text>
        </view>
      </view>
      <view class="hero-acts">
        <view class="mini-btn" @click="retest">重测线路</view>
        <view class="mini-btn ghost" @click="goSport">去运动页看</view>
      </view>
      <text class="hero-speed" v-if="speedLine">{{ speedLine }}</text>
      <text class="hero-speed" v-else>下载时会自动测速，选最快的加速线路</text>
      <text class="hero-speed">测速通道：{{ transport || '…' }}</text>
    </view>

    <!-- 城市列表 -->
    <view class="card">
      <view class="list-head">
        <text class="card-title">选择城市</text>
        <text class="list-meta">{{ list.length }} / {{ totalCount }}</text>
      </view>
      <input class="inp" v-model="kw" placeholder="搜城市名 / 省份 / 区号" placeholder-class="inp-ph" />
      <view class="city-list">
        <view class="city-row" v-for="c in list" :key="c.adcode">
          <view class="row-line">
            <view class="row-l">
              <text class="row-name">{{ c.name }}</text>
              <text class="row-sub">{{ c.province }} · {{ fmtSize(c.bytes) }}</text>
            </view>
            <view class="row-r">
              <view v-if="isCur(c.adcode)" class="tag tag-cur">使用中</view>
              <view v-else-if="isOn(c.adcode)" class="tag tag-on">已下载</view>
              <view v-if="dl[c.adcode] && dl[c.adcode].running" class="tag tag-dl">下载中</view>
              <view v-else-if="c.bytes > 60 * 1024 * 1024 && !isOn(c.adcode)" class="tag tag-big">大包</view>

              <view
                v-if="!isOn(c.adcode)"
                class="mini-btn small"
                :class="{ disabled: dl[c.adcode] && dl[c.adcode].running }"
                @click="startDownload(c)"
              >
                {{ dl[c.adcode] && dl[c.adcode].running ? '下载中' : '下载' }}
              </view>
              <template v-else>
                <view v-if="!isCur(c.adcode)" class="mini-btn small" @click="useCity(c)">使用</view>
                <view class="mini-btn small ghost" @click="removeCity(c)">删除</view>
              </template>
            </view>
          </view>

          <!-- 下载进度 -->
          <view class="prog" v-if="dl[c.adcode] && dl[c.adcode].running">
            <view class="prog-bar">
              <view class="prog-fill" :style="{ width: pct(c.adcode) + '%' }"></view>
            </view>
            <view class="prog-meta">
              <text>{{ progText(c.adcode) }}</text>
              <text v-if="dl[c.adcode].mirror">{{ dl[c.adcode].mirror }}</text>
            </view>
          </view>
          <text class="row-err" v-if="dl[c.adcode] && dl[c.adcode].err">{{ dl[c.adcode].err }}</text>
        </view>
        <view class="empty" v-if="!list.length">
          <text>没搜到，换个关键词试试（比如"青岛"或"370200"）</text>
        </view>
      </view>
    </view>

    <view class="card">
      <view class="card-title">说明</view>
      <text class="note">· 底图数据 © OpenStreetMap contributors，ODbL 授权。</text>
      <text class="note">· 一个城市一个包，下载后完全离线，跑步时不再消耗流量。</text>
      <text class="note">· 下载前自动测 5 条加速线路的速度，选最快的下；中途掉速会自动换线重下。</text>
      <text class="note">· 每个包下载完都会校验字节数与 SHA-256，校验不过自动换线重试。</text>
      <text class="note">· 标「大包」的城市超过 60 MB（如北京 94 MB、重庆 189 MB），低内存机型加载会更慢、更吃内存。</text>
      <text class="note">· 包存在应用私有目录，卸载 App 会一起清掉。</text>
      <text class="note">· 切换城市后回到运动页生效，地图中心和缩放会跟着新城市走。</text>
    </view>

    <!-- 真机排障用：把环境与测速细节摊开，出问题截图即可定位 -->
    <view class="card">
      <view class="list-head">
        <text class="card-title">诊断</text>
        <view class="mini-btn small ghost" @click="copyDiag">复制</view>
      </view>
      <text class="diag-line">运行时：{{ diagInfo.runtime }}</text>
      <text class="diag-line">XHR {{ diagInfo.xhr }}　plus.net.XHR {{ diagInfo.pxhr }}</text>
      <text class="diag-line">下载器：{{ diagInfo.downloader }}</text>
      <text class="diag-line">测速通道：{{ transport || '…' }}</text>
      <text class="diag-line" v-for="(l, i) in diagInfo.lines" :key="'dl' + i">{{ l }}</text>
      <text class="diag-line" v-if="!diagInfo.lines.length">还没测过速</text>
      <text class="diag-line" v-if="manualPrefix">已手动指定：{{ manualLabel }}（下载时跳过测速）</text>
      <view class="manual-row">
        <view
          class="mini-btn small"
          :class="{ ghost: manualPrefix !== m.prefix }"
          v-for="m in manuals"
          :key="'mm' + m.id"
          @click="pickManual(m)"
        >
          {{ m.label }}
        </view>
        <view class="mini-btn small ghost" v-if="manualPrefix" @click="clearManual">自动</view>
      </view>
    </view>
  </view>
</template>

<script>
import {
  CITIES,
  MIRRORS,
  getCity,
  getCurrent,
  setCurrent,
  isInstalled,
  getInstalled,
  formatBytes,
  formatSpeed,
  measureMirrors,
  cachedMirrors,
  mirrorLabel,
  probeTransportName,
} from '@/utils/city-maps.js'
import { downloadCity, deleteCity } from '@/utils/city-map-download.js'

export default {
  data() {
    return {
      kw: '',
      installed: {},
      current: '',
      dl: {}, // adcode -> { running, loaded, total, bps, mirror, note, err }
      speedLine: '',
      transport: '',
      diagInfo: { runtime: '', xhr: '', pxhr: '', downloader: '', lines: [] },
      manualPrefix: '',
      limit: 30,
    }
  },
  computed: {
    manuals() {
      // App 端才给"直连"这一项（浏览器里必被 CORS 拦）
      let app = false
      try {
        app = typeof plus !== 'undefined' && !!plus.io
      } catch (e) {
        app = false
      }
      return MIRRORS.filter((m) => !m.appOnly || app)
    },
    manualLabel() {
      const m = MIRRORS.filter((x) => x.prefix === this.manualPrefix)[0]
      return m ? m.label : '直连'
    },
    totalCount() {
      return CITIES.length
    },
    list() {
      const kw = String(this.kw || '').trim()
      const hit = []
      for (let i = 0; i < CITIES.length; i++) {
        const c = CITIES[i]
        if (!kw || c.name.indexOf(kw) >= 0 || c.province.indexOf(kw) >= 0 || c.adcode.indexOf(kw) >= 0) hit.push(c)
      }
      // 已下载的排前面：不用在 370 条里翻自己装过哪个
      const on = hit.filter((c) => this.isOn(c.adcode) || String(this.current) === c.adcode)
      const off = hit.filter((c) => !this.isOn(c.adcode) && String(this.current) !== c.adcode)
      return on.concat(off).slice(0, this.limit)
    },
    installedCount() {
      return Object.keys(this.installed || {}).length
    },
    installedSizeText() {
      let sum = 0
      const all = this.installed || {}
      Object.keys(all).forEach((k) => {
        sum += Number(all[k] && all[k].bytes) || 0
      })
      return sum ? '占用 ' + formatBytes(sum) : '还没下载过城市包'
    },
    currentName() {
      if (!this.current) return '内置青岛包'
      const c = getCity(this.current)
      return c ? c.name : this.current
    },
  },
  onShow() {
    this.reloadState()
    this.showCachedSpeed()
    this.transport = probeTransportName()
    this.fillEnv()
  },
  methods: {
    fmtSize(n) {
      return formatBytes(n)
    },
    reloadState() {
      this.installed = getInstalled()
      this.current = getCurrent()
    },
    isOn(adcode) {
      return !!this.installed[String(adcode)]
    },
    isCur(adcode) {
      return String(this.current) === String(adcode)
    },
    showCachedSpeed() {
      const c = cachedMirrors()
      if (c && c.best) {
        this.speedLine = '上次测速最快：' + mirrorLabel(c.best.prefix) + ' ' + formatSpeed(c.best.bps)
      }
    },
    pct(adcode) {
      const d = this.dl[adcode]
      if (!d || !d.total) return 0
      return Math.max(1, Math.min(100, Math.round((d.loaded / d.total) * 100)))
    },
    progText(adcode) {
      const d = this.dl[adcode]
      if (!d) return ''
      const p = this.pct(adcode)
      const speed = d.bps ? formatSpeed(d.bps) : ''
      const loaded = d.loaded ? formatBytes(d.loaded) : ''
      const total = d.total ? formatBytes(d.total) : ''
      if (d.phase === 'probe') return d.note || '测速中…'
      if (d.phase === 'verify') return '校验 SHA-256… ' + p + '%'
      if (d.phase === 'save') return '保存中…'
      return p + '% ' + loaded + (total ? ' / ' + total : '') + (speed ? ' · ' + speed : '')
    },
    async startDownload(city) {
      const a = city.adcode
      if (this.dl[a] && this.dl[a].running) return
      this.dl = { ...this.dl, [a]: { running: true, phase: 'probe', loaded: 0, total: city.bytes, bps: 0, mirror: '', note: '测速中…', err: '' } }
      const r = await downloadCity(a, {
        preferPrefix: this.manualPrefix || '',
        onProgress: (p) => {
          const cur = this.dl[a] || {}
          this.dl = {
            ...this.dl,
            [a]: {
              ...cur,
              running: true,
              phase: p.phase,
              loaded: p.loaded !== undefined ? p.loaded : cur.loaded,
              total: p.total || cur.total,
              bps: p.bps !== undefined ? p.bps : cur.bps,
              mirror: p.mirror || cur.mirror,
              note: p.note || '',
              err: '',
            },
          }
        },
        onLog: (msg) => {
          const cur = this.dl[a] || {}
          this.dl = { ...this.dl, [a]: { ...cur, note: msg } }
        },
      })
      const cur = this.dl[a] || {}
      if (r.ok) {
        this.dl = { ...this.dl, [a]: { ...cur, running: false, err: '' } }
        this.reloadState()
        this.speedLine = '本次最快线路：' + r.mirror + '（' + formatBytes(city.bytes) + '，SHA-256 已校验）'
        // 没有当前城市时，下载完自动切过去，省一步
        if (!getCurrent()) {
          setCurrent(a)
          this.reloadState()
        }
        uni.showToast({ title: '已下载 ' + city.name, icon: 'success' })
      } else {
        this.dl = { ...this.dl, [a]: { ...cur, running: false, err: r.err || '下载失败' } }
        uni.showToast({ title: '下载失败', icon: 'none' })
      }
    },
    useCity(city) {
      if (!setCurrent(city.adcode)) return
      this.reloadState()
      uni.showToast({ title: '已切换到 ' + city.name, icon: 'none' })
    },
    async removeCity(city) {
      const res = await new Promise((resolve) => {
        uni.showModal({
          title: '删除底图包',
          content: '删除「' + city.name + '」的离线包？删除后该城市地图会退回到内置青岛包。',
          success: (r) => resolve(!!(r && r.confirm)),
          fail: () => resolve(false),
        })
      })
      if (!res) return
      await deleteCity(city.adcode)
      this.reloadState()
      uni.showToast({ title: '已删除', icon: 'none' })
    },
    // 把运行环境摊平显示：出问题时用户截图就能定位
    fillEnv() {
      let runtime = 'H5'
      let xhr = '无'
      let pxhr = '无'
      let downloader = 'uni.downloadFile'
      try {
        if (typeof plus !== 'undefined' && plus.io) runtime = 'App（5+）'
      } catch (e) {
        /* ignore */
      }
      try {
        if (typeof XMLHttpRequest !== 'undefined') xhr = '有'
      } catch (e) {
        /* ignore */
      }
      try {
        if (typeof plus !== 'undefined' && plus.net && plus.net.XMLHttpRequest) pxhr = '有'
      } catch (e) {
        /* ignore */
      }
      try {
        if (typeof uni === 'undefined' || !uni.downloadFile) downloader = '不可用'
      } catch (e) {
        downloader = '不可用'
      }
      this.diagInfo = { ...this.diagInfo, runtime, xhr, pxhr, downloader }
    },
    pickManual(m) {
      this.manualPrefix = m.prefix
      uni.showToast({ title: '已指定 ' + m.label, icon: 'none' })
    },
    clearManual() {
      this.manualPrefix = ''
      uni.showToast({ title: '已恢复自动测速', icon: 'none' })
    },
    copyDiag() {
      const d = this.diagInfo
      const txt =
        '运行时 ' + d.runtime + ' | XHR ' + d.xhr + ' | plus.net.XHR ' + d.pxhr +
        ' | 下载器 ' + d.downloader + ' | 通道 ' + this.transport +
        '\n' + (d.lines || []).join('\n')
      uni.setClipboardData({
        data: txt,
        success: () => uni.showToast({ title: '已复制', icon: 'none' }),
        fail: () => uni.showToast({ title: '复制失败', icon: 'none' }),
      })
    },
    async retest() {
      uni.showToast({ title: '测速中…', icon: 'none' })
      const city = getCity('370200') || CITIES[0]
      const r = await measureMirrors(city.url)
      const okLines = r.list.map((x) => '✅ ' + mirrorLabel(x.prefix) + ' ' + formatSpeed(x.bps))
      const badLines = (r.failed || []).map((f) => '❌ ' + f.id + '：' + (f.err || '失败'))
      this.diagInfo = { ...this.diagInfo, lines: okLines.concat(badLines) }
      if (!r.list.length) {
        const why = (r.failed || []).map((f) => f.id + '(' + (f.err || '失败') + ')').join(' ')
        this.speedLine = '测速全失败：' + (why || '未知原因') + '　—— 下载时仍会逐条线路重试'
        return
      }
      const lines = r.list.slice(0, 3).map((x) => mirrorLabel(x.prefix) + ' ' + formatSpeed(x.bps))
      this.speedLine = '最快：' + lines.join(' ｜ ')
    },
    goSport() {
      uni.switchTab({ url: '/pages/sport/sport' })
    },
  },
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 20rpx 0 60rpx;
  background: $bg-page;
}

.card {
  margin: 20rpx 24rpx 0;
  padding: $card-pad;
  border-radius: $card-radius;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}

.card-title {
  font-size: $card-title-font;
  font-weight: 700;
  color: $text-main;
}

/* 顶部状态 */
.hero-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.hero-l {
  display: flex;
  flex-direction: column;
}
.hero-label {
  font-size: 24rpx;
  color: $text-muted;
}
.hero-city {
  margin-top: 8rpx;
  font-size: 40rpx;
  font-weight: 700;
  color: $brand-primary;
}
.hero-r {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.hero-count {
  font-size: 26rpx;
  color: $text-secondary;
}
.hero-size {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-muted;
}
.hero-acts {
  display: flex;
  gap: 16rpx;
  margin-top: 20rpx;
}
.hero-speed {
  display: block;
  margin-top: 14rpx;
  font-size: 22rpx;
  color: $text-muted;
}

/* 列表 */
.list-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.list-meta {
  font-size: 22rpx;
  color: $text-muted;
}
.inp {
  height: 72rpx;
  margin-top: 16rpx;
  padding: 0 20rpx;
  border-radius: 14rpx;
  background: $bg-card-light;
  border: 1rpx solid $border-subtle;
  color: $text-main;
  font-size: 26rpx;
}
.inp-ph {
  color: $text-muted;
}
.city-list {
  margin-top: 8rpx;
}
.city-row {
  padding: 18rpx 0;
  border-bottom: 1rpx solid $border-subtle;
}
.city-row:last-child {
  border-bottom: none;
}
.row-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16rpx;
}
.row-l {
  display: flex;
  flex-direction: column;
}
.row-name {
  font-size: 28rpx;
  color: $text-main;
  font-weight: 600;
}
.row-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-muted;
}
.row-r {
  display: flex;
  gap: 10rpx;
  align-items: center;
  flex-shrink: 0;
}
.tag {
  padding: 4rpx 12rpx;
  border-radius: 999rpx;
  font-size: 20rpx;
}
.tag-cur {
  background: rgba(43, 212, 92, 0.16);
  color: $brand-primary;
}
.tag-on {
  background: rgba(74, 163, 255, 0.14);
  color: #4aa3ff;
}
.tag-dl {
  background: rgba(255, 179, 71, 0.14);
  color: #ffb347;
}
.tag-big {
  background: rgba(255, 255, 255, 0.06);
  color: $text-muted;
}
.prog {
  margin-top: 14rpx;
}
.prog-bar {
  height: 10rpx;
  border-radius: 999rpx;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.prog-fill {
  height: 100%;
  border-radius: 999rpx;
  background: linear-gradient(90deg, #17a348, #2bd45c);
  transition: width 0.3s;
}
.prog-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 8rpx;
  font-size: 20rpx;
  color: $text-muted;
}
.row-err {
  display: block;
  margin-top: 10rpx;
  font-size: 22rpx;
  color: #ff6b6b;
}

.mini-btn {
  flex: 1;
  padding: 18rpx 0;
  text-align: center;
  border-radius: $btn-radius;
  background: $brand-primary;
  color: #06180d;
  font-size: $btn-font;
  font-weight: 700;
}
.mini-btn.small {
  flex: none;
  padding: 10rpx 24rpx;
  font-size: 23rpx;
  font-weight: 600;
  white-space: nowrap;
}
.mini-btn.ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}
.mini-btn.disabled {
  opacity: 0.5;
}
.empty {
  padding: 40rpx 0;
  text-align: center;
  font-size: 24rpx;
  color: $text-muted;
}
.note {
  display: block;
  margin-top: 12rpx;
  font-size: 22rpx;
  line-height: 1.6;
  color: $text-muted;
}
.manual-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  margin-top: 16rpx;
}
.diag-line {
  display: block;
  margin-top: 10rpx;
  font-size: 21rpx;
  line-height: 1.5;
  color: $text-secondary;
  word-break: break-all;
}
</style>
