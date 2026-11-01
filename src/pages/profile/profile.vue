<template>
  <view class="page">
    <!-- 身体信息 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">身体信息</text>
        <text class="card-extra">用于推算基础代谢与目标</text>
      </view>

      <view class="field">
        <text class="field-label">性别</text>
        <view class="seg">
          <view class="seg-item" :class="{ on: form.sex === 'male' }" @click="form.sex = 'male'">男</view>
          <view class="seg-item" :class="{ on: form.sex === 'female' }" @click="form.sex = 'female'">女</view>
        </view>
      </view>

      <view class="field">
        <text class="field-label">年龄</text>
        <input class="field-inp" type="number" v-model="form.age" placeholder="岁" placeholder-class="ph" />
        <text class="field-unit">岁</text>
      </view>
      <view class="field">
        <text class="field-label">身高</text>
        <input class="field-inp" type="digit" v-model="form.height" placeholder="cm" placeholder-class="ph" />
        <text class="field-unit">cm</text>
      </view>
      <view class="field">
        <text class="field-label">体重</text>
        <input class="field-inp" type="digit" v-model="form.weight" placeholder="kg" placeholder-class="ph" />
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

    <!-- 计算成果 -->
    <view class="card">
      <text class="card-title">计算成果</text>
      <view class="big-num-row">
        <text class="big-num">{{ bmr }}</text>
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
        <input class="field-inp" type="number" v-model="goals.water" placeholder="杯" placeholder-class="ph" />
        <text class="field-unit">杯</text>
      </view>
      <view class="field">
        <text class="field-label">蛋白质</text>
        <input class="field-inp" type="number" v-model="goals.protein" placeholder="g" placeholder-class="ph" />
        <text class="field-unit">g</text>
      </view>
      <view class="field">
        <text class="field-label">目标体重</text>
        <input class="field-inp" type="digit" v-model="goals.weight" placeholder="kg" placeholder-class="ph" />
        <text class="field-unit">kg</text>
      </view>
      <view class="btn" @click="saveGoalInfo">保存目标</view>
    </view>

    <!-- 体重记录与趋势 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">体重记录</text>
        <text class="card-extra">今天 {{ todayDate }}</text>
      </view>
      <view class="field">
        <text class="field-label">今天体重</text>
        <input class="field-inp" type="digit" v-model="weightInput" placeholder="如 72.6" placeholder-class="ph" />
        <text class="field-unit">kg</text>
        <text class="save-mini" @click="saveTodayWeight">记下</text>
      </view>
      <view class="kv" v-if="weightCount">
        <text class="kv-k">最近一次</text>
        <text class="kv-v">{{ lastWeight }} kg（{{ lastWeightDate }}）</text>
      </view>
      <view class="kv" v-if="weightCount >= 2">
        <text class="kv-k">趋势</text>
        <text class="kv-v">{{ slopeText }}</text>
      </view>
      <view class="kv" v-if="forecastText">
        <text class="kv-k">按当前趋势</text>
        <text class="kv-v">{{ forecastText }}</text>
      </view>
      <text class="hint" v-if="!weightCount">还没有体重记录；建议每周固定时间称一次，趋势才准。</text>
    </view>

    <!-- 近 7 天统计 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">近 7 天</text>
        <text class="card-extra">有记录 {{ week.activeCount }} 天</text>
      </view>
      <view class="stat-row">
        <view class="stat-cell">
          <text class="stat-num">{{ week.avgIntake }}</text>
          <text class="stat-label">平均摄入</text>
        </view>
        <view class="stat-cell">
          <text class="stat-num">{{ week.avgTdee }}</text>
          <text class="stat-label">平均消耗</text>
        </view>
        <view class="stat-cell">
          <text class="stat-num" :class="{ warn: weekAvgGap > 0 }">{{ weekAvgGap }}</text>
          <text class="stat-label">日均缺口</text>
        </view>
      </view>
      <!-- 简易双柱：绿=摄入 橙=消耗，按 7 天最大值归一；没记录的日子整体淡化 -->
      <view class="bars">
        <view class="bar-col" :class="{ dim: !d.hasRecord }" v-for="d in week.days" :key="d.date">
          <view class="bar-pair">
            <view class="bar intake" :style="{ height: barHeight(d.intake) }"></view>
            <view class="bar tdee" :style="{ height: barHeight(d.tdee) }"></view>
          </view>
          <text class="bar-day">{{ d.date.slice(8) }}</text>
        </view>
      </view>
      <view class="legend">
        <text class="legend-item">摄入</text>
        <text class="legend-item tdee">消耗</text>
      </view>
      <text class="hint">平均值只按"有记录的天"算，没记的日子不参与。</text>
    </view>

    <!-- 运动历史 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">运动历史</text>
        <text class="card-extra" v-if="history.length">共 {{ history.length }} 条</text>
      </view>
      <text class="hint" v-if="!history.length">
        还没有运动记录。到「运动」页跑一次、或记一次其他运动，结束后自动存到这里。
      </text>
      <view class="hist-item" v-for="r in history" :key="r.kind + r.id">
        <view class="hist-main">
          <text class="hist-title">{{ r.title }}</text>
          <text class="hist-sub">{{ durText(r.duration) }} · {{ r.sub }}</text>
        </view>
        <text class="hist-cal">{{ r.calorie }}</text>
        <text class="hist-del" @click="delRecord(r)">删</text>
      </view>
    </view>

    <!-- 数据备份 -->
    <view class="card">
      <text class="card-title">数据备份</text>
      <text class="hint">数据只存在这台设备上。换手机前先导出，粘到备忘录或发给自己即可。</text>
      <view class="btn-row">
        <view class="btn ghost" @click="exportData">导出到剪贴板</view>
        <view class="btn ghost" @click="importData">从剪贴板导入</view>
      </view>
    </view>
  </view>
</template>

<script>
import {
  getBody, saveBody, getGoals, saveGoals,
  getWeightLog, upsertWeight, today,
} from '@/utils/body-store.js'
import {
  ACTIVITY_OPTIONS, calcBMR, calcBMI, calcLeanMass, calcTDEE, recommendGoals,
  calcWeightSlope, forecastDaysToGoal, bmiLabel as bmiTagOf,
} from '@/utils/body-calc.js'
import { getRecords, removeRecord } from '@/utils/storage.js'
import { recentAverages, allExerciseHistory } from '@/utils/day-summary.js'
import { removeActivity, formatActivityDuration } from '@/utils/activity-store.js'

export default {
  data() {
    return {
      todayDate: today(),
      form: { sex: 'male', age: '', height: '', weight: '', bodyFat: '', activity: 1.2 },
      goals: { calorie: '', water: 8, protein: '', weight: '' },
      weightInput: '',
      weightCount: 0,
      lastWeight: '',
      lastWeightDate: '',
      slope: 0,
      activityLabels: ACTIVITY_OPTIONS.map((o) => o.label),
      week: { days: [], activeCount: 0, avgIntake: 0, avgTdee: 0, avgExercise: 0 },
      history: [],
    }
  },
  computed: {
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
    slopeText() {
      const v = this.slope
      if (!v) return '基本持平'
      const abs = Math.abs(v)
      return `${v < 0 ? '下降' : '上升'}中 · 每天约 ${abs.toFixed(2)} kg（每周约 ${(abs * 7).toFixed(2)} kg）`
    },
    forecastText() {
      const goal = Number(this.goals.weight)
      if (!(goal > 0) || !this.lastWeight) return ''
      const days = forecastDaysToGoal(Number(this.lastWeight), this.slope, goal)
      if (days === 0) return '已经到目标体重了'
      if (days < 0) return '按当前趋势还到不了目标，先稳定记录'
      return `约 ${days} 天到 ${goal} kg`
    },
    // 日均缺口 = 平均摄入 − 平均消耗（正数说明在盈余）
    weekAvgGap() {
      return Math.round((this.week.avgIntake || 0) - (this.week.avgTdee || 0))
    },
    // 柱状图归一化基准：7 天里最大的那个数（至少 1，避免除零）
    weekMax() {
      let max = 1
      for (const d of this.week.days || []) {
        max = Math.max(max, Number(d.intake) || 0, Number(d.tdee) || 0)
      }
      return max
    },
  },
  onShow() {
    this.reload()
  },
  methods: {
    reload() {
      const body = getBody()
      this.form = {
        sex: body.sex,
        age: body.age,
        height: body.height,
        weight: body.weight,
        bodyFat: body.bodyFat,
        activity: body.activity,
      }
      const g = getGoals()
      this.goals = {
        calorie: g.calorie ? String(g.calorie) : '',
        water: g.water,
        protein: g.protein ? String(g.protein) : '',
        weight: g.weight ? String(g.weight) : '',
      }
      const log = getWeightLog()
      this.weightCount = log.length
      if (log.length) {
        this.lastWeight = log[log.length - 1].w
        this.lastWeightDate = log[log.length - 1].d
        this.slope = calcWeightSlope(log.slice(-30))
      } else {
        this.lastWeight = ''
        this.lastWeightDate = ''
        this.slope = 0
      }
      // 近 7 天账 + 运动历史
      const week = recentAverages(7)
      this.week = {
        days: week.days,
        activeCount: week.activeCount,
        avgIntake: week.avgIntake,
        avgTdee: week.avgTdee,
        avgExercise: week.avgExercise,
      }
      this.history = allExerciseHistory().slice(0, 12)
    },
    // 柱高：按 7 天最大值归一到 120rpx
    barHeight(v) {
      const h = Math.round(((Number(v) || 0) / this.weekMax) * 120)
      return (h < 2 ? 2 : h) + 'rpx'
    },
    // 时长文案（秒为真值，秒位以下显示"X 秒"）
    durText(seconds) {
      return formatActivityDuration({ seconds })
    },
    // 删除：跑步/走路走 removeRecord，其他运动走 removeActivity
    delRecord(r) {
      uni.showModal({
        title: '删除这条记录',
        content: `确定删除 ${r.date} 的这次运动吗？删除后热量统计会同步减少。`,
        success: (m) => {
          if (!m.confirm) return
          if (r.kind === 'activity') removeActivity(r.date, r.id)
          else removeRecord(r.id)
          this.reload()
          uni.showToast({ title: '已删除', icon: 'success' })
        },
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
    saveTodayWeight() {
      const w = Number(this.weightInput)
      if (!(w > 0)) {
        uni.showToast({ title: '填一下体重', icon: 'none' })
        return
      }
      upsertWeight(this.todayDate, w)
      // 同时更新身体信息里的当前体重，保证各处口径一致
      saveBody({ weight: w })
      this.weightInput = ''
      this.reload()
      uni.showToast({ title: '已记录', icon: 'success' })
    },
    exportData() {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        body: getBody(),
        goals: getGoals(),
        weightLog: getWeightLog(),
        records: getRecords(),
        // 直接读原始键，保证导出是全量而不是只导出今天
        dietDays: uni.getStorageSync('fh_diet_days') || {},
        waterDays: uni.getStorageSync('fh_water_days') || {},
        activityDays: uni.getStorageSync('fh_activity_days') || {},
      }
      uni.setClipboardData({
        data: JSON.stringify(payload),
        success: () => uni.showToast({ title: '已复制到剪贴板', icon: 'success' }),
        fail: () => uni.showToast({ title: '复制失败', icon: 'none' }),
      })
    },
    importData() {
      uni.getClipboardData({
        success: (res) => {
          let data
          try {
            data = JSON.parse(res.data)
          } catch (e) {
            uni.showToast({ title: '剪贴板不是有效的备份', icon: 'none' })
            return
          }
          if (!data || !data.version) {
            uni.showToast({ title: '备份格式不对', icon: 'none' })
            return
          }
          uni.showModal({
            title: '导入会覆盖当前数据',
            content: '确定用剪贴板里的备份覆盖这台设备上的记录吗？',
            success: (m) => {
              if (!m.confirm) return
              if (data.body) saveBody(data.body)
              if (data.goals) saveGoals(data.goals)
              if (data.weightLog) uni.setStorageSync('fh_weight_log', data.weightLog)
              if (data.records) uni.setStorageSync('fh_records', data.records)
              if (data.dietDays) uni.setStorageSync('fh_diet_days', data.dietDays)
              if (data.waterDays) uni.setStorageSync('fh_water_days', data.waterDays)
              if (data.activityDays) uni.setStorageSync('fh_activity_days', data.activityDays)
              this.reload()
              uni.showToast({ title: '已导入', icon: 'success' })
            },
          })
        },
        fail: () => uni.showToast({ title: '读不到剪贴板', icon: 'none' }),
      })
    },
  },
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding-bottom: 160rpx; // 让出底部 tabBar 的高度，避免最后一张卡被压住
  background: $bg-page;
}
.card {
  margin: 20rpx 24rpx 0;
  padding: 24rpx;
  border-radius: 24rpx;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.card-title {
  font-size: 30rpx;
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
  color: #06180d;
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
  border-radius: 16rpx;
  background: linear-gradient(135deg, #2bd45c, #17a348);
  color: #06180d;
  font-size: 28rpx;
  font-weight: 700;
}
.btn.ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}
.btn-row {
  display: flex;
  gap: 16rpx;
}
.btn-row .btn {
  flex: 1;
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
  color: #f2f3f5;
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
  color: #ffb347;
  font-weight: 700;
}
.rec-btn {
  font-size: 24rpx;
  color: $brand-primary;
  border: 1rpx solid rgba(43, 212, 92, 0.5);
  padding: 8rpx 20rpx;
  border-radius: 999rpx;
}
.save-mini {
  font-size: 24rpx;
  color: #06180d;
  background: $brand-primary;
  padding: 10rpx 22rpx;
  border-radius: 999rpx;
}

/* ===== 近 7 天统计 ===== */
.stat-row {
  display: flex;
  margin-top: 16rpx;
}
.stat-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stat-num {
  font-size: 34rpx;
  font-weight: 700;
  color: $text-main;
}
.stat-num.warn {
  color: #ffb347;
}
.stat-label {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-secondary;
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 10rpx;
  height: 150rpx;
  margin-top: 20rpx;
  padding-top: 10rpx;
  border-top: 1rpx solid $border-subtle;
}
.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}
/* 那天没有任何记录：整列淡化，避免把"基础消耗"误读成"有记录" */
.bar-col.dim {
  opacity: 0.3;
}
.bar-pair {
  display: flex;
  align-items: flex-end;
  gap: 4rpx;
  height: 120rpx;
}
.bar {
  width: 14rpx;
  border-radius: 4rpx 4rpx 0 0;
}
.bar.intake {
  background: #2bd45c;
}
.bar.tdee {
  background: #ffb347;
  opacity: 0.75;
}
.bar-day {
  margin-top: 8rpx;
  font-size: 18rpx;
  color: $text-muted;
}
.legend {
  display: flex;
  gap: 24rpx;
  margin-top: 8rpx;
}
.legend-item {
  font-size: 20rpx;
  color: #2bd45c;
}
.legend-item.tdee {
  color: #ffb347;
}

/* ===== 运动历史 ===== */
.hist-item {
  display: flex;
  align-items: center;
  gap: 14rpx;
  padding: 20rpx 0;
  border-bottom: 1rpx solid $border-subtle;
}
.hist-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.hist-title {
  font-size: 28rpx;
  color: $text-main;
}
.hist-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-secondary;
}
.hist-cal {
  font-size: 28rpx;
  font-weight: 700;
  color: #ffb347;
}
.hist-del {
  font-size: 24rpx;
  color: $text-muted;
}
</style>
