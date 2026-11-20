/**
 * 数据备份的读写层：把 backup.js 的纯逻辑接到真实的存储 / 文件系统。
 *
 * 平台差异：
 *   H5   —— 导出用 Blob + <a download>；导入靠界面里的粘贴框（浏览器拿不到任意本地文件路径）
 *   App  —— 导出写到 `_doc/` 再用系统分享面板（用户可存到文件/发给自己）；导入读 `_doc/` 里最近一次
 *
 * 原则：**任何失败都不抛给界面**，统一返回 {ok, reason, ...}，界面只负责提示。
 */

import {
  EXPORT_KEYS,
  buildBackup,
  serializeBackup,
  parseBackup,
  trimBackup,
  mergeBackup,
  backupFileName,
  KEEP_DAYS,
} from './backup.js'

function hasApp() {
  return typeof plus !== 'undefined' && !!plus.io
}

/** 从本地存储读出白名单里的键（原样，不做转换） */
export function collectRawSnapshot() {
  const raw = {}
  for (const k of EXPORT_KEYS) {
    try {
      const v = uni.getStorageSync(k)
      if (v !== '' && v !== null && v !== undefined) raw[k] = v
    } catch (e) {
      /* 单个键读失败不影响整体 */
    }
  }
  return raw
}

/** 导出：返回 { ok, text, fileName, path?, shared? } */
export async function exportBackupFile() {
  try {
    const backup = buildBackup(collectRawSnapshot())
    const text = serializeBackup(backup)
    const fileName = backupFileName()
    if (hasApp()) {
      const path = await writeAppFile(fileName, text)
      // 用系统分享面板交出去：用户能存到「文件」或直接发给自己的另一台设备
      const shared = await shareAppFile(path)
      return { ok: true, text, fileName, path, shared, summary: backup.counts }
    }
    // H5：Blob 下载
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return { ok: true, text, fileName, downloaded: true, summary: backup.counts }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) }
  }
}

/** 导入：text 来自粘贴框或文件；keepDays 默认 60 */
export function importBackupText(text, opt = {}) {
  const parsed = parseBackup(text)
  if (!parsed.ok) return parsed
  const days = Number(opt.keepDays) > 0 ? Number(opt.keepDays) : KEEP_DAYS
  const incoming = trimBackup(parsed.data, days)
  const current = collectRawSnapshot()
  const merged = mergeBackup(current, incoming)
  const applied = []
  const failed = []
  for (const k of Object.keys(merged)) {
    if (!EXPORT_KEYS.includes(k)) continue
    try {
      uni.setStorageSync(k, merged[k])
      applied.push(k)
    } catch (e) {
      failed.push(k)
    }
  }
  return {
    ok: true,
    applied,
    failed,
    skipped: parsed.skipped,
    counts: parsed.counts,
    exportedAt: parsed.exportedAt,
  }
}

/** App：把文本写到 _doc/ 下，返回绝对路径 */
function writeAppFile(fileName, text) {
  return new Promise((resolve, reject) => {
    try {
      plus.io.resolveLocalFileSystemURL(
        '_doc/',
        (entry) => {
          entry.getFile(
            fileName,
            { create: true },
            (fileEntry) => {
              fileEntry.createWriter(
                (writer) => {
                  writer.onwrite = () => resolve(fileEntry.fullPath)
                  writer.onerror = (e) => reject(new Error('写入失败：' + ((e && e.message) || '')))
                  writer.write(text)
                },
                (e) => reject(new Error('无法写入：' + ((e && e.message) || '')))
              )
            },
            (e) => reject(new Error('无法创建文件：' + ((e && e.message) || '')))
          )
        },
        (e) => reject(new Error('无法打开 App 私有目录：' + ((e && e.message) || '')))
      )
    } catch (e) {
      reject(e)
    }
  })
}

/** App：系统分享面板；不可用就当没分享成功（文件已经写好了） */
function shareAppFile(path) {
  return new Promise((resolve) => {
    try {
      if (!plus.share || !plus.share.sendWithSystem) return resolve(false)
      plus.share.sendWithSystem(
        { type: 'file', filePath: path, content: '运动健康数据备份' },
        () => resolve(true),
        () => resolve(false)
      )
    } catch (e) {
      resolve(false)
    }
  })
}

/**
 * H5：让用户选一个 .json 备份文件读进来（浏览器唯一可行的"选文件"通路）。
 * App 端不用这个 —— 那边有 readLatestBackupFromDevice() 直接读 _doc/。
 * @returns {Promise<{ok:boolean, name?:string, text?:string, reason?:string}>}
 */
export function pickBackupFile() {
  return new Promise((resolve) => {
    if (hasApp()) return resolve({ ok: false, reason: 'App 端请用「读取本机最近一次导出的文件」' })
    let input = null
    const cleanup = () => {
      try {
        if (input && input.parentNode) input.parentNode.removeChild(input)
      } catch (e) {
        /* ignore */
      }
    }
    try {
      input = document.createElement('input')
      input.type = 'file'
      input.accept = 'application/json,.json'
      input.style.display = 'none'
      input.onchange = () => {
        const file = input.files && input.files[0]
        if (!file) {
          cleanup()
          return resolve({ ok: false, reason: '没有选择文件' })
        }
        const fr = new FileReader()
        fr.onloadend = () => {
          cleanup()
          resolve({ ok: true, name: file.name, text: String(fr.result || '') })
        }
        fr.onerror = () => {
          cleanup()
          resolve({ ok: false, reason: '读取失败' })
        }
        fr.readAsText(file)
      }
      // 用户直接关掉选择框时不要永远挂住
      input.oncancel = () => {
        cleanup()
        resolve({ ok: false, reason: '取消选择' })
      }
      document.body.appendChild(input)
      input.click()
    } catch (e) {
      cleanup()
      resolve({ ok: false, reason: (e && e.message) || String(e) })
    }
  })
}

/**
 * 导入时的统一入口，界面不用自己判断平台：
 *   App  → 读 _doc/ 里最近一次导出的备份
 *   H5   → 弹系统文件选择框（浏览器唯一可行的通路）
 * @returns {Promise<{ok:boolean, name?:string, text?:string, reason?:string}>}
 */
export async function readBackupForImport() {
  if (hasApp()) return readLatestBackupFromDevice()
  return pickBackupFile()
}

/** App：读最近一次导出的备份文件（H5 上返回空） */
export function readLatestBackupFromDevice() {
  return new Promise((resolve) => {
    if (!hasApp()) return resolve({ ok: false, reason: 'H5 上请用粘贴导入' })
    try {
      plus.io.resolveLocalFileSystemURL(
        '_doc/',
        (entry) => {
          const reader = entry.createReader()
          reader.readEntries(
            (entries) => {
              const files = entries
                .filter((x) => x.isFile && /^sport-health-.*\.json$/.test(x.name))
                .sort((a, b) => (a.name < b.name ? 1 : -1)) // 文件名带时间，倒序即最新
              if (!files.length) return resolve({ ok: false, reason: '这台设备上还没有导出过备份' })
              const target = files[0]
              target.file(
                (f) => {
                  const fr = new FileReader()
                  fr.onloadend = () => resolve({ ok: true, name: target.name, text: String(fr.result || '') })
                  fr.onerror = () => resolve({ ok: false, reason: '读取失败' })
                  fr.readAsText(f)
                },
                () => resolve({ ok: false, reason: '无法打开文件' })
              )
            },
            () => resolve({ ok: false, reason: '无法列出目录' })
          )
        },
        () => resolve({ ok: false, reason: '无法访问 App 私有目录' })
      )
    } catch (e) {
      resolve({ ok: false, reason: (e && e.message) || String(e) })
    }
  })
}
