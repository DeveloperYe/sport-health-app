<template>
  <view class="page" :class="themeClass">
    <!-- 二级页没有原生导航栏，自带返回头（与饮食记录页同构） -->
    <view class="page-back">
      <view class="back-btn" @click="goBack">
        <text class="back-ico">‹</text>
        <text class="back-txt">返回</text>
      </view>
      <text class="page-name">{{ pageTitle }}</text>
      <view class="back-ph"></view>
    </view>

    <!-- ========== 已登录：只给账号信息，不再露出注册表单 ========== -->
    <view class="card" v-if="session">
      <view class="avatar">{{ avatarText }}</view>
      <text class="who num">{{ session.maskedPhone }}</text>
      <text class="who-sub">账号已创建 · 仅本机</text>

      <view class="kv"><text class="kv-k">云同步</text><text class="kv-v warn">服务端开通后可用</text></view>
      <view class="kv"><text class="kv-k">本机账号</text><text class="kv-v num">{{ accountTotal }} / {{ maxAccounts }} 个</text></view>

      <view class="btn ghost" @click="logout">退出登录</view>
      <text class="hint">退出只清除本机的登录状态，账号和这台设备上的记录都还在。</text>
    </view>

    <!-- ========== 未登录：注册 / 登录 ========== -->
    <view v-else>
      <view class="title-row">
        <text class="title">{{ isRegister ? '创建账号' : '登录' }}</text>
        <text class="sub">现在用的是随机账号，只能本机用。注册后可在别的设备登录，云同步要等服务端开通。</text>
      </view>

      <view class="card">
        <!-- 当前身份 -->
        <view class="idbar">
          <text class="idbar-dot">●</text>
          <text class="idbar-main">随机账号 · 仅本机</text>
        </view>

        <!-- 注册 / 登录 同页切换（不新增第二个路由） -->
        <view class="mtab">
          <view class="mtab-item" :class="{ on: isRegister }" @click="setMode('register')">注册</view>
          <view class="mtab-item" :class="{ on: !isRegister }" @click="setMode('login')">登录</view>
        </view>

        <!-- ① 手机号 -->
        <view class="row" :class="{ err: !!err.phone }">
          <text class="cc">+86</text>
          <input
            class="inp num"
            type="number"
            maxlength="11"
            :value="form.phone"
            placeholder="请输入手机号"
            placeholder-class="ph"
            @input="onPhoneInput"
            @blur="validatePhone"
          />
        </view>
        <text class="err-line" v-if="err.phone">{{ err.phone }}</text>

        <!-- ② 安全验证（仅注册；离线出题、本地判定） -->
        <view class="divider" v-if="isRegister"></view>
        <view class="guard" v-if="isRegister">
          <view class="guard-head">
            <text class="guard-title">安全验证</text>
            <text class="guard-badge" v-if="guardOk">已通过</text>
          </view>

          <!-- 本地出题是同步的，150ms 内不显示骨架，避免闪一下 -->
          <view class="guard-skel" v-if="!guardLoaded"></view>

          <view class="guard-body" v-else-if="!guardOk">
            <view class="guard-qrow">
              <text class="guard-q">{{ guard && guard.question }}</text>
              <text class="guard-link" @click="refreshGuard">换一题</text>
            </view>
            <input
              v-if="guard && guard.kind === 'arith'"
              class="guard-inp num"
              type="number"
              maxlength="3"
              :value="guardInput"
              placeholder="填答案"
              placeholder-class="ph"
              @input="onGuardInput"
              @confirm="submitGuard"
            />
            <view class="guard-opts" v-else>
              <view
                class="guard-opt num"
                :class="{ picked: guardInput === String(i) }"
                v-for="(opt, i) in (guard ? guard.options : [])"
                :key="i"
                @click="pickOption(i)"
              >
                {{ opt }}
              </view>
            </view>
          </view>

          <view class="guard-done" v-else @click="resetGuard">
            <text class="guard-done-t">✓ 已通过验证</text>
            <text class="guard-done-a">重新验证</text>
          </view>

          <text class="guard-msg" :class="guardTone" v-if="guardMsg">{{ guardMsg }}</text>
        </view>

        <!-- ③ 密码 -->
        <view class="divider" v-if="isRegister"></view>
        <view class="row" :class="{ err: !!err.password }">
          <input
            class="inp"
            type="text"
            :password="!showPwd"
            :value="form.password"
            :placeholder="isRegister ? '设置密码：8 位以上，含两类字符' : '请输入密码'"
            placeholder-class="ph"
            @input="onPasswordInput"
            @blur="validatePassword"
          />
          <text class="eye" @click="showPwd = !showPwd">{{ showPwd ? '🙈' : '👁' }}</text>
        </view>
        <text class="err-line" v-if="err.password">{{ err.password }}</text>

        <!-- 合规清单：把长规则文案变成进度感（仅注册） -->
        <view class="rules" v-if="isRegister">
          <text class="rule" :class="{ ok: ruleLen }">{{ ruleLen ? '✓' : '○' }} 8 位以上</text>
          <text class="rule" :class="{ ok: ruleClasses }">{{ ruleClasses ? '✓' : '○' }} 已含两类字符</text>
        </view>

        <!-- 确认密码（仅注册） -->
        <view class="row" v-if="isRegister" :class="{ err: !!err.confirm }">
          <input
            class="inp"
            type="text"
            :password="!showPwd2"
            :value="form.confirm"
            placeholder="再输一次密码"
            placeholder-class="ph"
            @input="onConfirmInput"
            @blur="validateConfirm"
          />
          <text class="eye" @click="showPwd2 = !showPwd2">{{ showPwd2 ? '🙈' : '👁' }}</text>
        </view>
        <text class="err-line" v-if="isRegister && err.confirm">{{ err.confirm }}</text>

        <!-- 提交失败：内联条 + 重试（不用 toast，会打断） -->
        <view class="failbar" v-if="failText">
          <text class="failbar-text">⚠ {{ failText }}</text>
          <text class="failbar-retry" @click="submit">重试</text>
        </view>

        <view class="btn" :class="{ busy: submitting }" @click="submit">{{ submitText }}</view>
        <view class="switch" @click="toggleMode">{{ isRegister ? '已有账号？去登录' : '还没有账号？去注册' }}</view>
      </view>

      <text class="foot">当前版本不发送短信验证码；账号数据只保存在这台设备。</text>
    </view>
  </view>
</template>

<script>
import { getUserId } from '@/utils/storage.js'
import {
  DEFAULT_POLICY,
  checkPassword,
  isValidPhone,
  normalizePhone,
  makeChallenge,
  checkChallenge,
  levelForAttempts,
  createAccount,
  loginAccount,
  accountCount,
  getSession,
  openSession,
  closeSession,
  MAX_ACCOUNTS,
} from '@/utils/auth-guard.js'

/** 本机实现几乎瞬间完成，让 loading 至少露一下脸（<150ms 会闪） */
const LOADING_MIN_MS = 150
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default {
  data() {
    return {
      mode: 'register',
      form: { phone: '', password: '', confirm: '' },
      err: { phone: '', password: '', confirm: '' },
      showPwd: false,
      showPwd2: false,
      // 人机验证
      guard: null,
      guardLoaded: false,
      guardInput: '',
      guardOk: false,
      guardAttempts: 0, // 当前这题答错几次（到 3 就换题）
      guardWrongTotal: 0, // 累计答错几次（决定换题型/降难度）
      guardMsg: '',
      guardTone: 'warn',
      guardTimer: null,
      // 提交态
      submitting: false,
      failText: '',
      // 账号态
      session: null,
      accountTotal: 0,
      deviceUserId: '',
      maxAccounts: MAX_ACCOUNTS,
    }
  },
  computed: {
    isRegister() {
      return this.mode === 'register'
    },
    pageTitle() {
      return this.isRegister ? '注册' : '登录'
    },
    submitText() {
      if (this.submitting) return this.isRegister ? '创建中…' : '登录中…'
      return this.isRegister ? '创建账号' : '登录'
    },
    ruleLen() {
      return String(this.form.password || '').length >= DEFAULT_POLICY.minLength
    },
    ruleClasses() {
      return checkPassword(this.form.password).classes >= DEFAULT_POLICY.minClasses
    },
    avatarText() {
      const m = (this.session && this.session.maskedPhone) || ''
      return m ? m.slice(-2) : '我'
    },
  },
  onLoad() {
    this.deviceUserId = getUserId()
    this.accountTotal = accountCount()
    const s = getSession()
    if (s) {
      this.session = s
      return
    }
    // 本机已有账号就默认「登录」，否则默认「注册」
    this.mode = this.accountTotal > 0 ? 'login' : 'register'
    if (this.isRegister) this.newGuard(1)
  },
  onUnload() {
    this.clearGuardTimer()
  },
  methods: {
    // ---------- 导航 ----------
    goBack() {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      if (pages.length > 1) uni.navigateBack()
      else uni.switchTab({ url: '/pages/profile/profile' })
    },

    // ---------- 模式切换 ----------
    setMode(mode) {
      if (this.mode === mode) return
      this.mode = mode
      this.err = { phone: '', password: '', confirm: '' }
      this.failText = ''
      this.form.password = ''
      this.form.confirm = ''
      if (mode === 'register' && !this.guard) this.newGuard(1)
    },
    toggleMode() {
      this.setMode(this.isRegister ? 'login' : 'register')
    },

    // ---------- 人机验证 ----------
    clearGuardTimer() {
      if (this.guardTimer) {
        clearTimeout(this.guardTimer)
        this.guardTimer = null
      }
    },
    newGuard(level) {
      this.clearGuardTimer()
      this.guard = makeChallenge({ level })
      this.guardInput = ''
      this.guardOk = false
      this.guardAttempts = 0
      this.guardLoaded = false
      this.guardTimer = setTimeout(() => {
        this.guardLoaded = true
        this.guardTimer = null
      }, 150)
    },
    refreshGuard() {
      this.newGuard(levelForAttempts(this.guardWrongTotal))
    },
    resetGuard() {
      this.guardWrongTotal = 0
      this.guardMsg = ''
      this.newGuard(1)
    },
    onGuardInput(e) {
      this.guardInput = String((e.detail && e.detail.value) || '').replace(/\D/g, '').slice(0, 3)
      if (this.guardMsg) this.guardMsg = ''
    },
    pickOption(index) {
      this.guardInput = String(index)
      this.submitGuard()
    },
    /**
     * 判题。失败文案刻意"归因到答案/题目"，不归因到人：
     * 第 1 次「答案不太对」，第 2 次给出口「可以换一题」，第 3 次换更简单的题型。
     */
    submitGuard() {
      if (!this.guard || this.guardOk) return
      const r = checkChallenge(this.guard, this.guardInput, {
        now: Date.now(),
        attempts: this.guardAttempts,
      })
      if (r.ok) {
        this.guardOk = true
        this.guardMsg = ''
        this.guardTone = 'warn'
        return
      }
      this.guardAttempts += 1
      this.guardWrongTotal += 1
      const needNew = r.reason === 'expired' || r.reason === 'locked' || this.guardAttempts >= 3
      if (needNew) {
        this.guardTone = 'warn'
        this.guardMsg =
          r.reason === 'expired'
            ? '这道题超时了，换一题继续'
            : r.reason === 'locked'
              ? '试了几次都没对，换一道更简单的'
              : '这题有点绕，换一道更简单的'
        this.newGuard(levelForAttempts(this.guardWrongTotal))
        return
      }
      this.guardTone = 'warn'
      this.guardMsg = this.guardAttempts === 1 ? '答案不太对，再试一次' : '还是不对，可以点「换一题」'
    },

    // ---------- 字段校验 ----------
    /** 密码不合规 → 第一条原因的中文文案（界面文案只留在这里，逻辑层只回 reason） */
    passwordMessage(missing) {
      const list = missing || []
      if (list.indexOf('empty') >= 0) return '请输入密码'
      if (list.indexOf('tooShort') >= 0) return '密码至少 ' + DEFAULT_POLICY.minLength + ' 位'
      if (list.indexOf('tooLong') >= 0) return '密码最多 ' + DEFAULT_POLICY.maxLength + ' 位'
      if (list.indexOf('classes') >= 0) return '密码要至少包含两类字符（比如字母 + 数字）'
      if (list.indexOf('tooSimple') >= 0) return '密码太简单，换一个更好记也更安全的'
      if (list.indexOf('containsPhone') >= 0) return '密码别用手机号里的数字'
      return '密码不符合要求'
    },
    onPhoneInput(e) {
      this.form.phone = normalizePhone(e.detail && e.detail.value)
      if (this.err.phone) this.err.phone = ''
      this.failText = ''
    },
    validatePhone() {
      const p = this.form.phone
      if (!p) {
        this.err.phone = '请输入手机号'
        return false
      }
      if (!isValidPhone(p)) {
        this.err.phone = '手机号格式不对，检查一下'
        return false
      }
      this.err.phone = ''
      return true
    },
    onPasswordInput(e) {
      this.form.password = (e.detail && e.detail.value) || ''
      if (this.err.password) this.err.password = ''
      this.failText = ''
      if (this.form.confirm) this.validateConfirm()
    },
    validatePassword() {
      const r = checkPassword(this.form.password, this.form.phone)
      this.err.password = r.ok ? '' : this.passwordMessage(r.missing)
      return r.ok
    },
    onConfirmInput(e) {
      this.form.confirm = (e.detail && e.detail.value) || ''
      if (this.err.confirm) this.err.confirm = ''
      this.failText = ''
    },
    validateConfirm() {
      if (!this.isRegister) return true
      if (!this.form.confirm) {
        this.err.confirm = '再输一次密码'
        return false
      }
      if (this.form.confirm !== this.form.password) {
        this.err.confirm = '两次输入的密码不一致'
        return false
      }
      this.err.confirm = ''
      return true
    },

    // ---------- 提交 ----------
    async submit() {
      if (this.submitting) return
      this.failText = ''
      const phoneOk = this.validatePhone()

      if (!this.isRegister) {
        if (!phoneOk) return
        if (!this.form.password) {
          this.err.password = '请输入密码'
          return
        }
        await this.runLogin()
        return
      }

      const pwdOk = this.validatePassword()
      const confirmOk = this.validateConfirm()
      if (!phoneOk || !pwdOk || !confirmOk) return
      if (!this.guardOk) {
        // 未通过人机验证时，把注意力引到验证模块（不弹 toast）
        this.guardTone = 'warn'
        this.guardMsg = '先完成上面的安全验证'
        if (!this.guardLoaded) this.guardLoaded = true
        return
      }
      await this.runRegister()
    },
    async runRegister() {
      this.submitting = true
      try {
        await wait(LOADING_MIN_MS)
        const r = createAccount({
          phone: this.form.phone,
          password: this.form.password,
          deviceUserId: this.deviceUserId,
        })
        if (!r.ok) {
          this.handleCreateFail(r)
          return
        }
        this.openSessionFor(r.account)
      } finally {
        this.submitting = false
      }
    },
    async runLogin() {
      this.submitting = true
      try {
        await wait(LOADING_MIN_MS)
        const r = loginAccount(this.form.phone, this.form.password)
        if (!r.ok) {
          this.handleLoginFail(r)
          return
        }
        this.openSessionFor(r.account)
      } finally {
        this.submitting = false
      }
    },
    handleCreateFail(r) {
      if (r.reason === 'bad_phone') this.err.phone = '手机号格式不对，检查一下'
      else if (r.reason === 'bad_password') this.err.password = this.passwordMessage(r.missing)
      else if (r.reason === 'phone_taken') this.err.phone = '这个手机号已经注册过，点下面「去登录」'
      else if (r.reason === 'too_many')
        this.failText = '这台设备注册的账号太多了（上限 ' + MAX_ACCOUNTS + ' 个），先登录其中一个'
      else if (r.reason === 'storage') this.failText = '本机存储写入失败，检查存储空间后再试'
      else this.failText = '创建没成功，请再试一次'
    },
    handleLoginFail(r) {
      if (r.reason === 'bad_phone') this.err.phone = '手机号格式不对，检查一下'
      else if (r.reason === 'not_found') this.err.phone = '这台设备上没有这个手机号，先注册一个'
      else if (r.reason === 'bad_password') this.err.password = '密码不对，再检查一下'
      else this.failText = '登录没成功，请再试一次'
    },
    openSessionFor(account) {
      this.session = openSession(account) || getSession()
      this.accountTotal = accountCount()
      this.form.password = ''
      this.form.confirm = ''
      this.err = { phone: '', password: '', confirm: '' }
      this.guardMsg = ''
      this.clearGuardTimer()
    },

    // ---------- 退出 ----------
    logout() {
      uni.showModal({
        title: '退出登录',
        content: '只会清除本机的登录状态，账号和这台设备上的记录都还在。',
        success: (m) => {
          if (!m.confirm) return
          closeSession()
          this.session = null
          this.mode = 'login'
          this.form.password = ''
          this.form.confirm = ''
          this.accountTotal = accountCount()
          this.guard = null
          this.guardOk = false
          this.guardMsg = ''
        },
      })
    },
  },
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding-top: calc(var(--status-bar-height) + 16rpx);
  padding-bottom: 80rpx;
  background: $bg-page;
}

/* 自带返回头 */
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

/* 标题区 */
.title-row {
  padding: 20rpx 32rpx 0;
}
.title {
  display: block;
  font-size: 40rpx;
  font-weight: 800;
  color: var(--text-1);
  line-height: 1.2;
}
.sub {
  display: block;
  margin-top: 10rpx;
  font-size: 22rpx;
  color: $text-muted;
  line-height: 1.5;
}

/* 卡片 */
.card {
  margin: 20rpx 24rpx 0;
  padding: $card-pad;
  border-radius: $card-radius;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}

/* 当前身份 chip */
.idbar {
  display: flex;
  align-items: center;
  gap: 10rpx;
  padding: 12rpx 20rpx;
  border-radius: 999rpx;
  background: var(--chip-bg);
  border: 1rpx solid var(--chip-line);
}
.idbar-dot {
  font-size: 16rpx;
  color: var(--warm-graphic);
}
.idbar-main {
  font-size: 22rpx;
  color: var(--text-2);
}

/* 注册 / 登录 分段（不叫 .seg/.tseg，避免与性别、外观那两处撞车） */
.mtab {
  display: flex;
  gap: 8rpx;
  margin-top: 18rpx;
  padding: 6rpx;
  border-radius: 999rpx;
  background: $bg-card-light;
  border: 1rpx solid $border-subtle;
}
.mtab-item {
  flex: 1;
  text-align: center;
  padding: 14rpx 0;
  border-radius: 999rpx;
  font-size: 26rpx;
  color: $text-secondary;
  transition: background-color 0.18s var(--ease), color 0.18s var(--ease);
}
.mtab-item.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
}

/* 输入行 */
.row {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-top: 18rpx;
  padding: 0 20rpx;
  height: 88rpx;
  border-radius: 14rpx;
  background: $bg-card-light;
  border: 1rpx solid $border-subtle;
}
.row.err {
  border-color: var(--danger);
}
.cc {
  font-size: 28rpx;
  color: $text-secondary;
}
.inp {
  flex: 1;
  height: 88rpx;
  font-size: 28rpx;
  color: $text-main;
}
.ph {
  color: $text-muted;
}
.eye {
  font-size: 30rpx;
  padding: 0 4rpx;
  opacity: 0.75;
}

/* 分隔线代替字段标签，控制卡片高度 */
.divider {
  height: 1rpx;
  margin: 20rpx 0 0;
  background: $border-subtle;
}

/* 错误行 */
.err-line {
  display: block;
  margin-top: 8rpx;
  font-size: 20rpx;
  color: var(--danger-text);
  line-height: 1.4;
}

/* 密码合规清单 */
.rules {
  display: flex;
  gap: 24rpx;
  margin-top: 10rpx;
}
.rule {
  font-size: 20rpx;
  color: $text-muted;
}
.rule.ok {
  color: var(--accent-text);
}

/* 人机验证 */
.guard {
  margin-top: 16rpx;
}
.guard-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.guard-title {
  font-size: 24rpx;
  color: $text-secondary;
}
.guard-badge {
  font-size: 20rpx;
  color: var(--accent-text);
}
.guard-skel {
  height: 96rpx;
  margin-top: 12rpx;
  border-radius: 14rpx;
  background: $bg-card-light;
}
.guard-body {
  margin-top: 12rpx;
  padding: 18rpx;
  border-radius: 14rpx;
  background: $bg-card-light;
  border: 1rpx solid $border-subtle;
}
.guard-qrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12rpx;
}
.guard-q {
  font-size: 30rpx;
  font-weight: 700;
  color: $text-main;
}
.guard-link {
  font-size: 22rpx;
  color: var(--accent-text);
  padding: 14rpx 22rpx;
  border-radius: 999rpx;
  border: 1rpx solid var(--accent-soft-2);
}
.guard-inp {
  margin-top: 12rpx;
  height: 88rpx;
  padding: 0 16rpx;
  border-radius: 12rpx;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
  font-size: 30rpx;
  color: $text-main;
  text-align: center;
}
.guard-opts {
  display: flex;
  gap: 12rpx;
  margin-top: 12rpx;
}
.guard-opt {
  flex: 1;
  height: 88rpx;
  line-height: 88rpx;
  text-align: center;
  font-size: 30rpx;
  font-weight: 700;
  color: $text-main;
  border-radius: 12rpx;
  background: $bg-card;
  border: 1rpx solid $border-subtle;
}
.guard-opt.picked {
  border-color: var(--accent);
  color: var(--accent-text);
}
.guard-done {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12rpx;
  padding: 14rpx 18rpx;
  border-radius: 14rpx;
  background: var(--accent-soft);
  border: 1rpx solid var(--accent-soft-2);
}
.guard-done-t {
  font-size: 24rpx;
  font-weight: 700;
  color: var(--accent-text);
}
.guard-done-a {
  font-size: 22rpx;
  color: $text-secondary;
}
/* 失败提示用暖色而不是红色：这是"再试一次"，不是"你出错了" */
.guard-msg {
  display: block;
  margin-top: 8rpx;
  font-size: 20rpx;
  line-height: 1.4;
  color: var(--warm-text);
}
.guard-msg.danger {
  color: var(--danger-text);
}

/* 提交失败内联条 */
.failbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  margin-top: 18rpx;
  padding: 16rpx 18rpx;
  border-radius: 14rpx;
  background: var(--bg-card-2);
  border: 1rpx solid var(--danger);
}
.failbar-text {
  flex: 1;
  font-size: 22rpx;
  color: var(--danger-text);
  line-height: 1.4;
}
.failbar-retry {
  font-size: 22rpx;
  color: var(--on-accent);
  background: var(--accent);
  padding: 8rpx 22rpx;
  border-radius: 999rpx;
}

/* 主按钮：方块 16rpx */
.btn {
  margin-top: 24rpx;
  text-align: center;
  padding: 24rpx 0;
  border-radius: $btn-radius;
  background: var(--accent);
  color: var(--on-accent);
  font-size: $btn-font-lg;
  font-weight: 700;
  transition: transform 0.12s var(--ease), opacity 0.18s var(--ease);
}
.btn:active {
  transform: scale(0.98);
  opacity: 0.92;
}
.btn.busy {
  opacity: 0.6;
}
.btn.ghost {
  background: $bg-card-light;
  color: $text-main;
  border: 1rpx solid $border-subtle;
}

/* 次按钮：胶囊 */
.switch {
  margin-top: 18rpx;
  text-align: center;
  padding: 16rpx 0;
  border-radius: 999rpx;
  font-size: 24rpx;
  color: $text-secondary;
  border: 1rpx solid $border-subtle;
  background: $bg-card-light;
}

.hint {
  display: block;
  margin-top: 16rpx;
  font-size: 22rpx;
  color: $text-muted;
  line-height: 1.5;
}
.foot {
  display: block;
  margin: 24rpx 32rpx 0;
  font-size: 22rpx;
  color: $text-muted;
  line-height: 1.5;
}

/* ===== 已登录态 ===== */
.avatar {
  width: 96rpx;
  height: 96rpx;
  line-height: 96rpx;
  text-align: center;
  border-radius: 999rpx;
  background: var(--accent-soft);
  border: 1rpx solid var(--accent-soft-2);
  color: var(--accent-text);
  font-size: 32rpx;
  font-weight: 800;
}
.who {
  display: block;
  margin-top: 16rpx;
  font-size: 36rpx;
  font-weight: 800;
  color: var(--text-1);
}
.who-sub {
  display: block;
  margin-top: 6rpx;
  font-size: 22rpx;
  color: $text-muted;
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
.kv-v.warn {
  color: var(--warm-text);
}
</style>
