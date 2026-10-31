<template>
  <view class="page">
    <!-- 日期条 -->
    <view class="date-bar">
      <view
        v-for="d in dateTabs"
        :key="d.date"
        class="date-item"
        :class="{ active: date === d.date }"
        @click="switchDate(d.date)"
      >
        {{ d.label }}
      </view>
    </view>

    <!-- 热量总览：缺口是这一页最想让你看见的数字 -->
    <view class="hero">
      <text class="hero-label">{{ gapLabel }}</text>
      <view class="hero-num-row">
        <text class="hero-num">{{ gapAbs }}</text>
        <text class="hero-unit">kcal</text>
      </view>
      <view class="hero-row">
        <view class="hero-cell">
          <text class="cell-num">{{ summary.intake }}</text>
          <text class="cell-label">摄入</text>
        </view>
        <view class="hero-cell">
          <text class="cell-num">{{ summary.tdee }}</text>
          <text class="cell-label">总消耗</text>
        </view>
        <view class="hero-cell">
          <text class="cell-num">{{ summary.calorieGoal || '—' }}</text>
          <text class="cell-label">目标</text>
        </view>
      </view>
    </view>

    <!-- 消耗拆解 -->
    <view class="card">
      <text class="card-title">今天怎么消耗的</text>
      <view class="kv">
        <text class="kv-k">基础代谢 × 活动系数</text>
        <text class="kv-v">{{ summary.tdeeBase }} kcal</text>
      </view>
      <view class="kv">
        <text class="kv-k">跑步 / 走路</text>
        <text class="kv-v">{{ summary.exercise.runCalorie }} kcal</text>
      </view>
      <view class="kv">
        <text class="kv-k">其他运动</text>
        <text class="kv-v">{{ summary.exercise.otherCalorie }} kcal</text>
      </view>
      <text class="hint">{{ bmrHint }}</text>
    </view>

    <!-- 饮水 -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">饮水</text>
        <text class="card-extra">{{ summary.water }} / {{ summary.waterGoal }} 杯</text>
      </view>
      <view class="cups">
        <view
          v-for="i in 8"
          :key="i"
          class="cup"
          :class="{ on: i <= summary.water }"
          @click="setWater(i)"
        >
          💧
        </view>
      </view>
    </view>

    <!-- 四个餐次 -->
    <view class="card" v-for="m in MEALS" :key="m.key">
      <view class="card-head">
        <text class="card-title">{{ m.icon }} {{ m.label }}</text>
        <view class="card-head-right">
          <text class="card-extra">{{ mealCalorie(m.key) }} kcal</text>
          <text class="add-btn" @click="openAdd(m.key)">+ 添加</text>
        </view>
      </view>
      <view v-if="!byMeal[m.key] || !byMeal[m.key].length" class="empty">还没有记录</view>
      <view class="entry" v-for="e in byMeal[m.key]" :key="e.id">
        <view class="entry-main">
          <text class="entry-name">{{ e.name }}</text>
          <text class="entry-sub">
            {{ e.amount }}g · 碳 {{ e.carb }} / 蛋 {{ e.protein }} / 脂 {{ e.fat }}
          </text>
        </view>
        <text class="entry-cal">{{ e.calorie }}</text>
        <text class="entry-del" @click="remove(e)">删</text>
      </view>
    </view>

    <!-- 添加浮层 -->
    <view class="mask" v-if="showAdd" @click="closeAdd">
      <view class="sheet" @click.stop>
        <view class="sheet-tabs">
          <view class="sheet-tab" :class="{ active: addMode === 'search' }" @click="setMode('search')">搜食物</view>
          <view class="sheet-tab" :class="{ active: addMode === 'dish' }" @click="setMode('dish')">菜品估算</view>
          <view class="sheet-tab" :class="{ active: addMode === 'manual' }" @click="setMode('manual')">自定义</view>
        </view>

        <!-- 搜食物 -->
        <template v-if="addMode === 'search'">
          <input
            class="inp"
            v-model="keyword"
            placeholder="搜食物，如 米饭 / 鸡蛋 / 苹果"
            placeholder-class="ph"
            @input="doSearch"
          />
          <scroll-view scroll-y class="result-list" v-if="results.length">
            <view class="result" v-for="f in results" :key="f.name" @click="pickFood(f)">
              <view class="result-main">
                <text class="result-name">{{ f.name }}</text>
                <text class="result-sub">{{ f.calorie }} kcal / 100g · 碳{{ f.carb }} 蛋{{ f.protein }} 脂{{ f.fat }}</text>
              </view>
            </view>
          </scroll-view>
          <view class="empty" v-else-if="keyword">没搜到，换种写法或改用「菜品估算 / 自定义」</view>
        </template>

        <!-- 菜品估算 -->
        <template v-else-if="addMode === 'dish'">
          <input
            class="inp"
            v-model="dishName"
            placeholder="输入菜名，如 西红柿炒鸡蛋"
            placeholder-class="ph"
            @input="dishResult = null"
          />
          <view class="btn-mini" @click="doEstimate">估算</view>
          <view class="dish-box" v-if="dishResult">
            <text class="dish-line">
              每 100g 约 {{ dishResult.calorie }} kcal（做法：{{ dishResult.method || '未识别' }}）
            </text>
            <text class="dish-line sub">
              拆出原料：{{ dishParts }}<text v-if="dishResult.oil"> · 另有约 {{ dishResult.oil }}g 油</text>
            </text>
          </view>
          <view class="dish-box" v-else-if="dishError">
            <text class="dish-line sub">{{ dishError }}</text>
          </view>
        </template>

        <!-- 自定义 -->
        <template v-else>
          <input class="inp" v-model="manual.name" placeholder="食物名称" placeholder-class="ph" />
          <view class="macro-row">
            <input class="inp half" type="digit" v-model="manual.carb" placeholder="碳水 g" placeholder-class="ph" />
            <input class="inp half" type="digit" v-model="manual.protein" placeholder="蛋白 g" placeholder-class="ph" />
            <input class="inp half" type="digit" v-model="manual.fat" placeholder="脂肪 g" placeholder-class="ph" />
          </view>
          <text class="hint">按每 100g 填；热量自动按 碳4/蛋4/脂9 计算：{{ manualCalorie }} kcal/100g</text>
        </template>

        <!-- 份量 + 确认 -->
        <view class="amount-row">
          <text class="amount-label">吃了多少</text>
          <input class="inp amount-inp" type="digit" v-model="amount" placeholder="克" placeholder-class="ph" />
          <text class="amount-unit">g</text>
        </view>
        <view class="sheet-actions">
          <view class="btn-mini ghost" @click="closeAdd">取消</view>
          <view class="btn-mini primary" @click="confirmAdd">加到{{ mealLabel }}</view>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import { MEALS, MEAL_MAP, getDayEntries, addEntry, removeEntry, summarizeByMeal, setWater as saveWater } from '@/utils/diet-store.js'
import { searchFoods, estimateDish, COMMON_FOODS } from '@/utils/nutrition.js'
import { macroToCalorie } from '@/utils/body-calc.js'
import { dayCalories } from '@/utils/day-summary.js'
import { today, dateOffset } from '@/utils/body-store.js'

const EMPTY_SUMMARY = {
  intake: 0, carb: 0, protein: 0, fat: 0, count: 0, water: 0,
  bmr: 0, bmrFormula: 'none', activity: 1.2, tdeeBase: 0,
  exercise: { runCalorie: 0, otherCalorie: 0, total: 0, minutes: 0, runCount: 0, otherCount: 0 },
  tdee: 0, gap: 0, calorieGoal: 0, waterGoal: 8, proteinGoal: 0,
}

export default {
  data() {
    return {
      MEALS,
      date: today(),
      summary: Object.assign({}, EMPTY_SUMMARY),
      byMeal: {},
      // 添加浮层
      showAdd: false,
      addMeal: 'breakfast',
      addMode: 'search',
      keyword: '',
      results: [],
      picked: null,
      dishName: '',
      dishResult: null,
      dishError: '',
      manual: { name: '', carb: '', protein: '', fat: '' },
      amount: '',
    }
  },
  computed: {
    dateTabs() {
      return [
        { date: today(), label: '今天' },
        { date: dateOffset(-1), label: '昨天' },
        { date: dateOffset(-2), label: '前天' },
      ]
    },
    gapAbs() {
      return Math.abs(Number(this.summary.gap) || 0)
    },
    gapLabel() {
      const gap = Number(this.summary.gap) || 0
      if (!this.summary.intake) return '今天还没记录饮食'
      return gap < 0 ? '还差这些热量达标（缺口）' : '已超出目标（盈余）'
    },
    bmrHint() {
      if (!this.summary.bmr) return '先到「我的」填写身体信息，才能算出基础代谢'
      const f = this.summary.bmrFormula === 'katch' ? 'Katch-McArdle（按体脂率）' : 'Mifflin-St Jeor'
      return `基础代谢 ${this.summary.bmr} kcal（${f}）× 活动系数 ${this.summary.activity}`
    },
    mealLabel() {
      const m = MEAL_MAP[this.addMeal]
      return m ? m.label : '餐次'
    },
    dishParts() {
      if (!this.dishResult) return ''
      return this.dishResult.parts.map((p) => `${p.name}${Math.round(p.ratio * 100)}%`).join(' + ')
    },
    manualCalorie() {
      return macroToCalorie(this.manual.carb, this.manual.protein, this.manual.fat)
    },
  },
  onShow() {
    this.reload()
  },
  methods: {
    reload() {
      this.summary = dayCalories(this.date)
      this.byMeal = summarizeByMeal(getDayEntries(this.date))
    },
    switchDate(d) {
      this.date = d
      this.reload()
    },
    mealCalorie(key) {
      return (this.byMeal[key] || []).reduce((a, e) => a + (Number(e.calorie) || 0), 0)
    },
    setWater(n) {
      // 点同一杯等于取消到上一杯，点空杯等于填到该杯
      const next = this.summary.water === n ? n - 1 : n
      saveWater(this.date, next)
      this.summary = dayCalories(this.date)
    },
    openAdd(meal) {
      this.addMeal = meal
      this.showAdd = true
      this.setMode('search')
    },
    closeAdd() {
      this.showAdd = false
      this.keyword = ''
      this.results = []
      this.picked = null
      this.dishName = ''
      this.dishResult = null
      this.dishError = ''
      this.manual = { name: '', carb: '', protein: '', fat: '' }
      this.amount = ''
    },
    setMode(mode) {
      this.addMode = mode
      // 切到搜索时先给几条常用食物，免得一片空白
      if (mode === 'search' && !this.keyword) this.results = COMMON_FOODS.slice(0, 8)
    },
    doSearch() {
      const kw = String(this.keyword || '').trim()
      this.results = kw ? searchFoods(kw, 20) : COMMON_FOODS.slice(0, 8)
      this.picked = null
    },
    pickFood(f) {
      this.picked = f
      this.amount = this.amount || '100'
    },
    doEstimate() {
      const r = estimateDish(this.dishName)
      if (!r.ok) {
        this.dishResult = null
        this.dishError = r.reason || '估算失败'
        return
      }
      this.dishError = ''
      this.dishResult = r
      this.amount = this.amount || '150'
    },
    confirmAdd() {
      const grams = Number(this.amount)
      if (!(grams > 0)) {
        uni.showToast({ title: '填一下吃了多少克', icon: 'none' })
        return
      }
      let base = null
      let name = ''
      let source = 'food'
      if (this.addMode === 'search') {
        if (!this.picked) {
          uni.showToast({ title: '先选一个食物', icon: 'none' })
          return
        }
        base = this.picked
        name = this.picked.name
      } else if (this.addMode === 'dish') {
        if (!this.dishResult) {
          uni.showToast({ title: '先点「估算」', icon: 'none' })
          return
        }
        base = this.dishResult
        name = this.dishResult.name + '（估算）'
        source = 'dish'
      } else {
        if (!this.manual.name || !this.manual.name.trim()) {
          uni.showToast({ title: '填一下名称', icon: 'none' })
          return
        }
        base = {
          calorie: this.manualCalorie,
          carb: Number(this.manual.carb) || 0,
          protein: Number(this.manual.protein) || 0,
          fat: Number(this.manual.fat) || 0,
        }
        name = this.manual.name.trim()
        source = 'manual'
      }
      const k = grams / 100
      addEntry(this.date, {
        meal: this.addMeal,
        name,
        amount: Math.round(grams),
        calorie: Math.round((Number(base.calorie) || 0) * k),
        carb: (Number(base.carb) || 0) * k,
        protein: (Number(base.protein) || 0) * k,
        fat: (Number(base.fat) || 0) * k,
        source,
      })
      this.closeAdd()
      this.reload()
      uni.showToast({ title: '已记录', icon: 'success' })
    },
    remove(e) {
      removeEntry(this.date, e.id)
      this.reload()
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

/* 日期条 */
.date-bar {
  display: flex;
  gap: 12rpx;
  padding: 20rpx 24rpx 0;
}
.date-item {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  border-radius: 16rpx;
  background: $bg-card;
  color: $text-secondary;
  font-size: 26rpx;
  border: 1rpx solid $border-subtle;
}
.date-item.active {
  color: #06180d;
  font-weight: 700;
  background: linear-gradient(135deg, #2bd45c, #17a348);
  border-color: transparent;
}

/* 热量总览 */
.hero {
  margin: 20rpx 24rpx 0;
  padding: 30rpx 26rpx 24rpx;
  border-radius: 24rpx;
  background: linear-gradient(160deg, rgba(43, 212, 92, 0.16), rgba(26, 26, 31, 1) 62%);
  border: 1rpx solid rgba(43, 212, 92, 0.28);
}
.hero-label {
  font-size: 24rpx;
  color: $brand-primary-light;
}
.hero-num-row {
  display: flex;
  align-items: baseline;
  gap: 10rpx;
  margin-top: 8rpx;
}
.hero-num {
  font-size: 76rpx;
  font-weight: 800;
  color: #f2f3f5;
  line-height: 1;
}
.hero-unit {
  font-size: 26rpx;
  color: $text-secondary;
}
.hero-row {
  display: flex;
  margin-top: 24rpx;
  padding-top: 20rpx;
  border-top: 1rpx solid $border-subtle;
}
.hero-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.cell-num {
  font-size: 34rpx;
  font-weight: 700;
  color: $text-main;
}
.cell-label {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-secondary;
}

/* 卡片 */
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
  align-items: center;
}
.card-head-right {
  display: flex;
  align-items: center;
  gap: 16rpx;
}
.card-title {
  font-size: 30rpx;
  font-weight: 700;
  color: $text-main;
}
.card-extra {
  font-size: 24rpx;
  color: $text-secondary;
}
.add-btn {
  font-size: 24rpx;
  color: #06180d;
  background: $brand-primary;
  padding: 8rpx 20rpx;
  border-radius: 999rpx;
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
.hint {
  display: block;
  margin-top: 14rpx;
  font-size: 22rpx;
  color: $text-muted;
  line-height: 1.5;
}

/* 饮水 */
.cups {
  display: flex;
  gap: 12rpx;
  margin-top: 18rpx;
}
.cup {
  width: 56rpx;
  height: 56rpx;
  border-radius: 12rpx;
  background: $bg-card-light;
  text-align: center;
  line-height: 56rpx;
  font-size: 26rpx;
  opacity: 0.45;
  border: 1rpx solid $border-subtle;
}
.cup.on {
  opacity: 1;
  border-color: rgba(43, 212, 92, 0.5);
}

/* 条目 */
.empty {
  margin-top: 16rpx;
  font-size: 24rpx;
  color: $text-muted;
}
.entry {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 0;
  border-bottom: 1rpx solid $border-subtle;
}
.entry-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.entry-name {
  font-size: 28rpx;
  color: $text-main;
}
.entry-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-secondary;
}
.entry-cal {
  font-size: 28rpx;
  font-weight: 700;
  color: #ffb347;
}
.entry-del {
  font-size: 24rpx;
  color: $text-muted;
}

/* 浮层 */
.mask {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 90;
  display: flex;
  align-items: flex-end;
}
.sheet {
  width: 100%;
  max-height: 78vh;
  padding: 24rpx 24rpx 40rpx;
  border-radius: 28rpx 28rpx 0 0;
  background: $bg-card;
  border-top: 1rpx solid $border-subtle;
}
.sheet-tabs {
  display: flex;
  gap: 12rpx;
}
.sheet-tab {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  border-radius: 14rpx;
  background: $bg-card-light;
  color: $text-secondary;
  font-size: 26rpx;
}
.sheet-tab.active {
  color: $brand-primary;
  border: 1rpx solid rgba(43, 212, 92, 0.5);
}
.inp {
  margin-top: 18rpx;
  height: 76rpx;
  padding: 0 20rpx;
  border-radius: 14rpx;
  background: $bg-card-light;
  color: $text-main;
  font-size: 28rpx;
  border: 1rpx solid $border-subtle;
}
.ph {
  color: $text-muted;
}
.half {
  flex: 1;
}
.result-list {
  margin-top: 14rpx;
  max-height: 380rpx;
}
.result {
  display: flex;
  padding: 18rpx 4rpx;
  border-bottom: 1rpx solid $border-subtle;
}
.result-main {
  display: flex;
  flex-direction: column;
}
.result-name {
  font-size: 28rpx;
  color: $text-main;
}
.result-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-secondary;
}
.macro-row {
  display: flex;
  gap: 12rpx;
}
.btn-mini {
  margin-top: 18rpx;
  text-align: center;
  padding: 20rpx 0;
  border-radius: 14rpx;
  font-size: 28rpx;
}
.btn-mini.primary {
  background: linear-gradient(135deg, #2bd45c, #17a348);
  color: #06180d;
  font-weight: 700;
}
.btn-mini.ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}
.dish-box {
  margin-top: 14rpx;
  padding: 18rpx;
  border-radius: 14rpx;
  background: $bg-card-light;
}
.dish-line {
  display: block;
  font-size: 26rpx;
  color: $text-main;
  line-height: 1.6;
}
.dish-line.sub {
  font-size: 22rpx;
  color: $text-secondary;
}
.amount-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-top: 18rpx;
}
.amount-label {
  width: 140rpx;
  font-size: 26rpx;
  color: $text-secondary;
}
.amount-inp {
  flex: 1;
  margin-top: 0;
  text-align: center;
}
.amount-unit {
  font-size: 24rpx;
  color: $text-muted;
}
.sheet-actions {
  display: flex;
  gap: 16rpx;
  margin-top: 8rpx;
}
.sheet-actions .btn-mini {
  flex: 1;
}
</style>
