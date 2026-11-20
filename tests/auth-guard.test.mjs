// 注册/登录逻辑层测试：密码口径、离线人机验证的判题状态机、口令 hash、本机账号表。
// 这些逻辑错都不会报错，只会静默放行或静默拒绝，所以必须有断言钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_POLICY,
  classesOf,
  isTooSimple,
  checkPassword,
  normalizePhone,
  isValidPhone,
  phoneTail,
  maskPhone,
  makeSalt,
  hashPassword,
  verifyPassword,
  makeChallenge,
  checkChallenge,
  levelForAttempts,
  CHALLENGE_TTL_MS,
  MAX_ACCOUNTS,
  createAccount,
  loginAccount,
  listAccounts,
  findAccount,
  accountCount,
  getSession,
  openSession,
  closeSession,
  accountCardState,
  SYNC_NOTE,
} from '../src/utils/auth-guard.js'

/** 内存版 store，形状与 uni 存储适配器一致：{ get, set, remove } */
function memStore(init) {
  const map = new Map(Object.entries(init || {}))
  return {
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => {
      map.set(key, value)
      return true
    },
    remove: (key) => {
      map.delete(key)
      return true
    },
  }
}

const PHONE = '13800138000'

// ============================ 密码口径 =====================================

test('classesOf：四类字符分别命中，中文与空格不算任何类', () => {
  assert.deepEqual(classesOf('abc'), ['lower'])
  assert.deepEqual(classesOf('ABC'), ['upper'])
  assert.deepEqual(classesOf('123'), ['digit'])
  assert.deepEqual(classesOf('!@#$'), ['symbol'])
  assert.deepEqual(classesOf('aA1!'), ['lower', 'upper', 'digit', 'symbol'])
  // 空格、全角符号、中文都不计入特殊符号（口径：只认 ASCII 可见符号）
  assert.deepEqual(classesOf('密码 　！'), [])
})

test('checkPassword：空密码只报 empty，不叠加其他原因', () => {
  const r = checkPassword('', PHONE)
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['empty'])
  assert.equal(r.length, 0)
})

test('checkPassword：7 位报 tooShort，8 位两类字符通过', () => {
  const short = checkPassword('abc1234', PHONE)
  assert.equal(short.ok, false)
  assert.deepEqual(short.missing, ['tooShort'])

  const good = checkPassword('abcd1234', PHONE)
  assert.equal(good.ok, true)
  assert.deepEqual(good.missing, [])
  assert.equal(good.classes, 2)
})

test('checkPassword：8 位但只有一类字符要报 classes（字母 alone 不算合规）', () => {
  // 用 qwertyui 而不是 abcdefgh：后者是连续升号，会额外命中 tooSimple，测不出"只缺类别"
  const r = checkPassword('qwertyui', PHONE)
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['classes'])
})

test('checkPassword：全重复与全连号都判 tooSimple（正序与倒序都算）', () => {
  // 注意：全重复必然是单类字符，所以 missing 里会同时有 classes —— 只断言含 tooSimple
  assert.ok(checkPassword('aaaaaaaa', PHONE).missing.includes('tooSimple'))
  assert.ok(checkPassword('12345678', PHONE).missing.includes('tooSimple'))
  assert.ok(checkPassword('87654321', PHONE).missing.includes('tooSimple'), '倒序连号同样挡住')
  // 只差一个字符断开的连号不算（避免误伤正常密码）
  assert.equal(checkPassword('123x567a', PHONE).ok, true)
})

test('checkPassword：含手机号后 6 位要报 containsPhone', () => {
  assert.equal(phoneTail(PHONE, 6), '138000')
  const r = checkPassword('ab138000CD', PHONE)
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['containsPhone'])
})

test('checkPassword：33 位报 tooLong；32 位通过（边界各测一次）', () => {
  const ok32 = 'a'.repeat(30) + 'B1' // 32 位，三类字符
  assert.equal(ok32.length, 32)
  assert.equal(checkPassword(ok32, PHONE).ok, true)
  const bad33 = 'a'.repeat(30) + 'B1x' // 33 位
  assert.equal(bad33.length, 33)
  assert.deepEqual(checkPassword(bad33, PHONE).missing, ['tooLong'])
})

test('checkPassword：口径可配置（minClasses=3 时两类字符不通过）', () => {
  const r = checkPassword('abcd1234', PHONE, { minClasses: 3 })
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['classes'])
  // 关掉"手机号尾号"这条之后，含尾号的密码可以过
  assert.equal(checkPassword('ab138000CD', PHONE, { phoneTail: 0 }).ok, true)
  assert.equal(DEFAULT_POLICY.minClasses, 2)
})

test('isTooSimple：常规密码返回 false（别误伤）', () => {
  assert.equal(isTooSimple('Ab3xY9zQ'), false)
  assert.equal(isTooSimple('a'), false)
})

// ============================ 手机号 =======================================

test('手机号：normalize 只留数字且截 11 位；格式校验按 1[3-9]', () => {
  assert.equal(normalizePhone('138-0013 8000'), PHONE)
  assert.equal(normalizePhone('13800138000123'), PHONE)
  assert.equal(isValidPhone(PHONE), true)
  assert.equal(isValidPhone('12800138000'), false) // 第二位不能是 2
  assert.equal(isValidPhone('1380013800'), false) // 10 位
  assert.equal(isValidPhone(''), false)
})

test('maskPhone：11 位打码保留前 3 后 4', () => {
  assert.equal(maskPhone(PHONE), '138****8000')
  assert.equal(maskPhone('123'), '123****')
  assert.equal(maskPhone(''), '')
})

// ========================= 人机验证：出题 ==================================

test('makeChallenge level1：注入随机源后题目与答案确定，且答案等于两数之和', () => {
  const c = makeChallenge({ level: 1, rand: () => 0, now: 1700000000000 })
  assert.equal(c.kind, 'arith')
  assert.equal(c.question, '11 + 3 = ？')
  assert.equal(c.answer, 14)
  assert.equal(c.level, 1)
  assert.equal(c.ttlMs, CHALLENGE_TTL_MS)
  assert.equal(c.maxAttempts, 3)
  assert.match(c.id, /^c/)
})

test('makeChallenge level2：换题型为数字点选，三选项互不相同且 answer 指向最大值', () => {
  // Lehmer（最小标准）伪随机：s = 16807 * s % 2147483647，乘积 < 2^53，不丢精度
  let s = 1
  const rand = () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
  for (let i = 0; i < 20; i++) {
    const c = makeChallenge({ level: 2, rand, now: 1700000000000 })
    assert.equal(c.kind, 'pick')
    assert.equal(c.options.length, 3)
    assert.equal(new Set(c.options).size, 3, '选项必须互不相同，否则"最大的"有并列')
    assert.equal(c.options[c.answer], Math.max(...c.options))
  }
})

test('makeChallenge level2：随机源退化成常量也不会死循环，仍产出互不相同的选项', () => {
  const c = makeChallenge({ level: 2, rand: () => 0.999999, now: 1700000000000 })
  assert.equal(new Set(c.options).size, 3)
  assert.equal(c.options[c.answer], Math.max(...c.options))
})

test('makeChallenge level3：降难度后和不超过 9（口算即可）', () => {
  for (let seed = 0; seed < 30; seed++) {
    const r = (seed * 9301 + 49297) % 233280
    const c = makeChallenge({ level: 3, rand: () => r / 233280, now: 1700000000000 })
    assert.equal(c.kind, 'arith')
    assert.ok(c.answer <= 9, 'level3 的答案必须 ≤ 9，实际 ' + c.answer)
    assert.ok(c.answer >= 2)
  }
})

test('levelForAttempts：连错 0–1 常规、2 次换题型、3 次以上降难度', () => {
  assert.equal(levelForAttempts(0), 1)
  assert.equal(levelForAttempts(1), 1)
  assert.equal(levelForAttempts(2), 2)
  assert.equal(levelForAttempts(3), 3)
  assert.equal(levelForAttempts(9), 3)
})

// ========================= 人机验证：判题 ==================================

test('checkChallenge：答案正确 → ok', () => {
  const now = 1700000000000
  const c = makeChallenge({ level: 1, rand: () => 0, now })
  assert.deepEqual(checkChallenge(c, '14', { now: now + 1000, attempts: 0 }), { ok: true, reason: '' })
  // 数字与字符串等价、前后空格容忍
  assert.equal(checkChallenge(c, 14, { now: now + 1000 }).ok, true)
  assert.equal(checkChallenge(c, ' 14 ', { now: now + 1000 }).ok, true)
})

test('checkChallenge：答案错误 → reason=wrong（不消耗、不修改题目对象）', () => {
  const now = 1700000000000
  const c = makeChallenge({ level: 1, rand: () => 0, now })
  const snapshot = JSON.stringify(c)
  assert.deepEqual(checkChallenge(c, '15', { now: now + 1000 }), { ok: false, reason: 'wrong' })
  assert.equal(JSON.stringify(c), snapshot, 'checkChallenge 必须是纯函数，不能改动 challenge')
})

test('checkChallenge：超过 ttl 判 expired（边界内仍然有效）', () => {
  const now = 1700000000000
  const c = makeChallenge({ level: 1, rand: () => 0, now })
  assert.equal(checkChallenge(c, '14', { now: now + CHALLENGE_TTL_MS }).ok, true, '恰好到期仍算有效')
  assert.deepEqual(checkChallenge(c, '14', { now: now + CHALLENGE_TTL_MS + 1 }), {
    ok: false,
    reason: 'expired',
  })
})

test('checkChallenge：试满 3 次判 locked（哪怕答案是错的也先说 locked）', () => {
  const now = 1700000000000
  const c = makeChallenge({ level: 1, rand: () => 0, now })
  assert.deepEqual(checkChallenge(c, '99', { now: now + 1000, attempts: 3 }), {
    ok: false,
    reason: 'locked',
  })
  assert.equal(checkChallenge(c, '14', { now: now + 1000, attempts: 2 }).ok, true)
})

test('checkChallenge：非挑战对象判 invalid，不抛异常', () => {
  assert.deepEqual(checkChallenge(null, '1'), { ok: false, reason: 'invalid' })
  assert.deepEqual(checkChallenge({}, '1'), { ok: false, reason: 'invalid' })
  assert.deepEqual(checkChallenge({ answer: 1 }, '1'), { ok: false, reason: 'invalid' })
})

test('checkChallenge：点选题按选项下标判定', () => {
  const now = 1700000000000
  const c = makeChallenge({ level: 2, rand: () => 0, now })
  assert.equal(checkChallenge(c, String(c.answer), { now: now + 1000 }).ok, true)
  const wrongIdx = (c.answer + 1) % 3
  assert.deepEqual(checkChallenge(c, String(wrongIdx), { now: now + 1000 }), {
    ok: false,
    reason: 'wrong',
  })
})

// ============================= 口令 hash ==================================

test('hashPassword：同一 password + 同一 salt 结果稳定，长度 64 位十六进制', () => {
  const a = hashPassword('abcd1234', 'saltsalt', { rounds: 50 })
  const b = hashPassword('abcd1234', 'saltsalt', { rounds: 50 })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('hashPassword：不同 salt → 结果不同；不同密码 → 结果不同', () => {
  const base = 'abcd1234'
  const h1 = hashPassword(base, 'salt-one', { rounds: 50 })
  const h2 = hashPassword(base, 'salt-two', { rounds: 50 })
  const h3 = hashPassword('abcd12345', 'salt-one', { rounds: 50 })
  assert.notEqual(h1, h2)
  assert.notEqual(h1, h3)
})

test('hashPassword：结果里不含明文（哪怕密码很短）', () => {
  const h = hashPassword('Ab1!', 'x', { rounds: 10 })
  assert.equal(h.indexOf('Ab1!'), -1)
  assert.equal(h.length, 64)
})

test('verifyPassword：正确通过、错误拒绝、空 hash 直接 false', () => {
  const salt = 'abc123'
  const hash = hashPassword('abcd1234', salt, { rounds: 50 })
  assert.equal(verifyPassword('abcd1234', salt, hash, { rounds: 50 }), true)
  assert.equal(verifyPassword('abcd12345', salt, hash, { rounds: 50 }), false)
  assert.equal(verifyPassword('abcd1234', salt, '', { rounds: 50 }), false)
})

test('makeSalt：长度符合要求，两次调用不相同（同一毫秒内也要不同）', () => {
  const now = 1700000000000
  const s1 = makeSalt(16, { now })
  const s2 = makeSalt(16, { now })
  assert.equal(s1.length, 32)
  assert.match(s1, /^[0-9a-f]{32}$/)
  assert.notEqual(s1, s2, 'salt 每次注册必须唯一，哪怕是同一毫秒')
  assert.equal(makeSalt(8, { now }).length, 16)
})

// =========================== 本机账号表 ====================================

test('createAccount：成功入库，返回体不含 salt/hash，密码不落明文', () => {
  const store = memStore()
  const r = createAccount(
    { phone: '138-0013 8000', password: 'abcd1234', deviceUserId: 'u_test' },
    store,
    { now: 1700000000000 }
  )
  assert.equal(r.ok, true)
  assert.equal(r.account.phone, PHONE)
  assert.equal(r.account.maskedPhone, '138****8000')
  assert.equal(r.account.salt, undefined, '对外返回体不能带 salt')
  assert.equal(r.account.hash, undefined, '对外返回体不能带 hash')

  const saved = store.get('fh_accounts')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].salt.length, 32)
  assert.equal(saved[0].hash.length, 64)
  assert.equal(saved[0].deviceUserId, 'u_test', '要记住注册时的匿名设备 id，便于将来认领本地数据')
  assert.equal(JSON.stringify(saved).indexOf('abcd1234'), -1, '存储里绝不能出现明文密码')
})

test('createAccount：手机号不合法 / 密码不合规 / 重复手机号分别给出结构化原因', () => {
  const store = memStore()
  assert.deepEqual(
    createAccount({ phone: '12800138000', password: 'abcd1234' }, store),
    { ok: false, reason: 'bad_phone' }
  )

  const badPwd = createAccount({ phone: PHONE, password: 'qwertyui' }, store)
  assert.equal(badPwd.ok, false)
  assert.equal(badPwd.reason, 'bad_password')
  assert.deepEqual(badPwd.missing, ['classes'])

  assert.equal(createAccount({ phone: PHONE, password: 'abcd1234' }, store).ok, true)
  assert.deepEqual(createAccount({ phone: PHONE, password: 'abcd1234' }, store), {
    ok: false,
    reason: 'phone_taken',
  })
})

test('createAccount：本机账号表上限 5 个，第 6 个被拒', () => {
  const store = memStore()
  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    const phone = '1380013800' + i
    assert.equal(createAccount({ phone, password: 'abcd1234' }, store).ok, true, '第 ' + (i + 1) + ' 个应成功')
  }
  const r = createAccount({ phone: '13900139000', password: 'abcd1234' }, store)
  assert.deepEqual(r, { ok: false, reason: 'too_many' })
  assert.equal(accountCount(store), MAX_ACCOUNTS)
})

test('loginAccount：手机号+密码正确才通过，密码错/未注册分别返回原因', () => {
  const store = memStore()
  createAccount({ phone: PHONE, password: 'abcd1234' }, store, { now: 1 })
  assert.equal(loginAccount('138 0013 8000', 'abcd1234', store).ok, true)
  assert.deepEqual(loginAccount(PHONE, 'wrongpass1', store), { ok: false, reason: 'bad_password' })
  assert.deepEqual(loginAccount('13900139000', 'abcd1234', store), { ok: false, reason: 'not_found' })
  assert.deepEqual(loginAccount('12800138000', 'abcd1234', store), { ok: false, reason: 'bad_phone' })
})

test('findAccount / listAccounts：脏数据被过滤掉，不会让界面崩', () => {
  const store = memStore({
    fh_accounts: [
      null,
      { phone: PHONE }, // 缺 salt/hash
      { phone: PHONE, salt: 's', hash: 'h' },
    ],
  })
  assert.equal(listAccounts(store).length, 1)
  assert.equal(findAccount(PHONE, store).hash, 'h')
  assert.equal(findAccount('', store), null)
})

test('会话：open 后可读（不含密码）、close 后为 null', () => {
  const store = memStore()
  assert.equal(getSession(store), null)
  const session = openSession({ phone: PHONE }, store, { now: 1700000000000 })
  assert.equal(session.phone, PHONE)
  assert.equal(session.maskedPhone, '138****8000')
  assert.equal(JSON.stringify(session).indexOf('hash'), -1)
  assert.equal(getSession(store).phone, PHONE)
  closeSession(store)
  assert.equal(getSession(store), null)
})

// =================== 「我的」页账号入口卡的四态判定 ========================

const ACC = (phone, createdAt) => ({ phone, createdAt, salt: 's', hash: 'h' })

test('accountCardState：本机无账号 → anonymous（随机账号 · 仅本机 + 注册 / 登录）', () => {
  const s = accountCardState({ accounts: [], session: null })
  assert.equal(s.mode, 'anonymous')
  assert.equal(s.title, '随机账号 · 仅本机')
  assert.equal(s.action, '注册 / 登录')
  assert.equal(s.phone, '')
  assert.equal(s.accountCount, 0)
})

test('accountCardState：有账号未登录 → registered，标题带打码手机号 + 登录', () => {
  const s = accountCardState({ accounts: [ACC(PHONE, 1)], session: null })
  assert.equal(s.mode, 'registered')
  assert.equal(s.title, '账号 138****8000 · 已注册')
  assert.equal(s.action, '登录')
  assert.equal(s.phone, '138****8000')
  assert.equal(s.accountCount, 1)
})

test('accountCardState：会话与本机账号对得上 → signed（· 已登录 + 管理）', () => {
  const s = accountCardState({
    accounts: [ACC(PHONE, 1)],
    session: { phone: PHONE, maskedPhone: '138****8000' },
  })
  assert.equal(s.mode, 'signed')
  assert.equal(s.title, '138****8000 · 已登录')
  assert.equal(s.action, '管理')
})

test('accountCardState：多个账号取最近注册的那个（createdAt 最大）', () => {
  const s = accountCardState({
    accounts: [ACC('13800138001', 100), ACC('13900139002', 900), ACC('13700137003', 500)],
    session: null,
  })
  assert.equal(s.mode, 'registered')
  assert.equal(s.phone, '139****9002')
  assert.equal(s.accountCount, 3)
})

test('accountCardState：脏会话（手机号不在本机账号表）不认成已登录', () => {
  // 有别的账号 → 降级为 registered，而不是显示一个并不存在的登录态
  const withOthers = accountCardState({
    accounts: [ACC(PHONE, 1)],
    session: { phone: '13900139000' },
  })
  assert.equal(withOthers.mode, 'registered')
  // 一个账号都没有 → 降级为 anonymous
  const empty = accountCardState({ accounts: [], session: { phone: '13900139000' } })
  assert.equal(empty.mode, 'anonymous')
})

test('accountCardState：四态都带云同步说明，且 syncReady 恒 false（阶段 1）', () => {
  const states = [
    accountCardState({ accounts: [], session: null }),
    accountCardState({ accounts: [ACC(PHONE, 1)], session: null }),
    accountCardState({ accounts: [ACC(PHONE, 1)], session: { phone: PHONE } }),
  ]
  for (const s of states) {
    assert.equal(s.syncNote, SYNC_NOTE)
    assert.equal(s.syncNote, '云同步 · 服务端开通后可用')
    assert.equal(s.syncReady, false)
  }
})

test('accountCardState：文案里不出现任何"已同步"类承诺（禁用词回归）', () => {
  const banned = ['已同步', '云端已保存', '已备份到云', '跨设备可用', '数据已安全加密上传', '已验证手机号']
  const states = [
    accountCardState({ accounts: [], session: null }),
    accountCardState({ accounts: [ACC(PHONE, 1)], session: null }),
    accountCardState({ accounts: [ACC(PHONE, 1)], session: { phone: PHONE } }),
  ]
  for (const s of states) {
    const text = s.title + '|' + s.action + '|' + s.syncNote
    for (const word of banned) {
      assert.equal(text.indexOf(word), -1, '不该出现「' + word + '」，实际: ' + text)
    }
  }
})

test('accountCardState：入参缺失或被塞脏数据都不抛异常', () => {
  for (const input of [undefined, null, {}, { accounts: null }, { accounts: [null, {}] }]) {
    const s = accountCardState(input)
    assert.equal(s.mode, 'anonymous')
    assert.equal(s.accountCount, 0)
  }
})
