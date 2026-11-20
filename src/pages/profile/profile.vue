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

      <!-- 身体信息 -->
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
  getBody, saveBody, getGoals, saveGoals,
} from '@/utils/body-store.js'
import {
  ACTIVITY_OPTIONS, calcBMR, calcBMI, calcLeanMass, calcTDEE, recommendGoals,
  bmiLabel as bmiTagOf,
} from '@/utils/body-calc.js'
import { THEME_OPTIONS, setThemeMode } from '@/utils/theme.js'
import { accountCardState, listAccounts, getSession } from '@/utils/auth-guard.js'

export default {
  data() {
    return {
      themeOptions: THEME_OPTIONS,
      form: { sex: 'male', age: '', height: '', weight: '', bodyFat: '', activity: 1.2 },
      goals: { calorie: '', water: 8, protein: '', weight: '' },
      activityLabels: ACTIVITY_OPTIONS.map((o) => o.label),
      // 账号入口卡状态（onShow → reload 时重读，从注册页返回立刻反映）
      accountCard: null,
    }
  },
  computed: {
    /** 头像圆标：有手机号取后两位，没有就用「我」 */
    avatarText() {
      const phone = (this.accountCard && this.accountCard.phone) || ''
      return phone ? phone.slice(-2) : '我'
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
/* 账号行与身体信息之间的分隔线（账号状态未就绪时整行不渲染，分隔线也一起隐藏） */
.acard-split {
  height: 1rpx;
  margin: 22rpx 0 18rpx;
  background: $border-subtle;
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
</style>
