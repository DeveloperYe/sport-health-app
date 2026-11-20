<template>
  <view class="page" :class="themeClass">
    <!-- 二级页没有原生导航栏了，自带返回头 -->
    <view class="page-back">
      <view class="back-btn" @click="goBack">
        <text class="back-ico">‹</text>
        <text class="back-txt">返回</text>
      </view>
      <text class="page-name">饮食记录</text>
      <view class="back-ph"></view>
    </view>
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

    <!-- 快捷操作：把选中日期的前一天整套复制过来（大多数人吃得差不多） -->
    <view class="quick-row">
      <text class="quick-btn" @click="copyPrevDay">复制{{ prevWord }}的记录</text>
      <text class="quick-info" v-if="summary.count">{{ summary.count }} 条 · 碳水 {{ summary.carb }}g · 蛋白 {{ summary.protein }}g</text>
    </view>

    <!-- 热量总览：主数字 = 离目标还差多少（与「目标」同一基准），缺口降为辅助行 -->
    <view class="hero">
      <view class="hero-head">
        <text class="hero-date">{{ headline }}</text>
        <text class="hero-goal" :class="{ muted: !goalSet }">{{ goalText }}</text>
      </view>

      <view class="hero-num-row">
        <text class="hero-num num">{{ heroNum }}</text>
        <text class="hero-unit">kcal</text>
        <text class="hero-tag" :class="heroTone">{{ heroLabel }}</text>
      </view>

      <view class="progress-track" v-if="goalSet">
        <view class="progress-fill" :class="heroTone" :style="{ width: goalPct + '%' }"></view>
      </view>
      <view class="progress-scale" v-if="goalSet">
        <text class="scale-l">{{ summary.intake }} 已摄入</text>
        <text class="scale-r num">{{ goalPctRaw }}%</text>
      </view>

      <!-- 蛋白质目标：设了就显示进度（以前设了全 App 看不到） -->
      <view class="macro" v-if="summary.proteinGoal">
        <view class="macro-head">
          <text class="macro-k">蛋白质</text>
          <text class="macro-v num">{{ summary.protein }} / {{ summary.proteinGoal }} g</text>
        </view>
        <view class="macro-track">
          <view class="macro-fill" :style="{ width: proteinPct + '%' }"></view>
        </view>
      </view>

      <!-- 辅助行：缺口是「相对总消耗」的另一口径，标签写清基准，不再和目标并排 -->
      <view class="hero-foot">
        <view class="foot-cell">
          <text class="foot-num num">{{ summary.intake }}</text>
          <text class="foot-label">摄入</text>
        </view>
        <view class="foot-cell">
          <text class="foot-num num">{{ summary.tdee }}</text>
          <text class="foot-label">总消耗</text>
        </view>
        <view class="foot-cell">
          <text class="foot-num num" :class="{ warn: summary.gap > 0 }">{{ gapAbs }}</text>
          <text class="foot-label">{{ gapWord }}</text>
        </view>
      </view>

      <text class="hint" v-if="!summary.count">{{ dayWord }}还没有记录饮食，点下面任一餐次的「+ 添加」开始。</text>
    </view>

    <!-- 消耗拆解 -->
    <view class="card">
      <text class="card-title">{{ dayWord }}怎么消耗的</text>
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
        <text class="card-extra">{{ summary.water }} / {{ summary.waterGoal }} 杯 · {{ waterMl }} / {{ waterGoalMl }} ml</text>
      </view>
      <view class="cups">
        <view
          v-for="i in (summary.waterGoal || 8)"
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
      <view class="entry" v-for="e in byMeal[m.key]" :key="e.id" @click="entryAction(e)">
        <view class="entry-main">
          <text class="entry-name">{{ e.name }}</text>
          <text class="entry-sub">
            {{ e.amount }}g · 碳 {{ e.carb }} / 蛋 {{ e.protein }} / 脂 {{ e.fat }}
          </text>
        </view>
        <text class="entry-cal num">{{ e.calorie }}</text>
        <text class="entry-del" @click.stop="remove(e)">删</text>
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
          <input class="inp amount-inp" type="digit" v-model="amount" placeholder="如 150" placeholder-class="ph" />
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
import { MEALS, MEAL_MAP, getDayEntries, addEntry, updateEntry, removeEntry, summarizeByMeal, copyDay, setWater as saveWater } from '@/utils/diet-store.js'
import { searchFoods, estimateDish, COMMON_FOODS } from '@/utils/nutrition.js'
import { macroToCalorie } from '@/utils/body-calc.js'
import { getWaterPrefs } from '@/utils/water-store.js'
import { dayCalories } from '@/utils/day-summary.js'
import { today, dateOffset } from '@/utils/body-store.js'

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 'YYYY-MM-DD' → 本地 Date（自己拆，别交给 Date 解析 '-' 分隔串，各端行为不一致） */
function parseDate(text) {
  const p = String(text || '').split('-')
  return new Date(Number(p[0]) || 1970, (Number(p[1]) || 1) - 1, Number(p[2]) || 1)
}

/** Date → 'YYYY-MM-DD' */
function toDateStr(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

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
    /** 杯子容量：与首页喝水卡共用同一份设置 */
    cupMl() {
      const p = getWaterPrefs()
      return Math.max(150, Math.min(500, Number(p.cupMl) || 250))
    },
    waterMl() {
      return Math.round((Number(this.summary && this.summary.water) || 0) * this.cupMl)
    },
    waterGoalMl() {
      return Math.round((Number(this.summary && this.summary.waterGoal) || 0) * this.cupMl)
    },
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
    /** 选中日期是「今天 / 昨天 / 前天」——所有"今天…"文案都走它，切日期时不再撒谎 */
    dayWord() {
      if (this.date === today()) return '今天'
      if (this.date === dateOffset(-1)) return '昨天'
      if (this.date === dateOffset(-2)) return '前天'
      return '这天'
    },
    /** 选中日期的前一天：复制记录只能从这里来（否则在「昨天」页点复制＝自己复制自己） */
    prevDate() {
      const d = parseDate(this.date)
      d.setDate(d.getDate() - 1)
      return toDateStr(d)
    },
    prevWord() {
      return this.date === dateOffset(-1) ? '前天' : '前一天'
    },
    headline() {
      const d = parseDate(this.date)
      const week = WEEK_NAMES[d.getDay()] || ''
      return `${this.dayWord} · ${d.getMonth() + 1}月${d.getDate()}日 ${week}`
    },
    goalSet() {
      return Number(this.summary.calorieGoal) > 0
    },
    goalText() {
      return this.goalSet ? `目标 ${this.summary.calorieGoal} kcal` : '未设热量目标'
    },
    /** 距目标还差多少（正=还能吃，负=已超出） */
    remainCalorie() {
      return (Number(this.summary.calorieGoal) || 0) - (Number(this.summary.intake) || 0)
    },
    /** 主数字：设了目标就是"还差多少"，没设目标就诚实显示已摄入 */
    heroNum() {
      return this.goalSet ? Math.abs(this.remainCalorie) : Number(this.summary.intake) || 0
    },
    heroLabel() {
      if (!this.goalSet) return '已摄入'
      return this.remainCalorie >= 0 ? '还差' : '已超出'
    },
    /** ok=还在目标内 / over=已超出 / plain=未设目标 */
    heroTone() {
      if (!this.goalSet) return 'plain'
      return this.remainCalorie >= 0 ? 'ok' : 'over'
    },
    goalPctRaw() {
      const goal = Number(this.summary.calorieGoal) || 0
      if (!(goal > 0)) return 0
      return Math.round(((Number(this.summary.intake) || 0) / goal) * 100)
    },
    goalPct() {
      return Math.min(100, Math.max(0, this.goalPctRaw))
    },
    proteinPct() {
      const goal = Number(this.summary.proteinGoal) || 0
      if (!(goal > 0)) return 0
      return Math.min(100, Math.max(0, Math.round(((Number(this.summary.protein) || 0) / goal) * 100)))
    },
    /** 缺口是「摄入 − 总消耗」，与热量目标不是同一基准，标签必须写出来 */
    gapWord() {
      const gap = Number(this.summary.gap) || 0
      if (gap > 0) return '盈余 · 对消耗'
      if (gap < 0) return '缺口 · 对消耗'
      return '收支平衡'
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

    goBack() {
      const pages = getCurrentPages ? getCurrentPages() : []
      if (pages.length > 1) uni.navigateBack()
      else uni.switchTab({ url: '/pages/health/health' })
    },
    reload() {
      this.summary = dayCalories(this.date)
      this.byMeal = summarizeByMeal(getDayEntries(this.date))
    },
    switchDate(d) {
      this.date = d
      this.reload()
    },
    // 把选中日期前一天的整份记录复制过来（吃得差不多时省一大截操作）
    // 注意来源按当前选中日期算，不是写死"昨天"——否则在「昨天」页点它会自己复制自己
    copyPrevDay() {
      const n = copyDay(this.prevDate, this.date)
      if (!n) {
        uni.showToast({ title: `${this.prevWord}没有记录可复制`, icon: 'none' })
        return
      }
      this.reload()
      uni.showToast({ title: `已从${this.prevWord}复制 ${n} 条`, icon: 'success' })
    },
    // 点条目：改份量 / 换餐次 / 删除
    entryAction(e) {
      uni.showActionSheet({
        itemList: ['改份量', '换个餐次', '删除'],
        success: (res) => {
          if (res.tapIndex === 0) this.editAmount(e)
          else if (res.tapIndex === 1) this.moveMeal(e)
          else this.remove(e)
        },
      })
    },
    // 改份量：按新旧克数等比例缩放热量与三大营养素（记录里存的是"这份的总值"）
    editAmount(e) {
      const old = Number(e.amount) || 0
      uni.showModal({
        title: `改份量（当前 ${old}g）`,
        editable: true,
        placeholderText: '输入新的克数',
        content: String(old),
        success: (m) => {
          if (!m.confirm) return
          const grams = Number(m.content)
          if (!(grams > 0)) {
            uni.showToast({ title: '克数不对', icon: 'none' })
            return
          }
          const k = old > 0 ? grams / old : 0
          const r1 = (v) => Math.round((Number(v) || 0) * k * 10) / 10
          updateEntry(this.date, e.id, {
            amount: Math.round(grams),
            calorie: Math.round((Number(e.calorie) || 0) * k),
            carb: r1(e.carb),
            protein: r1(e.protein),
            fat: r1(e.fat),
          })
          this.reload()
        },
      })
    },
    // 换餐次：记错了餐次时不用删了重加
    moveMeal(e) {
      uni.showActionSheet({
        itemList: MEALS.map((m) => m.label),
        success: (res) => {
          const target = MEALS[res.tapIndex]
          if (!target || target.key === e.meal) return
          updateEntry(this.date, e.id, { meal: target.key })
          this.reload()
        },
      })
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
  padding-top: calc(var(--status-bar-height) + 16rpx);
  padding-bottom: 60rpx; // 非 tab 页，只需常规留白
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
  color: var(--on-accent);
  font-weight: 700;
  background: var(--accent);
  border-color: transparent;
}

/* 快捷操作行 */
.quick-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16rpx 28rpx 0;
}
.quick-btn {
  font-size: 24rpx;
  color: var(--accent-text);
  border: 1rpx solid var(--accent-soft-2);
  padding: 8rpx 20rpx;
  border-radius: 999rpx;
}
.quick-info {
  font-size: 20rpx;
  color: $text-muted;
}

/* 热量总览 */
.hero {
  margin: 20rpx 24rpx 0;
  padding: $card-pad;
  border-radius: $card-radius;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}
.hero-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16rpx;
}
.hero-date {
  font-size: 24rpx;
  color: $text-secondary;
}
.hero-goal {
  font-size: 22rpx;
  color: var(--accent-text);
  white-space: nowrap;
}
.hero-goal.muted {
  color: $text-muted;
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
  color: var(--text-1);
  line-height: 1;
}
.hero-unit {
  font-size: 26rpx;
  color: $text-secondary;
}
/* 状态标签：绿=还在目标内，暖橙=已超出，灰=未设目标 */
.hero-tag {
  font-size: 22rpx;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  border: 1rpx solid $border-subtle;
  color: $text-secondary;
}
.hero-tag.ok {
  color: var(--accent-text);
  border-color: var(--accent-soft-2);
}
.hero-tag.over {
  color: var(--warm-text);
  border-color: var(--warm-graphic);
}
.hero-tag.plain {
  color: $text-muted;
}
/* 目标进度条 */
.progress-track {
  height: 14rpx;
  margin-top: 18rpx;
  border-radius: 999rpx;
  background: $bg-card-light;
  border: 1rpx solid $border-subtle;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 999rpx;
  background: var(--accent);
  transition: width 0.24s var(--ease);
}
.progress-fill.over {
  background: var(--warm-graphic);
}
.progress-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 8rpx;
}
.scale-l,
.scale-r {
  font-size: 20rpx;
  color: $text-muted;
}
/* 蛋白质进度：冷色，与热量绿区分 */
.macro {
  margin-top: 20rpx;
}
.macro-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.macro-k {
  font-size: 24rpx;
  color: $text-secondary;
}
.macro-v {
  font-size: 24rpx;
  color: $text-main;
}
.macro-track {
  height: 10rpx;
  margin-top: 10rpx;
  border-radius: 999rpx;
  background: $bg-card-light;
  border: 1rpx solid $border-subtle;
  overflow: hidden;
}
.macro-fill {
  height: 100%;
  border-radius: 999rpx;
  background: var(--cool-graphic);
  transition: width 0.24s var(--ease);
}
/* 辅助行：摄入 / 总消耗 / 缺口 */
.hero-foot {
  display: flex;
  margin-top: 20rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid $border-subtle;
}
.foot-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.foot-num {
  font-size: 30rpx;
  font-weight: 700;
  color: $text-main;
}
.foot-num.warn {
  color: var(--warm-text);
}
.foot-label {
  margin-top: 6rpx;
  font-size: 20rpx;
  color: $text-muted;
}

/* 卡片 */
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
  align-items: center;
}
.card-head-right {
  display: flex;
  align-items: center;
  gap: 16rpx;
}
.card-title {
  font-size: $card-title-font;
  font-weight: 700;
  color: $text-main;
}
.card-extra {
  font-size: 24rpx;
  color: $text-secondary;
}
.add-btn {
  font-size: 24rpx;
  color: var(--on-accent);
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
  flex-wrap: wrap;
  gap: 12rpx;
  margin-top: 18rpx;
}
.cup {
  flex: 0 0 calc((100% - 72rpx) / 7);
  height: 60rpx;
  border-radius: 12rpx;
  background: $bg-card-light;
  text-align: center;
  line-height: 64rpx;
  font-size: 28rpx;
  opacity: 0.4;
  border: 1rpx solid $border-subtle;
}
.cup.on {
  opacity: 1;
  border-color: var(--cool-graphic);
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
  color: var(--warm-text);
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
  background: var(--mask);
  z-index: var(--z-sheet); /* 令牌见 styles/theme.scss：999，须盖过 tabBar 的 998 */
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
  color: var(--accent-text);
  border: 1rpx solid var(--accent-soft-2);
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
  background: var(--accent);
  color: var(--on-accent);
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

/* flat-press:2026-11-06 */
.add-btn:active,
.btn-mini:active,
.quick-btn:active {
  transform: scale(0.97);
  opacity: 0.9;
}

/* 自带返回头（2026-11-06 去掉原生导航栏后补上） */
.page-back {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8rpx 24rpx 4rpx;
}
.back-btn {
  display: flex;
  align-items: center;
  gap: 4rpx;
  height: 64rpx;
  padding: 0 20rpx 0 14rpx;
  border-radius: 999rpx;
  background: var(--bg-card);
  border: 1rpx solid var(--line);
  transition: transform 0.12s var(--ease), background-color 0.18s var(--ease);
}
.back-btn:active {
  transform: scale(0.96);
}
.back-ico {
  font-size: 40rpx;
  line-height: 1;
  color: var(--text-1);
  margin-top: -4rpx;
}
.back-txt {
  font-size: 24rpx;
  color: var(--text-2);
}
.page-name {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--text-1);
}
/* 占位让标题真正居中 */
.back-ph {
  width: 128rpx;
}

/* back-method:2026-11-06 */
</style>
