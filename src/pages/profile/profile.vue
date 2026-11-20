<template>
  <view class="page" :class="themeClass">
    <!-- 顶部合并卡：账号（三态判定在 auth-guard 的 accountCardState，模板不写判断）+ 身体信息 -->
    <view class="card">
      <view class="acard" v-if="accountCard">
        <view class="acard-avatar">{{ avatarText }}</view>
        <view class="acard-main">
          <text class="acard-title">{{ accountCard.title }}</text>
          <text class="acard-note">{{ accountCard.syncNote }}</text>
        </view>
        <text class="acard-btn" @click="openAccount">{{ accountCard.action }}</text>
      </view>
      <view class="acard-split" v-if="accountCard"></view>

      <!-- 身体信息：默认折叠成一行摘要，点「编辑」展开原表单 -->
      <view class="card-head">
        <text class="card-title">身体信息</text>
        <text class="body-toggle" v-if="editing" @click="editing = false">收起</text>
        <text class="card-extra" v-else>用于推算基础代谢与目标</text>
      </view>

      <!-- 摘要行（收起时才有）：缺的字段直接跳过，不出现空档 -->
      <view class="body-sum" v-show="!editing">
        <text class="body-sum-text">{{ bodySummary || '点右侧「编辑」补全资料' }}</text>
        <text class="body-sum-edit" @click="editing = true">编辑</text>
      </view>

      <!-- 表单：用 v-show 而不是 v-if —— 填一半点「收起」再展开，输入不能丢 -->
      <view v-show="editing">
        <view class="field">
          <text class="field-label">性别</text>
          <view class="seg">
            <view class="seg-item" :class="{ on: form.sex === 'male' }" @click="form.sex = 'male'">男</view>
            <view class="seg-item" :class="{ on: form.sex === 'female' }" @click="form.sex = 'female'">女</view>
          </view>
        </view>

        <view class="field">
          <text class="field-label">年龄</text>
          <input class="field-inp" type="number" v-model="form.age" placeholder="如 25" placeholder-class="ph" />
          <text class="field-unit">岁</text>
        </view>
        <view class="field">
          <text class="field-label">身高</text>
          <input class="field-inp" type="digit" v-model="form.height" placeholder="如 175" placeholder-class="ph" />
          <text class="field-unit">cm</text>
        </view>
        <view class="field">
          <text class="field-label">体重</text>
          <input class="field-inp" type="digit" v-model="form.weight" placeholder="如 70" placeholder-class="ph" />
          <text class="field-unit">kg</text>
        </view>
        <view class="field">
          <text class="field-label">体脂率</text>
          <input
            class="field-inp"
            type="digit"
            v-model="form.bodyFat"
            placeholder="不填则按身高年龄估算"
            placeholder-class="ph"
          />
          <text class="field-unit">%</text>
        </view>
        <view class="field">
          <text class="field-label">活动量</text>
          <picker :range="activityLabels" :value="activityIndex" @change="onActivityChange">
            <view class="picker-value">{{ activityLabels[activityIndex] }}</view>
          </picker>
        </view>

        <text class="hint">{{ bmrHint }}</text>
        <view class="btn" @click="saveBodyInfo">保存并计算</view>
      </view>
    </view>

    <!-- 计算成果 -->
    <view class="card">
      <text class="card-title">计算成果</text>
      <view class="big-num-row">
        <text class="big-num num">{{ bmr }}</text>
        <text class="big-unit">kcal / 天（基础代谢 BMR）</text>
      </view>
      <view class="kv"><text class="kv-k">瘦体重</text><text class="kv-v">{{ leanMass || '—' }} kg</text></view>
      <view class="kv">
        <text class="kv-k">BMI</text>
        <text class="kv-v">{{ bmi || '—' }} {{ bmiTag ? '（' + bmiTag + '）' : '' }}</text>
      </view>
      <view class="kv"><text class="kv-k">活动系数</text><text class="kv-v">{{ form.activity }}</text></view>
      <view class="kv">
        <text class="kv-k">每日总消耗 TDEE</text>
        <text class="kv-v strong">{{ tdee }} kcal</text>
      </view>
      <text class="hint">TDEE = BMR × 活动系数，不含运动；运动消耗在「运动」页记录后叠加。</text>
    </view>

    <!-- 每日目标 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">每日目标</text>
        <text class="rec-btn" @click="applyRecommend">一键推荐</text>
      </view>
      <view class="field">
        <text class="field-label">热量</text>
        <input class="field-inp" type="number" v-model="goals.calorie" placeholder="留空则不设" placeholder-class="ph" />
        <text class="field-unit">kcal</text>
      </view>
      <view class="field">
        <text class="field-label">饮水</text>
        <input class="field-inp" type="number" v-model="goals.water" placeholder="如 8" placeholder-class="ph" />
        <text class="field-unit">杯</text>
      </view>
      <view class="field">
        <text class="field-label">蛋白质</text>
        <input class="field-inp" type="number" v-model="goals.protein" placeholder="如 120" placeholder-class="ph" />
        <text class="field-unit">g</text>
      </view>
      <view class="field">
        <text class="field-label">目标体重</text>
        <input class="field-inp" type="digit" v-model="goals.weight" placeholder="如 68" placeholder-class="ph" />
        <text class="field-unit">kg</text>
      </view>
      <view class="btn" @click="saveGoalInfo">保存目标</view>
    </view>

    <!-- 数据：导出 / 导入备份文件（换机迁移；序列化、白名单、60 天裁剪、并集合并都在 backup-native 里） -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">数据</text>
        <text class="card-extra">json 文件</text>
      </view>
      <text class="hint">换手机前导出一份，到新设备上导入即可。</text>

      <view class="data-actions">
        <view class="data-btn" :class="{ busy: exporting }" @click="doExportFile">
          {{ exporting ? '导出中…' : '导出文件' }}
        </view>
        <view class="data-btn ghost" :class="{ busy: importing }" @click="askImport">
          {{ importing ? '导入中…' : '从文件导入' }}
        </view>
      </view>

      <!-- App 端多一条捷径：直接读本机最近一次导出的那份（H5 没有文件系统，编译期裁掉） -->
      <!-- #ifdef APP-PLUS -->
      <text class="data-link" @click="readLatestBackup">读取本机最近一次导出的文件</text>
      <!-- #endif -->

      <!-- 导出结果：App 端系统分享面板没弹出来时，把落盘路径也写出来，用户能自己去文件管理器取 -->
      <text class="data-note" v-if="lastExport">已导出 {{ lastExport.fileName }}</text>
      <text class="data-note" v-if="lastExport && lastExport.path && !lastExport.shared">
        文件位置：{{ lastExport.path }}
      </text>
      <text class="data-note" v-if="lastExport && formatCounts(lastExport.counts)">
        含 {{ formatCounts(lastExport.counts) }}
      </text>

      <!-- 导入结果 -->
      <text class="data-note" v-if="lastImport">
        已恢复 {{ lastImport.applied }} 项<text v-if="formatCounts(lastImport.counts)">：{{ formatCounts(lastImport.counts) }}</text>
      </text>
      <text class="data-note warn" v-if="lastImport && lastImport.skipped">
        忽略了 {{ lastImport.skipped }} 个本版本不认识的字段
      </text>
      <text class="data-note warn" v-if="lastImport && lastImport.failed">
        有 {{ lastImport.failed }} 项写入失败
      </text>

      <text class="data-limit">不含账号口令与地图缓存；按天数据只保留最近 60 天。</text>
    </view>

    <!-- 外观：白天 / 黑夜 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">外观</text>
        <text class="card-extra">白天 / 黑夜</text>
      </view>
      <view class="tseg">
        <view
          class="tseg-item"
          :class="{ on: themeMode === opt.value }"
          v-for="opt in themeOptions"
          :key="opt.value"
          @click="chooseTheme(opt.value)"
        >
          <text class="tseg-icon">{{ opt.icon }}</text>
          <text class="tseg-label">{{ opt.label }}</text>
        </view>
      </view>
      <text class="hint">选「跟随系统」时，会随手机的深色模式自动切换。</text>
    </view>
  </view>
</template>

<script>
import {
  getBody, saveBody, getGoals, saveGoals, hasBodyData, getStoredBody,
} from '@/utils/body-store.js'
import {
  ACTIVITY_OPTIONS, calcBMR, calcBMI, calcLeanMass, calcTDEE, recommendGoals,
  bmiLabel as bmiTagOf,
} from '@/utils/body-calc.js'
import { THEME_OPTIONS, setThemeMode } from '@/utils/theme.js'
import { accountCardState, listAccounts, getSession } from '@/utils/auth-guard.js'
import { exportBackupFile, importBackupText, readLatestBackupFromDevice, readBackupForImport } from '@/utils/backup-native.js'

/** 活动量标签去掉括号说明：'中度活动（每周 3–5 次）' → '中度活动' */
function shortActivityLabel(label) {
  return String(label || '').replace(/（[^）]*）/g, '')
}

export default {
  data() {
    return {
      themeOptions: THEME_OPTIONS,
      form: { sex: 'male', age: '', height: '', weight: '', bodyFat: '', activity: 1.2 },
      goals: { calorie: '', water: 8, protein: '', weight: '' },
      activityLabels: ACTIVITY_OPTIONS.map((o) => o.label),
      // 账号入口卡状态（onShow → reload 时重读，从注册页返回立刻反映）
      accountCard: null,
      // 身体信息：展开/收起。初值直接按"本机填过没有"定 —— 放在 data 里而不是 onShow，
      // 是为了避免老用户进页面时先闪一帧展开表单。没填过 → 默认展开。
      editing: !hasBodyData(),
      // 数据卡：导出/导入状态
      exporting: false,
      importing: false,
      lastExport: null,
      lastImport: null,
    }
  },
  computed: {
    /** 头像圆标：有手机号取后两位，没有就用「我」 */
    avatarText() {
      const phone = (this.accountCard && this.accountCard.phone) || ''
      return phone ? phone.slice(-2) : '我'
    },
    /**
     * 收起态摘要：缺的字段直接跳过，不留空档。
     * 性别与活动量只在"至少填了一个数值字段"时才带上 —— 否则新人会看到「男 · 中度活动」这种
     * 其实什么都没填的假摘要（它们有默认值）。
     */
    bodySummary() {
      const weight = Number(this.form.weight)
      const height = Number(this.form.height)
      const age = Number(this.form.age)
      const parts = []
      if (weight > 0) parts.push(weight + ' kg')
      if (height > 0) parts.push(height + ' cm')
      if (age > 0) parts.push(age + ' 岁')
      if (!parts.length) return ''
      parts.push(this.form.sex === 'female' ? '女' : '男')
      const label = this.activityLabels[this.activityIndex]
      if (label) parts.push(shortActivityLabel(label))
      return parts.join(' · ')
    },
    activityIndex() {
      const i = ACTIVITY_OPTIONS.findIndex((o) => Number(o.value) === Number(this.form.activity))
      return i < 0 ? 0 : i
    },
    bmrInfo() {
      return calcBMR(this.form)
    },
    bmr() {
      return this.bmrInfo.value
    },
    bmrHint() {
      const f = this.bmrInfo.formula
      if (f === 'katch') return '已按体脂率用 Katch-McArdle 公式计算（更准）'
      if (f === 'mifflin') return '未填体脂率，用 Mifflin-St Jeor 公式按身高/年龄/性别估算'
      return '填上体重，再加身高年龄（或体脂率）就能算出基础代谢'
    },
    leanMass() {
      return calcLeanMass(this.form.weight, this.form.bodyFat)
    },
    bmi() {
      return calcBMI(this.form.weight, this.form.height)
    },
    bmiTag() {
      return bmiTagOf(this.bmi)
    },
    tdee() {
      return calcTDEE(this.bmr, this.form.activity, 0)
    },
  },
  onShow() {
    this.reload()
  },
  methods: {
    // 切换白天/黑夜（mixin 提供 themeMode；setThemeMode 负责持久化 + 广播）
    chooseTheme(v) {
      setThemeMode(v)
      const hit = THEME_OPTIONS.filter((o) => o.value === v)[0]
      uni.showToast({ title: '外观：' + (hit ? hit.label : v), icon: 'none' })
    },
    reload() {
      // 用 getStoredBody()（只含真实填过的字段）而不是 getBody()（带 60kg/170cm/25 岁兜底值）：
      // 否则新用户一进来，表单与摘要上就凭空出现"60 kg · 170 cm · 25 岁"这种假数据。
      const body = getStoredBody()
      this.form = {
        sex: body.sex || 'male',
        age: body.age,
        height: body.height,
        weight: body.weight,
        bodyFat: body.bodyFat,
        activity: body.activity || 1.2,
      }
      const g = getGoals()
      this.goals = {
        calorie: g.calorie ? String(g.calorie) : '',
        water: g.water,
        protein: g.protein ? String(g.protein) : '',
        weight: g.weight ? String(g.weight) : '',
      }
      // 账号入口卡：onShow → reload 会重读，用户从注册页返回时这里立刻变
      this.accountCard = accountCardState({ accounts: listAccounts(), session: getSession() })
    },
    /** 进注册页（同一个页面按自身状态渲染注册表单 / 登录表单 / 已登录态） */
    openAccount() {
      uni.navigateTo({
        url: '/pages/register/register',
        fail: () => uni.showToast({ title: '打不开注册页', icon: 'none' }),
      })
    },
    onActivityChange(e) {
      const opt = ACTIVITY_OPTIONS[Number(e.detail.value)]
      if (opt) this.form.activity = opt.value
    },
    saveBodyInfo() {
      saveBody({
        sex: this.form.sex,
        age: this.form.age,
        height: this.form.height,
        weight: this.form.weight,
        bodyFat: this.form.bodyFat,
        activity: this.form.activity,
      })
      this.reload()
      // 保存成功后自动收起；摘要行由 form 实时派生，会同时更新
      this.editing = false
      uni.showToast({ title: '已保存', icon: 'success' })
    },
    saveGoalInfo() {
      saveGoals({
        calorie: this.goals.calorie,
        water: this.goals.water,
        protein: this.goals.protein,
        weight: this.goals.weight,
      })
      this.reload()
      uni.showToast({ title: '已保存', icon: 'success' })
    },
    applyRecommend() {
      const r = recommendGoals({
        tdee: this.tdee,
        bmr: this.bmr,
        weightKg: this.form.weight,
        targetWeight: this.goals.weight,
      })
      if (!r.calorie) {
        uni.showToast({ title: '先填身体信息', icon: 'none' })
        return
      }
      this.goals.calorie = String(r.calorie)
      this.goals.water = r.water
      this.goals.protein = String(r.protein)
      this.saveGoalInfo()
    },

    // ---------- 数据：导出 / 导入备份文件（序列化、白名单、裁剪、合并都在 backup-native/backup） ----------
    /** counts → "饮食 42 天 · 运动 18 天 · 体重 31 条"，没有的项直接跳过 */
    formatCounts(counts) {
      const c = counts || {}
      const parts = []
      if (c.dietDays) parts.push('饮食 ' + c.dietDays + ' 天')
      if (c.waterDays) parts.push('饮水 ' + c.waterDays + ' 天')
      if (c.activityDays) parts.push('运动 ' + c.activityDays + ' 天')
      if (c.records) parts.push('跑步/走路 ' + c.records + ' 条')
      if (c.weightLog) parts.push('体重 ' + c.weightLog + ' 条')
      return parts.join(' · ')
    },
    async doExportFile() {
      if (this.exporting) return
      this.exporting = true
      try {
        const r = await exportBackupFile()
        if (!r.ok) {
          uni.showToast({ title: r.reason || '导出失败', icon: 'none' })
          return
        }
        this.lastExport = {
          fileName: r.fileName,
          path: r.path || '',
          shared: !!r.shared,
          downloaded: !!r.downloaded,
          counts: r.summary || {},
        }
        // H5 是浏览器下载；App 是写入 _doc/ 后弹系统分享面板
        uni.showToast({
          title: (r.downloaded ? '已下载 ' : '已导出 ') + r.fileName,
          icon: 'none',
        })
      } finally {
        this.exporting = false
      }
    },
    /** 主入口：先二次确认（说明覆盖/并集规则），确认后再去读文件 */
    askImport() {
      if (this.importing) return
      uni.showModal({
        title: '从备份文件恢复',
        content:
          '同名的个人数据（身体信息、每日目标、体重记录、跑步/走路记录）会被备份覆盖；按天数据（饮食/饮水/运动）取并集。确定继续？',
        confirmText: '继续导入',
        success: async (m) => {
          if (!m.confirm) return
          this.importing = true
          try {
            const got = await readBackupForImport()
            if (!got.ok) {
              // 失败原因通常是一句话（H5 无文件系统 / 还没导出过），用弹窗而不是 toast 才看得全
              uni.showModal({
                title: '读不到备份文件',
                content: got.reason || '请先在旧设备上导出一份备份',
                showCancel: false,
              })
              return
            }
            this.runImport(got.text, got.name)
          } finally {
            this.importing = false
          }
        },
      })
    },
    /** App 端小字入口：先读文件（知道文件名），再用带文件名的确认框导入 */
    readLatestBackup() {
      if (this.importing) return
      this.importing = true
      readLatestBackupFromDevice().then((got) => {
        this.importing = false
        if (!got.ok) {
          uni.showModal({
            title: '读不到备份文件',
            content: got.reason || '请先在旧设备上导出一份备份',
            showCancel: false,
          })
          return
        }
        uni.showModal({
          title: '导入这份备份？',
          content:
            got.name + '\n同名的个人数据会被覆盖；按天数据取并集。',
          confirmText: '导入',
          success: (m) => {
            if (m.confirm) this.runImport(got.text, got.name)
          },
        })
      })
    },
    runImport(text, fileName) {
      const r = importBackupText(text)
      if (!r.ok) {
        uni.showToast({ title: r.reason || '导入失败', icon: 'none' })
        return
      }
      this.lastImport = {
        fileName: fileName || '',
        counts: r.counts || {},
        applied: (r.applied || []).length,
        skipped: (r.skipped || []).length,
        failed: (r.failed || []).length,
        exportedAt: r.exportedAt || '',
      }
      // 备份可能改了身体信息/目标/体重，立刻重读
      this.reload()
      this.editing = false
      uni.showToast({ title: '已恢复 ' + this.lastImport.applied + ' 项', icon: 'success' })
    },
  },
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding-top: calc(var(--status-bar-height) + 16rpx);
  padding-bottom: 160rpx; // 让出底部 tabBar 的高度，避免最后一张卡被压住
  background: $bg-page;
}
.card {
  margin: 20rpx 24rpx 0;
  padding: $card-pad;
  border-radius: $card-radius;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.card-title {
  font-size: $card-title-font;
  font-weight: 700;
  color: $text-main;
}
.card-extra {
  font-size: 22rpx;
  color: $text-secondary;
}
.field {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 18rpx 0;
  border-bottom: 1rpx solid $border-subtle;
}
.field-label {
  width: 150rpx;
  font-size: 26rpx;
  color: $text-secondary;
}
.field-inp {
  flex: 1;
  height: 60rpx;
  font-size: 28rpx;
  color: $text-main;
  text-align: right;
}
.ph {
  color: $text-muted;
}
.field-unit {
  font-size: 24rpx;
  color: $text-muted;
  min-width: 60rpx;
  text-align: right;
}
.seg {
  display: flex;
  gap: 12rpx;
}
.seg-item {
  padding: 10rpx 28rpx;
  border-radius: 999rpx;
  background: $bg-card-light;
  color: $text-secondary;
  font-size: 26rpx;
  border: 1rpx solid $border-subtle;
}
.seg-item.on {
  color: var(--on-accent);
  background: $brand-primary;
  font-weight: 700;
  border-color: transparent;
}
.picker-value {
  font-size: 28rpx;
  color: $text-main;
  text-align: right;
}
.hint {
  display: block;
  margin-top: 14rpx;
  font-size: 22rpx;
  color: $text-muted;
  line-height: 1.5;
}
.btn {
  margin-top: 22rpx;
  text-align: center;
  padding: 22rpx 0;
  border-radius: $btn-radius;
  background: var(--accent);
  color: var(--on-accent);
  font-size: $btn-font-lg;
  font-weight: 700;
}
.big-num-row {
  display: flex;
  align-items: baseline;
  gap: 12rpx;
  margin-top: 12rpx;
}
.big-num {
  font-size: 64rpx;
  font-weight: 800;
  color: var(--text-1);
  line-height: 1;
}
.big-unit {
  font-size: 22rpx;
  color: $text-secondary;
}
.kv {
  display: flex;
  justify-content: space-between;
  margin-top: 16rpx;
}
.kv-k {
  font-size: 26rpx;
  color: $text-secondary;
}
.kv-v {
  font-size: 26rpx;
  color: $text-main;
}
.kv-v.strong {
  color: var(--warm-text);
  font-weight: 700;
}
.rec-btn {
  font-size: 24rpx;
  color: var(--accent-text);
  border: 1rpx solid var(--accent-soft-2);
  padding: 8rpx 20rpx;
  border-radius: 999rpx;
}

/* flat-press:2026-11-06 */
.btn:active,
.rec-btn:active,
.row:active {
  transform: scale(0.97);
  opacity: 0.9;
}
/* theme-seg:2026-11-06 */
.tseg {
  display: flex;
  gap: 6rpx;
  margin-top: 18rpx;
  padding: 6rpx;
  border-radius: 999rpx;
  background: var(--bg-card-2);
  border: 1rpx solid var(--line);
}
.tseg-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rpx;
  padding: 16rpx 0;
  border-radius: 999rpx;
  transition: background-color 0.18s var(--ease), color 0.18s var(--ease),
    transform 0.12s var(--ease);
}
.tseg-item:active {
  transform: scale(0.97);
}
.tseg-icon {
  font-size: 28rpx;
  line-height: 1.1;
}
.tseg-label {
  font-size: 22rpx;
  color: var(--text-2);
}
.tseg-item.on {
  background: var(--accent);
}
.tseg-item.on .tseg-label {
  color: var(--on-accent);
  font-weight: 700;
}

/* ===== 账号入口卡（2026-11-20）：随机账号 / 已注册 / 已登录 ===== */
.acard {
  display: flex;
  align-items: center;
  gap: 18rpx;
}
/* 账号行与身体信息之间的分隔线（账号状态未就绪时整行不渲染，分隔线也一起隐藏）。
   用 --line-strong 而不是 --line：黑夜主题下 --line 压在 --bg-card 上几乎看不见，
   而把 --line 加到 2rpx 又显得笨重 —— 加深一档比加粗干净（2026-11-20 实测结论）。 */
.acard-split {
  height: 1rpx;
  margin: 22rpx 0 18rpx;
  background: $border-strong;
}
.acard-avatar {
  width: 76rpx;
  height: 76rpx;
  line-height: 76rpx;
  text-align: center;
  border-radius: 999rpx;
  background: var(--accent-soft);
  border: 1rpx solid var(--accent-soft-2);
  color: var(--accent-text);
  font-size: 26rpx;
  font-weight: 800;
}
.acard-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.acard-title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--text-1);
}
.acard-note {
  margin-top: 6rpx;
  font-size: 20rpx;
  color: var(--text-3);
}
.acard-btn {
  font-size: 24rpx;
  font-weight: 700;
  color: var(--on-accent);
  background: var(--accent);
  padding: 12rpx 26rpx;
  border-radius: 999rpx;
  transition: transform 0.12s var(--ease), opacity 0.18s var(--ease);
}
.acard-btn:active {
  transform: scale(0.96);
  opacity: 0.9;
}

/* ===== 身体信息：收起态摘要行 + 展开/收起控件（2026-11-20） ===== */
.body-sum {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  padding: 4rpx 0 2rpx;
}
.body-sum-text {
  flex: 1;
  font-size: 28rpx;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.4;
}
/* 「编辑」用胶囊，和账号卡右上角那个按钮同一族 */
.body-sum-edit {
  font-size: 24rpx;
  font-weight: 700;
  color: var(--on-accent);
  background: var(--accent);
  padding: 10rpx 24rpx;
  border-radius: 999rpx;
  transition: transform 0.12s var(--ease), opacity 0.18s var(--ease);
}
.body-sum-edit:active {
  transform: scale(0.96);
  opacity: 0.9;
}
/* 展开态的「收起」是次要操作，用描边胶囊，不与主按钮抢注意力 */
.body-toggle {
  font-size: 24rpx;
  color: var(--accent-text);
  padding: 8rpx 20rpx;
  border-radius: 999rpx;
  border: 1rpx solid var(--accent-soft-2);
}

/* ===== 数据卡：导出 / 导入备份文件（2026-11-20，替代旧的剪贴板方案） ===== */
.data-actions {
  display: flex;
  gap: 16rpx;
  margin-top: 18rpx;
}
.data-btn {
  flex: 1;
  text-align: center;
  padding: 20rpx 0;
  border-radius: $btn-radius;
  background: var(--accent);
  color: var(--on-accent);
  font-size: $btn-font;
  font-weight: 700;
  transition: transform 0.12s var(--ease), opacity 0.18s var(--ease);
}
.data-btn.ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}
.data-btn.busy {
  opacity: 0.6;
}
.data-btn:active {
  transform: scale(0.97);
  opacity: 0.92;
}
/* App 端的"读本机最近一次导出"：小字按钮 */
.data-link {
  display: block;
  margin-top: 14rpx;
  font-size: 22rpx;
  color: var(--accent-text);
  text-decoration: underline;
}
/* 导出/导入结果行；文件路径可能很长，允许断行 */
.data-note {
  display: block;
  margin-top: 12rpx;
  font-size: 22rpx;
  color: $text-secondary;
  line-height: 1.5;
  word-break: break-all;
}
.data-note.warn {
  color: var(--warm-text);
}
/* 能力边界：这一行不能省 */
.data-limit {
  display: block;
  margin-top: 14rpx;
  padding-top: 12rpx;
  border-top: 1rpx solid $border-subtle;
  font-size: 20rpx;
  color: $text-muted;
  line-height: 1.5;
}
</style>
