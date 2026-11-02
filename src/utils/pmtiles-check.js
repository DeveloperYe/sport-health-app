/**
 * PMTiles v3 文件头校验（纯函数，方便单测）。
 *
 * 为什么需要它：底图包是从公网下载的，可能拿到 404 的 HTML 页、被截断的半个文件、
 * 或者别的城市的包。只看"有没有内容"不够，必须验证结构自洽。
 *
 * 实测确认（用仓库内青岛包 22,466,112 字节）：
 *   magic = "PMTiles"，version = 3
 *   rootOffset = 127，rootLength = 58
 *   tileDataOffset = 35810，tileDataLength = 22430302
 *   → tileDataOffset + tileDataLength === 文件长度（22466112），严格相等
 * 最后这个等式是最好的完整性信号：**截断、补零、多塞内容都会破坏它**。
 *
 * 注意：PMTiles v3 的末尾 127 字节是 trailer，但**前 7 字节不是 "PMTiles" 魔数**
 * （实测尾部 hex d9ef7e5c…），所以不能用"尾部魔数"判完整性 —— 这个坑已验证过。
 */

const MAGIC = 'PMTiles'

function u64(u8, off) {
  // DataView 的 getBigUint64 在部分老 WebView 不存在，手工按小端拼
  let v = 0
  for (let i = 7; i >= 0; i--) v = v * 256 + u8[off + i]
  return v
}

export function magicOk(u8) {
  if (!u8 || u8.length < 16) return false
  for (let i = 0; i < MAGIC.length; i++) {
    if (u8[i] !== MAGIC.charCodeAt(i)) return false
  }
  return true
}

/**
 * 解析 127/128 字节的文件头
 * @param {Uint8Array} u8 至少 127 字节
 */
export function parsePmtilesHeader(u8) {
  if (!u8 || u8.length < 127) return null
  if (!magicOk(u8)) return null
  return {
    version: u8[7],
    rootOffset: u64(u8, 8),
    rootLength: u64(u8, 16),
    jsonMetadataOffset: u64(u8, 24),
    jsonMetadataLength: u64(u8, 32),
    leafDirectoryOffset: u64(u8, 40),
    leafDirectoryLength: u64(u8, 48),
    tileDataOffset: u64(u8, 56),
    tileDataLength: u64(u8, 64),
    numAddressedTiles: u64(u8, 72),
    numTileEntries: u64(u8, 80),
    numTileContents: u64(u8, 88),
    minZoom: u8[100],
    maxZoom: u8[101],
  }
}

/**
 * 结构校验：头部能解析 + 版本 3 + 各段区间自洽 + 瓦片数据末尾正好等于文件长度。
 * @param {Uint8Array} head 文件头（≥127 字节）
 * @param {number} fileSize 实际文件字节数
 * @param {number} [expectedBytes] 清单里声明的字节数（可选）
 * @returns {{ok:boolean, reason?:string, header?:object}}
 */
export function checkPmtilesStructure(head, fileSize, expectedBytes) {
  if (!head || head.length < 127) return { ok: false, reason: '文件头不足 127 字节（可能被截断）' }
  if (!magicOk(head)) return { ok: false, reason: '头部不是 PMTiles' }
  const h = parsePmtilesHeader(head)
  if (!h) return { ok: false, reason: '头部解析失败' }
  if (h.version !== 3) return { ok: false, reason: '版本不是 3（得到 ' + h.version + '）' }
  if (!(fileSize > 0)) return { ok: false, reason: '文件为空', header: h }
  if (expectedBytes && fileSize !== expectedBytes) {
    return { ok: false, reason: '字节数不符（' + fileSize + ' ≠ ' + expectedBytes + '）', header: h }
  }
  if (!(h.numAddressedTiles > 0)) return { ok: false, reason: '瓦片数为 0（空包）', header: h }
  if (h.rootOffset + h.rootLength > fileSize) {
    return { ok: false, reason: '根目录区间越界', header: h }
  }
  const end = h.tileDataOffset + h.tileDataLength
  if (end > fileSize) return { ok: false, reason: '瓦片数据越界（文件可能被截断）', header: h }
  if (end !== fileSize) {
    return { ok: false, reason: '瓦片数据末尾 ' + end + ' ≠ 文件长度 ' + fileSize, header: h }
  }
  return { ok: true, header: h }
}
