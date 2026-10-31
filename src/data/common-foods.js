/**
 * 常用食物 + 俗称映射
 *
 * 这个文件只有两张表：
 *   1. 29 条常用食物的营养数据
 *   2. 俗称到标准名的对照（西红柿 → 番茄）
 * 外加一个把名字洗干净的函数 simplify。
 */

/** 常用食物：每 100 克的营养数据 */
export var COMMON_FOODS = [
  { name: '白米饭', unit: '100g', carb: 25.9, protein: 2.6, fat: 0.3, calorie: 116 },
  { name: '糙米饭', unit: '100g', carb: 23.0, protein: 2.6, fat: 0.9, calorie: 111 },
  { name: '馒头', unit: '100g', carb: 47.0, protein: 7.0, fat: 1.1, calorie: 223 },
  { name: '面条', unit: '100g', carb: 65.6, protein: 8.9, fat: 0.6, calorie: 301 },
  { name: '全麦面包', unit: '100g', carb: 41.0, protein: 13.0, fat: 3.4, calorie: 250 },
  { name: '燕麦片', unit: '100g', carb: 66.0, protein: 15.0, fat: 6.7, calorie: 389 },
  { name: '红薯', unit: '100g', carb: 20.1, protein: 1.6, fat: 0.2, calorie: 86 },
  { name: '玉米', unit: '100g', carb: 22.8, protein: 4.0, fat: 1.2, calorie: 112 },
  { name: '鸡胸肉', unit: '100g', carb: 0, protein: 24.6, fat: 1.2, calorie: 118 },
  { name: '鸡腿肉', unit: '100g', carb: 0, protein: 16.0, fat: 13.0, calorie: 181 },
  { name: '鸡蛋', unit: '100g', carb: 1.5, protein: 13.3, fat: 8.8, calorie: 144 },
  { name: '鸡蛋清', unit: '100g', carb: 3.1, protein: 11.6, fat: 0.2, calorie: 48 },
  { name: '瘦牛肉', unit: '100g', carb: 0, protein: 20.2, fat: 2.3, calorie: 106 },
  { name: '瘦猪肉', unit: '100g', carb: 0, protein: 20.3, fat: 6.2, calorie: 143 },
  { name: '三文鱼', unit: '100g', carb: 0, protein: 20.0, fat: 13.0, calorie: 208 },
  { name: '豆腐', unit: '100g', carb: 1.9, protein: 8.1, fat: 3.7, calorie: 81 },
  { name: '牛奶', unit: '100ml', carb: 4.8, protein: 3.0, fat: 3.2, calorie: 54 },
  { name: '纯牛奶', unit: '100ml', carb: 4.9, protein: 3.3, fat: 3.6, calorie: 65 },
  { name: '酸奶', unit: '100g', carb: 3.6, protein: 9.0, fat: 0.4, calorie: 59 },
  { name: '西兰花', unit: '100g', carb: 4.3, protein: 4.1, fat: 0.6, calorie: 36 },
  { name: '菠菜', unit: '100g', carb: 2.8, protein: 2.9, fat: 0.4, calorie: 28 },
  { name: '番茄', unit: '100g', carb: 4.0, protein: 0.9, fat: 0.2, calorie: 18 },
  { name: '香蕉', unit: '100g', carb: 22.0, protein: 1.4, fat: 0.2, calorie: 93 },
  { name: '苹果', unit: '100g', carb: 13.5, protein: 0.2, fat: 0.2, calorie: 53 },
  { name: '杏仁', unit: '100g', carb: 21.6, protein: 21.2, fat: 49.9, calorie: 578 },
  { name: '花生酱', unit: '100g', carb: 20.0, protein: 25.0, fat: 50.0, calorie: 588 },
  { name: '蛋白棒', unit: '100g', carb: 45.0, protein: 25.0, fat: 10.0, calorie: 360 },
  { name: '黑咖啡', unit: '100ml', carb: 0, protein: 0.2, fat: 0, calorie: 1 },
  { name: '可乐', unit: '100ml', carb: 10.6, protein: 0, fat: 0, calorie: 42 }
];

// 给每条加一个标记，表示"这是常用食物"
for (var i = 0; i < COMMON_FOODS.length; i++) {
  COMMON_FOODS[i].common = true;
}

/**
 * 俗称对照表
 * 左边是用户可能输入的说法，右边是库里真实的名称
 */
export var ALIAS = {
  '白米饭': '米饭',
  '大米饭': '米饭',
  '蒸饭': '米饭',
  '白饭': '米饭',
  '糙米': '糙米饭',
  '杂粮饭': '糙米饭',
  '鸡胸': '鸡胸脯肉',
  '鸡胸肉': '鸡胸脯肉',
  '鸡脯肉': '鸡胸脯肉',
  '鸡腿肉': '鸡腿',
  '鸡翅': '鸡翅',
  '瘦肉': '猪肉',
  '里脊': '猪里脊',
  '五花肉': '猪肉',
  '排骨': '猪大排',
  '牛排': '牛肉',
  '西红柿': '番茄',
  '洋柿子': '番茄',
  '土豆': '马铃薯',
  '洋芋': '马铃薯',
  '地瓜': '红薯',
  '番薯': '红薯',
  '山芋': '红薯',
  '花生米': '花生仁',
  '生花生': '花生仁',
  '老酸奶': '酸牛奶',
  '酸牛奶': '酸牛奶',
  '稀饭': '粥',
  '白粥': '粥',
  '米粥': '粥',
  '苞米': '玉米',
  '玉米棒': '玉米',
  '甜玉米': '玉米',
  '青椒': '甜椒',
  '柿子椒': '甜椒',
  '尖椒': '辣椒',
  '香菜': '芫荽',
  '香芹': '芹菜茎',
  '芹菜': '芹菜茎',
  '西芹': '芹菜茎',
  '猕猴桃': '中华猕猴桃',
  '奇异果': '中华猕猴桃',
  '提子': '葡萄',
  '花菜': '菜花',
  '西蓝花': '西兰花',
  '蛋清': '鸡蛋清',
  '鸡蛋白': '鸡蛋清',
  '豆奶': '豆浆',
  '嫩豆腐': '豆腐',
  '老豆腐': '豆腐',
  '基围虾': '虾',
  '明虾': '虾',
  '大虾': '虾',
  '虾仁': '虾',
  '麦片': '燕麦片',
  '燕麦': '燕麦片',
  '汽水': '可乐',
  '肥宅快乐水': '可乐',
  '咖啡': '黑咖啡',
  '美式': '黑咖啡',
  '巴旦木': '杏仁',
  '扁桃仁': '杏仁',
  '坚果': '杏仁',
  '白菜': '大白菜',
  '粉条': '粉丝',
  '木耳': '黑木耳',
  '青蒜': '蒜苗',
  '豆角': '菜豆',
  '四季豆': '菜豆'
};

/**
 * 把名字洗干净：去掉括号备注、去掉空格
 * 例："米饭（蒸，代表值）" → "米饭"
 *
 * 做法：一个字一个字地看
 *   遇到左括号，就一直跳到右括号为止（括号里的内容全部不要）
 *   遇到空格，跳过
 *   其它字，留下来
 */
export function simplify(name) {
  var text = ''
  if (name !== null && name !== undefined) {
    text = String(name)
  }

  var result = ''
  var i = 0

  while (i < text.length) {
    var ch = text.charAt(i)

    // 遇到左括号（全角或半角），把里面的内容整段跳过
    if (ch === '（' || ch === '(' || ch === '［' || ch === '[') {
      i = i + 1
      while (i < text.length) {
        var inner = text.charAt(i)
        i = i + 1
        if (inner === '）' || inner === ')' || inner === '］' || inner === ']') {
          break
        }
      }
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      // 空格换行都跳过
      i = i + 1
    } else {
      // 普通文字，留下
      result = result + ch
      i = i + 1
    }
  }

  return result
}
