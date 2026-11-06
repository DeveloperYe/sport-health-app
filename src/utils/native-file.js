/**
 * App 端读文件的多路径实现。
 *
 * 背景（真机实测 2026-11-06）：用户手机上 plus.io.FileReader **写能成功、删能成功，
 * 但读回来永远是空**（连 14 字节的测试文件都读不出内容）。这直接导致：
 *   - SHA-256 算不出来（表现为一直卡在校验）
 *   - 下载的地图包加载不出来（读包也走 FileReader）
 *
 * 所以这里把「可能读得出内容」的手段都实现一遍，按可靠性排序试，
 * 记住第一条真正读到内容的路径，后续全部复用它：
 *   A. FileReader.readAsArrayBuffer(file)        整文件
 *   B. FileReader.readAsDataURL(file)            整文件
 *   C. FileReader.readAsArrayBuffer(file.slice)  分块
 *   D. FileReader.readAsDataURL(file.slice)      分块
 *   E. Native.js：RandomAccessFile + Base64      分块（Java 侧读，绕开 FileReader）
 *   F. Native.js：Files.readAllBytes + Base64    整文件
 *
 * 全部失败才返回 null —— 调用方据此如实报错，不再假装成功。
 */

const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]

/** 记住哪条读取路径可用（'arraybuffer' | 'dataurl' | 'native' | ''） */
let goodStrategy = ''
let strategyProbed = false

export function getReadStrategy() {
  return goodStrategy
}

export function hasPlus() {
  try {
    return typeof plus !== 'undefined' && !!plus.io
  } catch (e) {
    return false
  }
}

function hasNative() {
  try {
    return typeof plus !== 'undefined' && !!plus.android
  } catch (e) {
    return false
  }
}

/** base64 / dataURL / ArrayBuffer 统一转 Uint8Array；拿不到就 null */
export function toBytes(raw) {
  if (raw === null || raw === undefined) return null
  try {
    if (typeof raw === 'object' && typeof raw.byteLength === 'number' && typeof raw.length !== 'number') {
      return new Uint8Array(raw)
    }
    if (raw instanceof Uint8Array) return raw
  } catch (e) {
    /* ignore */
  }
  let s = ''
  try {
    if (typeof raw === 'string') s = raw
    else if (raw && typeof raw.data === 'string') s = raw.data
    else s = String(raw)
  } catch (e) {
    return null
  }
  if (!s) return null
  const i = s.indexOf(',')
  const b64 = i >= 0 ? s.slice(i + 1) : s
  try {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k)
    return u8
  } catch (e) {
    return null
  }
}

/**
 * 用 FileReader 读（可选分块）。返回 { ok, bytes|b64, err, mode }
 */
export function fileReaderRead(file, opt) {
  const o = opt || {}
  const asArray = !!o.asArrayBuffer
  const useSlice = o.start !== undefined && o.end !== undefined
  // readAsArrayBuffer 在部分机型上永不回调，给它更短的等待
  const timeoutMs = o.timeoutMs || (asArray ? 1200 : 6000)
  return new Promise((resolve) => {
    let done = false
    const fin = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    const timer = setTimeout(() => fin({ ok: false, err: '超时（FileReader 没回调）' }), timeoutMs)
    try {
      let target = file
      if (useSlice) {
        if (typeof file.slice !== 'function') {
          clearTimeout(timer)
          return fin({ ok: false, err: 'File 不支持 slice' })
        }
        target = file.slice(o.start, o.end)
      }
      const fr = new plus.io.FileReader()
      fr.onloadend = () => {
        clearTimeout(timer)
        const raw = fr.result
        if (asArray) {
          const u8 = toBytes(raw)
          if (u8 && u8.length) return fin({ ok: true, bytes: u8 })
          return fin({ ok: false, err: '读到空内容' })
        }
        const u8 = toBytes(raw)
        if (u8 && u8.length) return fin({ ok: true, bytes: u8 })
        // 退回原始字符串（调用方可能要 base64 本身）
        const s = typeof raw === 'string' ? raw : raw && raw.data
        if (typeof s === 'string' && s.length) {
          const i = s.indexOf(',')
          const b64 = i >= 0 ? s.slice(i + 1) : s
          if (b64.length) return fin({ ok: true, b64: b64 })
        }
        return fin({ ok: false, err: '读到空内容' })
      }
      fr.onerror = () => {
        clearTimeout(timer)
        fin({ ok: false, err: 'FileReader onerror' })
      }
      if (asArray) {
        if (!fr.readAsArrayBuffer) {
          clearTimeout(timer)
          return fin({ ok: false, err: '不支持 readAsArrayBuffer' })
        }
        fr.readAsArrayBuffer(target)
      } else {
        fr.readAsDataURL(target)
      }
    } catch (e) {
      clearTimeout(timer)
      fin({ ok: false, err: (e && e.message) || String(e) })
    }
  })
}

/**
 * Native.js 读文件 → base64（不含 data: 前缀）。
 * @param {string} absPath 绝对路径
 * @param {number} [start] 起始偏移
 * @param {number} [end] 结束偏移（不含）
 */
export function nativeReadBase64(absPath, start, end) {
  if (!hasNative() || !absPath) return null
  try {
    const Files = plus.android.importClass('java.nio.file.Files')
    const Paths = plus.android.importClass('java.nio.file.Paths')
    const Base64 = plus.android.importClass('android.util.Base64')
    const whole = start === undefined || end === undefined
    if (whole) {
      const bytes = Files.readAllBytes(Paths.get(absPath))
      const b64 = Base64.encodeToString(bytes, 2) // NO_WRAP
      const s = String(b64 || '')
      return s.length ? s : null
    }
    // 分块：RandomAccessFile + byte[]
    const RandomAccessFile = plus.android.importClass('java.io.RandomAccessFile')
    const Array_ = plus.android.importClass('java.lang.reflect.Array')
    const Byte = plus.android.importClass('java.lang.Byte')
    const raf = new RandomAccessFile(absPath, 'r')
    try {
      const len = Math.max(0, end - start)
      if (!len) return null
      raf.seek(start)
      const buf = Array_.newInstance(Byte.TYPE, len)
      const n = raf.read(buf, 0, len)
      if (!n || n <= 0) return null
      const b64 = Base64.encodeToString(buf, 0, n, 2)
      const s = String(b64 || '')
      return s.length ? s : null
    } finally {
      try {
        raf.close()
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    return null
  }
}

/**
 * 通用读取：按 A→F 顺序尝试，返回第一条成功的路径。
 * @param {object} file plus.io 的 File 对象（可为空：只在有 absPath 时才有意义）
 * @param {{absPath?:string, start?:number, end?:number, timeoutMs?:number}} opt
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, b64?:string, via?:string, err?:string, tried?:string[]}>}
 */
export async function readAny(file, opt) {
  const o = opt || {}
  const tried = []
  const sliced = o.start !== undefined && o.end !== undefined
  const order = []

  // 真机实测（2026-11-06）：
  //   FileReader.readAsDataURL  ✅ 可用（整文件、分块都行）
  //   FileReader.readAsArrayBuffer ✖ 从不回调（只能靠超时，纯等待）
  //   Native 分块 RandomAccessFile ✖ 返回正确长度但**内容全 0**（看着成功、数据是错的）
  //   Native 整文件 Files.readAllBytes ✖ 不可用
  // ⇒ 顺序：dataURL 优先；arraybuffer 只作短超时兜底；Native 放最后且必须过内容校验。
  if (file) {
    // 分块读时不回退"整文件读"：那会让每个分块都读一遍整包（哈希场景是灾难）
    if (sliced) order.push('slice-dataurl', 'slice-arraybuffer')
    else order.push('file-dataurl', 'file-arraybuffer')
  }
  if (o.absPath) {
    if (sliced) order.push('native-chunk')
    else order.push('native-whole', 'native-chunk')
  }
  // 已经知道哪条能用，就把它提到最前面
  if (goodStrategy) {
    const i = order.indexOf(goodStrategy)
    if (i > 0) {
      order.splice(i, 1)
      order.unshift(goodStrategy)
    }
  }

  for (let i = 0; i < order.length; i++) {
    const mode = order[i]
    let r = null
    if (mode === 'slice-arraybuffer') {
      r = await fileReaderRead(file, { asArrayBuffer: true, start: o.start, end: o.end, timeoutMs: o.timeoutMs })
    } else if (mode === 'slice-dataurl') {
      r = await fileReaderRead(file, { asArrayBuffer: false, start: o.start, end: o.end, timeoutMs: o.timeoutMs })
    } else if (mode === 'file-arraybuffer') {
      r = await fileReaderRead(file, { asArrayBuffer: true, timeoutMs: o.timeoutMs })
    } else if (mode === 'file-dataurl') {
      r = await fileReaderRead(file, { asArrayBuffer: false, timeoutMs: o.timeoutMs })
    } else if (mode === 'native-chunk') {
      const b64 = nativeReadBase64(o.absPath, o.start, o.end)
      r = b64 ? { ok: true, b64: b64 } : { ok: false, err: 'Native 分块读取返回空' }
    } else if (mode === 'native-whole') {
      const b64 = nativeReadBase64(o.absPath)
      r = b64 ? { ok: true, b64: b64 } : { ok: false, err: 'Native 整文件读取返回空' }
    }
    if (r && r.ok) {
      tried.push(mode + ' ✅')
      if (!goodStrategy) goodStrategy = mode
      return { ok: true, bytes: r.bytes, b64: r.b64, via: mode, tried: tried }
    }
    tried.push(mode + ' ✗（' + ((r && r.err) || '未知') + '）')
  }
  return { ok: false, err: '所有读取方式都失败', tried: tried }
}

/** 是否长得像 PMTiles 头（诊断用） */
export function looksPmtiles(u8) {
  if (!u8 || u8.length < 16) return false
  for (let i = 0; i < MAGIC.length; i++) if (u8[i] !== MAGIC[i]) return false
  return true
}

export function resetStrategy() {
  goodStrategy = ''
  strategyProbed = false
}
