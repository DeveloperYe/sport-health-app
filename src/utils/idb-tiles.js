/**
 * H5 端下载包的落地存储（IndexedDB）。
 *
 * 为什么不放 localStorage：底图包 1.6–357 MB，localStorage 只有 5 MB 且是字符串。
 * App 端不用这个模块（那边落 _doc/maps/ 真文件），但文件会被一起打包，所以要保证
 * 在 App 环境里调用也不会炸 —— 所有入口都先检查 indexedDB 是否存在。
 */

const DB_NAME = 'fh-tiles'
const DB_VER = 1
const STORE = 'packs'

let dbPromise = null

function hasIdb() {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB
  } catch (e) {
    return false
  }
}

function openDb() {
  if (!hasIdb()) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VER)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch (e) {
      resolve(null)
    }
  })
  return dbPromise
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let t = null
    try {
      t = db.transaction(STORE, mode)
    } catch (e) {
      return reject(e)
    }
    const store = t.objectStore(STORE)
    let out = null
    try {
      out = fn(store)
    } catch (e) {
      return reject(e)
    }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out)
    t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'))
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'))
  })
}

/** 写入一个 Uint8Array（key 建议用 adcode） */
export async function idbPut(key, bytes) {
  const db = await openDb()
  if (!db) throw new Error('IndexedDB 不可用')
  return tx(db, 'readwrite', (s) => s.put(bytes, String(key)))
}

/** 读出 Uint8Array；没有则 null */
export async function idbGet(key) {
  const db = await openDb()
  if (!db) return null
  const v = await tx(db, 'readonly', (s) => s.get(String(key)))
  if (!v) return null
  return v instanceof Uint8Array ? v : new Uint8Array(v)
}

export async function idbDelete(key) {
  const db = await openDb()
  if (!db) return
  return tx(db, 'readwrite', (s) => s.delete(String(key)))
}

export async function idbKeys() {
  const db = await openDb()
  if (!db) return []
  const k = await tx(db, 'readonly', (s) => s.getAllKeys())
  return Array.isArray(k) ? k.map(String) : []
}

/** 估算已用空间（字节）；不支持时返回 -1 */
export async function idbUsage() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate()
      return e && e.usage ? e.usage : -1
    }
  } catch (e) {
    /* ignore */
  }
  return -1
}
