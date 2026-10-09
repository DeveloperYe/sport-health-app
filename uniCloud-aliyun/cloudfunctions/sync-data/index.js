'use strict'

// 双端同步云函数 sync-data
// 集合：user_stats（当日统计，按 userId + date 唯一）、sport_records（运动记录）
// 环境变量（微信运动解密用，需在 uniCloud 控制台配置）：WX_APPID、WX_SECRET

const db = uniCloud.database()
const crypto = require('crypto')

exports.main = async (event) => {
  const { action, userId } = event || {}
  if (!userId) return { code: 1, message: 'missing userId' }

  try {
    switch (action) {
      case 'sync':
        return await doSync(event)
      case 'get':
        return await doGet(userId)
      case 'decryptWerun':
        return await doDecryptWerun(event)
      default:
        return { code: 1, message: 'unknown action' }
    }
  } catch (e) {
    return { code: 1, message: e.message || String(e) }
  }
}

// 同步当日统计 + 一条运动记录
async function doSync({ userId, daily, record }) {
  if (daily && daily.date) {
    const statsCol = db.collection('user_stats')
    const payload = {
      userId,
      date: daily.date,
      steps: daily.steps || 0,
      calories: daily.calories || 0,
      duration: daily.duration || 0,
      updatedAt: Date.now(),
    }
    const exist = await statsCol.where({ userId, date: daily.date }).get()
    if (exist.data && exist.data.length) {
      await statsCol.doc(exist.data[0]._id).update(payload)
    } else {
      await statsCol.add(payload)
    }
  }

  if (record && record.id) {
    const recCol = db.collection('sport_records')
    const exist = await recCol.where({ userId, id: record.id }).get()
    if (!exist.data || !exist.data.length) {
      await recCol.add({
        userId,
        ...record,
        createdAt: record.createdAt || Date.now(),
      })
    }
  }

  return { code: 0, message: 'ok' }
}

// 拉取该用户的统计与运动记录
async function doGet(userId) {
  const [stats, records] = await Promise.all([
    db.collection('user_stats').where({ userId }).orderBy('date', 'desc').limit(100).get(),
    db.collection('sport_records').where({ userId }).orderBy('createdAt', 'desc').limit(100).get(),
  ])
  return {
    code: 0,
    stats: stats.data || [],
    records: records.data || [],
  }
}

// 微信运动解密：jscode2session 换 session_key → AES-128-CBC 解密 → 取今日步数
async function doDecryptWerun({ code, encryptedData, iv }) {
  const appid = process.env.WX_APPID
  const secret = process.env.WX_SECRET
  if (!appid || !secret) {
    return { code: 1, message: 'WX_APPID/WX_SECRET 未配置' }
  }
  if (!code || !encryptedData || !iv) {
    return { code: 1, message: '缺少 code / encryptedData / iv' }
  }

  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`
  const httpRes = await uniCloud.httpclient.request(url, { dataType: 'json' })
  const sessionData = httpRes.data || {}
  if (!sessionData.session_key) {
    return { code: 1, message: 'jscode2session 失败：' + (sessionData.errmsg || '无 session_key') }
  }

  let decrypted
  try {
    decrypted = decryptWeRun(sessionData.session_key, encryptedData, iv)
  } catch (e) {
    return { code: 1, message: '解密失败：' + (e.message || String(e)) }
  }

  const list = (decrypted && decrypted.stepInfoList) || []
  if (!list.length) return { code: 0, steps: 0 }

  // 取今日最大步数
  const todayStr = formatDate(Date.now())
  let steps = 0
  for (const item of list) {
    const dayStr = formatDate(item.timestamp * 1000)
    if (dayStr === todayStr && item.step > steps) steps = item.step
  }
  // 兜底：取最后一条
  if (steps === 0) steps = list[list.length - 1].step || 0

  return { code: 0, steps }
}

// AES-128-CBC 解密微信加密数据（PKCS7 padding）
function decryptWeRun(sessionKey, encryptedData, iv) {
  const key = Buffer.from(sessionKey, 'base64')
  const data = Buffer.from(encryptedData, 'base64')
  const ivBuf = Buffer.from(iv, 'base64')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, ivBuf)
  decipher.setAutoPadding(true)
  let decoded = decipher.update(data, undefined, 'utf8')
  decoded += decipher.final('utf8')
  return JSON.parse(decoded)
}

function formatDate(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
