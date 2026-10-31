/**
 * 营养数据与检索
 *
 * 数据来自两份离线表（随包内置，不联网）：
 *   data/foods.json      中国食物成分表 1643 条，格式 [名称, 热量, 碳水, 蛋白, 脂肪, 分类, 代码]
 *   data/exercises.json  运动 MET 库 759 条，格式 [名称, MET, 英文名]
 *   data/common-foods.js 29 条常用食物 + 61 条俗称对照（西红柿→番茄）
 *
 * 三件事：
 *   1. 把原始表加工成页面能直接用的数组（同名去重时按"像不像日常生鲜"打分）
 *   2. 关键词搜索（精确 > 前缀 > 包含 > 别名）
 *   3. 菜品估算：菜名拆原料 + 按做法补油（不需要菜品数据库）
 */
import FOODS_RAW from '@/data/foods.json'
import EXERCISES_RAW from '@/data/exercises.json'
import { COMMON_FOODS, ALIAS, simplify } from '@/data/common-foods.js'

export { COMMON_FOODS, ALIAS }

/** 外卖/家常菜里"不是日常生鲜状态"的词，命中要扣分 */
const BAD_WORDS = [
  '脱水', '干', '粉', '油', '酱', '罐头', '脯', '蜜饯', '腌', '腊', '熏', '烤', '炸', '糖',
]

const hasWord = (text, word) => String(text).indexOf(word) >= 0
const hasAny = (text, words) => words.some((w) => hasWord(text, w))

/**
 * 同名食物打分：决定去重时留哪一条
 *   代表值 +4 / 带"鲜" +2 / 带"青" +1 / 命中脱水·干·粉·油·酱… −6
 *
 * 为什么必须打分：`甜椒（脱水）` 324 千卡 vs `甜椒（灯笼椒）` 18 千卡，
 * 两者去掉括号都叫"甜椒"，选错会让一道菜的热量差十几倍。
 */
function nameScore(fullName) {
  let score = 0
  if (hasWord(fullName, '代表值')) score += 4
  if (hasWord(fullName, '鲜')) score += 2
  if (hasWord(fullName, '青')) score += 1
  if (hasAny(fullName, BAD_WORDS)) score -= 6
  return score
}

function buildFoodList() {
  const result = []
  const indexByName = new Map()
  for (const row of FOODS_RAW) {
    const full = String(row[0])
    const name = simplify(full)
    if (!name) continue
    const item = {
      name,
      full,
      calorie: Number(row[1]) || 0,
      carb: Number(row[2]) || 0,
      protein: Number(row[3]) || 0,
      fat: Number(row[4]) || 0,
      cat: row[5] || '其他',
      code: row[6] || '',
      score: nameScore(full),
    }
    const prev = indexByName.get(name)
    if (!prev) {
      indexByName.set(name, result.length)
      result.push(item)
    } else if (item.score > result[prev].score) {
      result[prev] = item
    }
  }
  return result
}

/** 食物库（已去重，约 1000 条） */
export const FOOD_DB = buildFoodList()

/** 名称索引：名字 → 食物对象，供别名快速定位 */
const FOOD_BY_NAME = new Map(FOOD_DB.map((f) => [f.name, f]))

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

const SEARCH_TERMS = (() => {
  const list = []
  for (const food of FOOD_DB) list.push({ term: food.name, food, kind: 'name' })
  for (const [alias, canonical] of Object.entries(ALIAS)) {
    const food = FOOD_BY_NAME.get(canonical)
    if (food) list.push({ term: alias, food, kind: 'alias' })
  }
  return list
})()

/**
 * 搜索食物
 * 打分：原名精确 100 / 原名前缀 80 / 别名精确 75 / 原名包含 60 / 别名包含 40
 * 同分时更短的名字靠前（"米饭" 比 "米饭（蒸，标准）" 更容易被选中）
 */
export function searchFoods(keyword, limit = 20) {
  const kw = String(keyword || '').trim()
  if (!kw) return []
  const scored = []
  for (const { term, food, kind } of SEARCH_TERMS) {
    let score = 0
    if (term === kw) score = kind === 'name' ? 100 : 75
    else if (term.startsWith(kw)) score = kind === 'name' ? 80 : 65
    else if (term.indexOf(kw) >= 0) score = kind === 'name' ? 60 : 40
    if (!score) continue
    scored.push({ food, score: score - Math.min(term.length, 20) * 0.2 })
  }
  scored.sort((a, b) => b.score - a.score || a.food.name.length - b.food.name.length)
  const seen = new Set()
  const out = []
  for (const s of scored) {
    if (seen.has(s.food.name)) continue
    seen.add(s.food.name)
    out.push(s.food)
    if (out.length >= limit) break
  }
  return out
}

// ---------------------------------------------------------------------------
// 菜品估算
// ---------------------------------------------------------------------------

/** 烹饪方式：长词必须写在前面，否则"凉拌"会先被"拌"匹配到 */
const COOK_METHODS = [
  ['凉拌', '拌'], ['清炒', '炒'], ['爆炒', '炒'], ['小炒', '炒'], ['干煸', '炒'], ['煸炒', '炒'],
  ['红烧', '烧'], ['干烧', '烧'], ['葱烧', '烧'], ['酱烧', '烧'],
  ['炖', '炖'], ['焖', '焖'], ['煲', '炖'], ['煨', '炖'], ['汆', '煮'], ['涮', '煮'],
  ['蒸', '蒸'], ['煎', '煎'], ['炸', '炸'], ['烤', '烤'], ['焗', '烤'],
  ['煮', '煮'], ['烩', '煮'], ['卤', '卤'], ['酱', '卤'], ['拌', '拌'], ['炒', '炒'],
  ['烧', '烧'], ['汤', '汤'],
]

/** 每 100g 菜大概用多少油（家常经验值，不是精确数据） */
const OIL_PER_100G = {
  炸: 12, 煎: 8, 炒: 6, 烧: 6, 卤: 3, 烤: 4, 拌: 3, 炖: 2, 焖: 2, 煮: 2, 蒸: 1, 汤: 1,
}

const OIL_KCAL_PER_G = 9

/** 判断菜名用了哪种做法 */
export function detectMethod(dishName) {
  const text = String(dishName || '')
  for (const [word, method] of COOK_METHODS) {
    if (hasWord(text, word)) return { word, method, oil: OIL_PER_100G[method] || 0 }
  }
  return { word: '', method: '', oil: 0 }
}

const INGREDIENT_TERMS = (() => {
  const list = []
  for (const food of FOOD_DB) if (food.name.length >= 2) list.push({ term: food.name, food })
  for (const [alias, canonical] of Object.entries(ALIAS)) {
    const food = FOOD_BY_NAME.get(canonical)
    if (food && alias.length >= 2) list.push({ term: alias, food })
  }
  // 长词优先，避免"鸡"抢走"鸡胸肉"
  list.sort((a, b) => b.term.length - a.term.length)
  return list
})()

/**
 * 从菜名里贪心拆原料
 * 例：'西红柿炒鸡蛋' → [番茄, 鸡蛋]
 * 命中更长的词后把该片段从字符串里抹掉，避免重复匹配。
 */
export function splitIngredients(dishName) {
  let rest = String(dishName || '')
  const found = []
  const used = new Set()
  for (const { term, food } of INGREDIENT_TERMS) {
    if (used.has(food.name)) continue
    const at = rest.indexOf(term)
    if (at < 0) continue
    found.push(food)
    used.add(food.name)
    rest = rest.slice(0, at) + '＿'.repeat(term.length) + rest.slice(at + term.length)
    if (found.length >= 3) break
  }
  return found
}

/**
 * 菜品估算：返回每 100g 的营养估计
 *
 * 思路（无菜品数据库）：
 *   1. 菜名拆成 1–3 样原料
 *   2. 两样按 6:4 的主次比例混合（前者为主料），三样按 5:3:2
 *   3. 按做法补油：每 100g 菜加 X 克油，油按 9 千卡/g、全部计入脂肪
 *
 * @returns {{ok:boolean, name:string, method:string, oil:number, parts:Array,
 *            calorie:number, carb:number, protein:number, fat:number, reason?:string}}
 */
export function estimateDish(dishName) {
  const name = String(dishName || '').trim()
  const empty = { ok: false, name, method: '', oil: 0, parts: [], calorie: 0, carb: 0, protein: 0, fat: 0 }
  if (!name) return { ...empty, reason: '请输入菜名' }

  const parts = splitIngredients(name)
  if (!parts.length) return { ...empty, reason: '没认出食材，换种写法或改用「自定义」' }

  const { method, oil } = detectMethod(name)
  const weights =
    parts.length === 1 ? [1] : parts.length === 2 ? [0.6, 0.4] : [0.5, 0.3, 0.2]

  let calorie = 0
  let carb = 0
  let protein = 0
  let fat = 0
  parts.forEach((food, i) => {
    const w = weights[i] || 0
    calorie += food.calorie * w
    carb += food.carb * w
    protein += food.protein * w
    fat += food.fat * w
  })

  calorie += oil * OIL_KCAL_PER_G
  fat += oil

  const r1 = (v) => Math.round(v * 10) / 10
  return {
    ok: true,
    name,
    method,
    oil,
    parts: parts.map((f, i) => ({ name: f.name, ratio: weights[i] || 0, calorie: f.calorie })),
    calorie: Math.round(calorie),
    carb: r1(carb),
    protein: r1(protein),
    fat: r1(fat),
  }
}

// ---------------------------------------------------------------------------
// 运动 MET 库
// ---------------------------------------------------------------------------

const STRETCH_WORDS = ['yoga', 'pilates', 'stretch', 'tai chi', 'qigong', 'meditat', 'hatha', 'breathing']
const STRENGTH_WORDS = [
  'resistance', 'weight lift', 'calisthenic', 'circuit training', 'weight training',
  'lifting', 'push up', 'pushup', 'push-up', 'squat', 'deadlift', 'arm curl',
  'bench press', 'pull up', 'pullup', 'pull-up',
]
const ANAEROBIC_WORDS = [
  'rope jump', 'rope skip', 'jumping', 'hiit', 'boxing', 'martial', 'sprint', 'tabata', 'obstacle', 'wrestl',
]

/** 按英文名归类：拉伸 → 力量 → 无氧 → 兜底有氧 */
export function classifyExercise(enName) {
  const text = String(enName || '').toLowerCase()
  if (hasAny(text, STRETCH_WORDS)) return '拉伸'
  if (hasAny(text, STRENGTH_WORDS)) return '力量'
  if (hasAny(text, ANAEROBIC_WORDS)) return '无氧'
  return '有氧'
}

export const EXERCISE_DB = EXERCISES_RAW.map((row) => ({
  name: String(row[0]),
  met: Number(row[1]) || 0,
  en: String(row[2] || ''),
  type: classifyExercise(row[2]),
})).filter((e) => e.name && e.met > 0)

/** 搜索运动（名称或英文名包含即命中；MET 高的排后面，避免一上来全是极限运动） */
export function searchExercises(keyword, limit = 20) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return []
  const hits = EXERCISE_DB.filter(
    (e) => e.name.toLowerCase().indexOf(kw) >= 0 || e.en.toLowerCase().indexOf(kw) >= 0
  )
  hits.sort((a, b) => a.name.length - b.name.length || a.met - b.met)
  return hits.slice(0, limit)
}

/** 运动页的快捷入口（点一下直接进"填时长算热量"） */
export const QUICK_EXERCISES = [
  { name: '跑步', met: 8.3 },
  { name: '骑行', met: 7.5 },
  { name: '游泳', met: 7.0 },
  { name: '跳绳', met: 12.3 },
  { name: '力量训练', met: 5.0 },
  { name: '篮球', met: 6.5 },
  { name: '羽毛球', met: 5.5 },
  { name: '瑜伽', met: 2.5 },
  { name: '爬楼梯', met: 8.8 },
  { name: '太极', met: 3.0 },
]
