/**
 * 注册 / 登录的逻辑层（阶段 1：纯本机，无云端）
 *
 * 为什么单独成文件：
 *   1. 出题、判定、密码合规、hash 全是纯逻辑，必须能进 `node --test`；
 *   2. 不能依赖 `crypto.subtle`（App 端页面走 file:// 不是 secure context，理由同 sha256.js），
 *      也不能依赖 `uni`（node 里没有）—— 所以存储层通过**可注入 store** 与平台解耦：
 *      纯函数一节完全不碰 uni，存储一节只在调用方不传 store 时才回落到 uni 存储。
 *
 * 已经拍板的口径（2026-11-20）：
 *   - 手机号：`^1[3-9]\d{9}$`。**不接短信验证 ⇒ 手机号只是用户名**，
 *     界面与文档一律不得声称"已验证手机号归属"。
 *   - 密码：8–32 位，四类字符（小写 / 大写 / 数字 / ASCII 可见符号）**任取两类**。
 *     特殊符号只认 ASCII 可见符号，空格、全角符号、emoji 都不算。
 *     口径可配置（`minClasses` 等），将来改规则不用动界面。
 *   - 人机验证：**离线本地出题 + 本地判定**，默认算术挑战；连错时换题型、降难度，
 *     不设冷却（离线场景锁时间只会流失真实用户）。
 *     阶段 2 接后端后，出题与校验搬到服务端（challengeId + 2 分钟过期 + 一次性消费），
 *     本文件的出题部分届时只当"体验层"，防刷靠服务端。
 *   - 账号表上限 5 个 —— 阶段 1 的廉价减速带，不是安全边界。
 *   - 密码只存 `{ salt, hash }`，**任何地方都不落明文**。
 */
import { sha256Hex } from './sha256.js'

// ===========================================================================
// 一、纯函数（无副作用、无平台依赖）—— 单测覆盖
// ===========================================================================

/** 密码策略默认值：改口径只改这里（或调用时传 policy） */
export const DEFAULT_POLICY = {
  minLength: 8,
  maxLength: 32,
  /** 四类字符里至少要有几类 */
  minClasses: 2,
  /** 不允许和手机号后 N 位相同（0 = 关掉这条） */
  phoneTail: 6,
}

/** 字符类别：key 供界面渲染合规清单 */
const CLASS_RULES = [
  { key: 'lower', re: /[a-z]/ },
  { key: 'upper', re: /[A-Z]/ },
  { key: 'digit', re: /[0-9]/ },
  // ASCII 可见符号：! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
  // 不含空格（0x20）、全角符号与 emoji
  { key: 'symbol', re: /[!-\/:-@\[-\x60{-~]/ },
]

/** UTF-8 编码（自己写，避免依赖 TextEncoder —— 老安卓 WebView 不保证有） */
function utf8(str) {
  const s = String(str == null ? '' : str)
  const out = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        )
      } else {
        // 孤立代理项：按 U+FFFD 处理，别产出非法字节序
        out.push(0xef, 0xbf, 0xbd)
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return new Uint8Array(out)
}

/** 字符串 → sha256 hex（给 hash/salt 用，内部走纯 JS 实现） */
export function sha256Text(text) {
  return sha256Hex(utf8(text))
}

// ---- 手机号 ----------------------------------------------------------------

/** 只留数字：`138-0013 8000` → `13800138000` */
export function normalizePhone(value) {
  return String(value == null ? '' : value).replace(/\D/g, '').slice(0, 11)
}

/** 中国大陆手机号：1 开头、第二位 3–9、共 11 位 */
export function isValidPhone(value) {
  return /^1[3-9]\d{9}$/.test(normalizePhone(value))
}

/** 手机号尾号（用于"密码别用手机号里的数字"这条规则） */
export function phoneTail(phone, digits) {
  const p = normalizePhone(phone)
  const n = Math.max(0, Math.floor(Number(digits) || 0))
  if (!n || p.length < n) return ''
  return p.slice(-n)
}

/** 打码显示：13800138000 → 138****8000 */
export function maskPhone(value) {
  const p = normalizePhone(value)
  if (p.length !== 11) return p ? p.slice(0, 3) + '****' : ''
  return p.slice(0, 3) + '****' + p.slice(-4)
}

// ---- 密码 ------------------------------------------------------------------

/** 密码命中了哪几类字符，返回 key 数组（'lower' / 'upper' / 'digit' / 'symbol'） */
export function classesOf(password) {
  const text = String(password == null ? '' : password)
  const hit = []
  for (const rule of CLASS_RULES) {
    if (rule.re.test(text)) hit.push(rule.key)
  }
  return hit
}

/**
 * 是不是"太简单"：全部同一个字符（aaaaaaaa）或全部连号（12345678 / 87654321）。
 * 只认相邻字符码严格 +1 或 -1，不做键盘序列（qwerty）判断。
 */
export function isTooSimple(password) {
  const text = String(password == null ? '' : password)
  if (text.length < 2) return false
  let same = true
  let up = true
  let down = true
  for (let i = 1; i < text.length; i++) {
    const diff = text.charCodeAt(i) - text.charCodeAt(i - 1)
    if (diff !== 0) same = false
    if (diff !== 1) up = false
    if (diff !== -1) down = false
  }
  return same || up || down
}

/**
 * 密码合规检查
 * @returns {{ok:boolean, missing:string[], length:number, classes:number, classKeys:string[]}}
 *   missing 取值：'empty' | 'tooShort' | 'tooLong' | 'classes' | 'tooSimple' | 'containsPhone'
 *   界面按 missing 逐条渲染 ✓/○ 与错误文案，不要自己再判一遍。
 */
export function checkPassword(password, phone, policy) {
  const p = Object.assign({}, DEFAULT_POLICY, policy || {})
  const text = String(password == null ? '' : password)
  const classKeys = classesOf(text)
  const missing = []
  if (!text) {
    missing.push('empty')
  } else {
    if (text.length < p.minLength) missing.push('tooShort')
    if (text.length > p.maxLength) missing.push('tooLong')
    if (classKeys.length < p.minClasses) missing.push('classes')
    if (isTooSimple(text)) missing.push('tooSimple')
    const tail = phoneTail(phone, p.phoneTail)
    if (tail && text.indexOf(tail) >= 0) missing.push('containsPhone')
  }
  return {
    ok: missing.length === 0,
    missing,
    length: text.length,
    classes: classKeys.length,
    classKeys,
  }
}

/** 每个账号唯一的 salt（十六进制）；多源混合熵，再夹一层 sha256 */
let saltCounter = 0
export function makeSalt(bytes, opt) {
  const o = opt || {}
  const rand = typeof o.rand === 'function' ? o.rand : Math.random
  const now = Number(o.now) || Date.now()
  const size = Math.max(8, Math.min(32, Math.floor(Number(bytes) || 16)))
  saltCounter = (saltCounter + 1) % 0xffff
  const pool = [now, saltCounter, now * 2654435761, Math.floor(rand() * 0xffffffff)]
  for (let i = 0; i < 8; i++) {
    pool.push(Math.floor(rand() * 0xffffffff) >>> 0)
  }
  return sha256Text(pool.join(':')).slice(0, size * 2)
}

/** 迭代 sha256 次数：手机上 ~几毫秒，主要作用是别让 salt/hash 一眼可比 */
export const DEFAULT_ROUNDS = 600

/** 口令 hash：hash = H^n(salt \0 password)，只存这个，绝不存明文 */
export function hashPassword(password, salt, opt) {
  const o = opt || {}
  const rounds = Math.max(1, Math.floor(Number(o.rounds) || DEFAULT_ROUNDS))
  const s = String(salt == null ? '' : salt)
  let hex = sha256Text(s + '\u0000' + String(password == null ? '' : password))
  for (let i = 1; i < rounds; i++) {
    hex = sha256Text(hex + s + i)
  }
  return hex
}

/** 校验口令（登录用） */
export function verifyPassword(password, salt, hash, opt) {
  const expect = String(hash == null ? '' : hash)
  if (!expect) return false
  return hashPassword(password, salt, opt) === expect
}

// ---- 人机验证（离线挑战） --------------------------------------------------

/** 题目有效期：与服务端阶段的 2 分钟对齐，界面文案才能一致 */
export const CHALLENGE_TTL_MS = 120000
/** 同一个题最多试几次 */
export const CHALLENGE_MAX_ATTEMPTS = 3

const randInt = (rand, min, max) => {
  const span = max - min + 1
  return min + Math.floor(rand() * span)
}

/**
 * 连错次数 → 题目难度层级
 *   0–1 次：level 1，两位数 + 一位数加法（常规）
 *   2 次 ：level 2，换题型 —— 数字点选
 *   3 次+：level 3，降难度 —— 一位数相加且和 < 10
 */
export function levelForAttempts(attempts) {
  const n = Math.max(0, Math.floor(Number(attempts) || 0))
  if (n <= 1) return 1
  if (n === 2) return 2
  return 3
}

/**
 * 出题（纯本地、可注入随机源，便于单测）
 * @returns {{id, kind:'arith'|'pick', level, question, answer, options?, createdAt, ttlMs, maxAttempts}}
 *   kind='arith' 时 answer 是数字；kind='pick' 时 answer 是**选项下标**
 */
export function makeChallenge(opt) {
  const o = opt || {}
  const rand = typeof o.rand === 'function' ? o.rand : Math.random
  const now = Number(o.now) || Date.now()
  const level = Math.min(3, Math.max(1, Math.floor(Number(o.level) || 1)))
  const id = o.id || 'c' + now.toString(36) + randInt(rand, 0, 0xffffff).toString(36)
  const base = {
    id,
    level,
    createdAt: now,
    ttlMs: Number(o.ttlMs) > 0 ? Number(o.ttlMs) : CHALLENGE_TTL_MS,
    maxAttempts: Number(o.maxAttempts) > 0 ? Number(o.maxAttempts) : CHALLENGE_MAX_ATTEMPTS,
  }

  if (level === 2) {
    // 三个互不相同的数，保证"最大的"唯一，不会出现并列导致答案有歧义。
    // 抽签有次数上限：随机源退化成常量（或被注入成常量做单测）时不能死循环，
    // 抽不满就按 1、2、3… 补位，结果依然互不相同。
    const options = []
    let guard = 0
    while (options.length < 3 && guard < 40) {
      const n = randInt(rand, 1, 9)
      if (options.indexOf(n) < 0) options.push(n)
      guard++
    }
    for (let filler = 1; options.length < 3; filler++) {
      if (options.indexOf(filler) < 0) options.push(filler)
    }
    const max = Math.max(options[0], options[1], options[2])
    return Object.assign(base, {
      kind: 'pick',
      question: '选出最大的那个数',
      options,
      answer: options.indexOf(max),
    })
  }

  if (level === 3) {
    const a = randInt(rand, 1, 5)
    const b = randInt(rand, 1, 9 - a) // 和 ≤ 9，口算即可
    return Object.assign(base, { kind: 'arith', question: a + ' + ' + b + ' = ？', answer: a + b })
  }

  const a = randInt(rand, 11, 49)
  const b = randInt(rand, 3, 9)
  return Object.assign(base, { kind: 'arith', question: a + ' + ' + b + ' = ？', answer: a + b })
}

/**
 * 判题（纯函数：不修改 challenge，状态由调用方持有）
 * @param {object} challenge makeChallenge 的返回值
 * @param {string|number} input 用户答案
 * @param {{now?:number, attempts?:number}} opt
 * @returns {{ok:boolean, reason:''|'invalid'|'locked'|'expired'|'wrong'}}
 *   界面按 reason 分支文案：locked → 换题降级，expired → 提示超时换题，wrong → 渐进式提示
 */
export function checkChallenge(challenge, input, opt) {
  const o = opt || {}
  const now = Number(o.now) || Date.now()
  const attempts = Math.max(0, Math.floor(Number(o.attempts) || 0))
  const c = challenge
  if (!c || typeof c !== 'object' || c.answer === undefined || !c.createdAt) {
    return { ok: false, reason: 'invalid' }
  }
  const maxAttempts = Number(c.maxAttempts) || CHALLENGE_MAX_ATTEMPTS
  if (attempts >= maxAttempts) return { ok: false, reason: 'locked' }
  const ttl = Number(c.ttlMs) || CHALLENGE_TTL_MS
  if (now - Number(c.createdAt) > ttl) return { ok: false, reason: 'expired' }
  const got = String(input == null ? '' : input).trim()
  if (got !== String(c.answer)) return { ok: false, reason: 'wrong' }
  return { ok: true, reason: '' }
}

// ===========================================================================
// 二、本机账号表 + 会话（阶段 1；阶段 2 接后端后整体换成服务端调用）
//
// 存储通过 store 注入：{ get(key), set(key, value), remove(key) }。
// 不传时回落到 uni 同步存储 —— 注意 uniStore() 只是**惰性**引用 uni，
// 因此本模块可以被 node 直接 import 做单测（只要测的是上面那一节或传了假 store）。
// ===========================================================================

const KEY_ACCOUNTS = 'fh_accounts'
const KEY_SESSION = 'fh_session'

/** 阶段 1 的减速带：一台设备最多注册几个账号 */
export const MAX_ACCOUNTS = 5

/** uni 同步存储适配器（惰性，不在模块加载期碰 uni） */
export function uniStore() {
  return {
    get(key) {
      try {
        return uni.getStorageSync(key)
      } catch (e) {
        return null
      }
    },
    set(key, value) {
      try {
        uni.setStorageSync(key, value)
        return true
      } catch (e) {
        return false
      }
    },
    remove(key) {
      try {
        uni.removeStorageSync(key)
        return true
      } catch (e) {
        return false
      }
    },
  }
}

/** 给界面看的账号（**不含 salt/hash/deviceUserId**） */
function publicAccount(account) {
  return {
    phone: account.phone,
    maskedPhone: maskPhone(account.phone),
    createdAt: Number(account.createdAt) || 0,
  }
}

/** 账号列表（内部结构含 salt/hash，界面不要直接用） */
export function listAccounts(store) {
  const s = store || uniStore()
  const raw = s.get(KEY_ACCOUNTS)
  if (!Array.isArray(raw)) return []
  return raw.filter((x) => x && x.phone && x.hash && x.salt)
}

export function findAccount(phone, store) {
  const p = normalizePhone(phone)
  if (!p) return null
  const hit = listAccounts(store).filter((a) => a.phone === p)
  return hit.length ? hit[0] : null
}

/**
 * 注册一个本机账号
 * @returns {{ok:true, account:object} | {ok:false, reason:string, missing?:string[]}}
 *   reason: 'bad_phone' | 'bad_password' | 'phone_taken' | 'too_many' | 'storage'
 */
export function createAccount(input, store, opt) {
  const s = store || uniStore()
  const i = input || {}
  const o = opt || {}
  const phone = normalizePhone(i.phone)
  if (!isValidPhone(phone)) return { ok: false, reason: 'bad_phone' }

  const pwd = checkPassword(i.password, phone, o.policy)
  if (!pwd.ok) return { ok: false, reason: 'bad_password', missing: pwd.missing }

  const accounts = listAccounts(s)
  if (accounts.length >= MAX_ACCOUNTS) return { ok: false, reason: 'too_many' }
  if (findAccount(phone, s)) return { ok: false, reason: 'phone_taken' }

  const now = Number(o.now) || Date.now()
  const salt = makeSalt(16, { rand: o.rand, now })
  const account = {
    phone,
    salt,
    hash: hashPassword(i.password, salt, { rounds: o.rounds }),
    createdAt: now,
    // 记下注册时的匿名设备 id：将来接后端时用它认领这台机器的本地数据
    deviceUserId: String(i.deviceUserId || ''),
  }
  if (!s.set(KEY_ACCOUNTS, accounts.concat([account]))) {
    return { ok: false, reason: 'storage' }
  }
  return { ok: true, account: publicAccount(account) }
}

/**
 * 登录（本机校验 hash）
 * @returns {{ok:true, account:object} | {ok:false, reason:'bad_phone'|'not_found'|'bad_password'}}
 */
export function loginAccount(phone, password, store, opt) {
  const s = store || uniStore()
  const o = opt || {}
  const p = normalizePhone(phone)
  if (!isValidPhone(p)) return { ok: false, reason: 'bad_phone' }
  const account = findAccount(p, s)
  if (!account) return { ok: false, reason: 'not_found' }
  if (!verifyPassword(password, account.salt, account.hash, { rounds: o.rounds })) {
    return { ok: false, reason: 'bad_password' }
  }
  return { ok: true, account: publicAccount(account) }
}

// ---- 会话 ------------------------------------------------------------------

/** 当前会话（没有就返回 null）；会话里同样不含密码 */
export function getSession(store) {
  const s = store || uniStore()
  const v = s.get(KEY_SESSION)
  if (!v || !v.phone) return null
  return { phone: v.phone, maskedPhone: maskPhone(v.phone), since: Number(v.since) || 0 }
}

export function openSession(account, store, opt) {
  const s = store || uniStore()
  const o = opt || {}
  if (!account || !account.phone) return null
  const session = {
    phone: account.phone,
    maskedPhone: maskPhone(account.phone),
    since: Number(o.now) || Date.now(),
  }
  s.set(KEY_SESSION, session)
  return session
}

export function closeSession(store) {
  const s = store || uniStore()
  s.remove(KEY_SESSION)
  return true
}

/** 这台设备上注册了几个账号（"我的"页账号卡与注册页都用它） */
export function accountCount(store) {
  return listAccounts(store).length
}

// ===========================================================================
// 三、"我的"页账号入口卡的状态判定（纯函数：不读存储，存储内容由调用方传入）
// ===========================================================================

/** 阶段 1 的云同步文案：后端没接之前，任何状态都只能这么写 */
export const SYNC_NOTE = '云同步 · 服务端开通后可用'

/**
 * 账号入口卡状态
 *
 * 三种身份态：
 *   anonymous  本机还没账号 —— 「随机账号 · 仅本机」+「注册 / 登录」
 *   registered 有账号但没登录 —— 「账号 138****0000 · 已注册」+「登录」
 *   signed     已登录（会话与本机账号表对得上）—— 「138****0000 · 已登录」+「管理」
 * 外加一条恒定说明 syncNote（阶段 1 `syncReady` 恒 false：不许出现"已同步"）。
 *
 * 脏数据的兜底：会话里的手机号在本机账号表里找不到（账号被清、换机导入不全）时，
 * 不认这条会话，按"没登录"处理 —— 否则界面会显示一个并不存在的登录态。
 *
 * @param {{accounts?:Array, session?:object}} input
 * @returns {{mode:'anonymous'|'registered'|'signed', title:string, action:string,
 *            syncNote:string, syncReady:boolean, phone:string, accountCount:number}}
 */
export function accountCardState(input) {
  const i = input || {}
  const accounts = (Array.isArray(i.accounts) ? i.accounts : []).filter((a) => a && a.phone)
  const session = i.session && i.session.phone ? i.session : null
  const base = {
    syncNote: SYNC_NOTE,
    syncReady: false, // 阶段 1：后端未接，界面不许承诺已同步
    accountCount: accounts.length,
  }

  if (session && accounts.some((a) => a.phone === session.phone)) {
    const phone = maskPhone(session.phone)
    return Object.assign({}, base, {
      mode: 'signed',
      title: phone + ' · 已登录',
      action: '管理',
      phone,
    })
  }

  if (accounts.length) {
    // 本机有多个账号时显示最近注册的那个（createdAt 最大，缺字段当 0）
    const latest = accounts
      .slice()
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0]
    const phone = maskPhone(latest.phone)
    return Object.assign({}, base, {
      mode: 'registered',
      title: '账号 ' + phone + ' · 已注册',
      action: '登录',
      phone,
    })
  }

  return Object.assign({}, base, {
    mode: 'anonymous',
    title: '随机账号 · 仅本机',
    action: '注册 / 登录',
    phone: '',
  })
}
