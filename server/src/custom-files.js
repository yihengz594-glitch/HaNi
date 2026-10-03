import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertStorageConfigured, CustomError } from './custom-rules.js'

export const MAX_CUSTOM_FILE_BYTES = 15 * 1024 * 1024

export function parseCustomMultipart(contentType, body) {
  const match = /(?:^|;)\s*boundary=(?:"([^";]+)"|([^;\s]+))/i.exec(String(contentType || ''))
  const boundary = match?.[1] || match?.[2]
  if (!boundary || boundary.length > 70 || !Buffer.isBuffer(body)) throw new CustomError('上传格式无效')
  const begin = Buffer.from(`--${boundary}\r\n`)
  const separator = Buffer.from('\r\n\r\n')
  const end = Buffer.from(`\r\n--${boundary}--`)
  if (!body.subarray(0, begin.length).equals(begin)) throw new CustomError('上传格式无效')
  const headerEnd = body.indexOf(separator, begin.length)
  if (headerEnd < 0 || headerEnd > 2048) throw new CustomError('上传文件头无效')
  const headers = body.subarray(begin.length, headerEnd).toString('utf8')
  if (!/content-disposition:\s*form-data;[^\r\n]*name="file";[^\r\n]*filename="[^"]*"/i.test(headers)) {
    throw new CustomError('请上传一个 file 图片字段')
  }
  const endAt = body.indexOf(end, headerEnd + separator.length)
  const tail = endAt < 0 ? '' : body.subarray(endAt + end.length).toString('ascii')
  if (endAt < 0 || (tail !== '' && tail !== '\r\n')) throw new CustomError('只允许上传一个图片文件')
  const file = body.subarray(headerEnd + separator.length, endAt)
  if (!file.length || file.length > MAX_CUSTOM_FILE_BYTES) throw new CustomError('图片须在 15MB 以内')
  return file
}

function jpegDimensions(buffer) {
  if (buffer.length < 12 || buffer[0] !== 255 || buffer[1] !== 216 ||
      buffer[buffer.length - 2] !== 255 || buffer[buffer.length - 1] !== 217) return null
  let pos = 2
  while (pos + 4 < buffer.length) {
    if (buffer[pos++] !== 255) return null
    while (pos < buffer.length && buffer[pos] === 255) pos += 1
    if (pos + 2 >= buffer.length) return null
    const marker = buffer[pos++]
    if (marker === 218) break
    if (marker === 217 || marker === 0 || (marker >= 208 && marker <= 215)) return null
    const length = buffer.readUInt16BE(pos)
    if (length < 2 || pos + length > buffer.length) return null
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 7) return null
      return { width: buffer.readUInt16BE(pos + 5), height: buffer.readUInt16BE(pos + 3) }
    }
    pos += length
  }
  return null
}

function pngDimensions(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) return null
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  let pos = 8
  let ended = false
  while (pos + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(pos)
    if (length > buffer.length - pos - 12) return null
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    pos += 12 + length
    if (type === 'IEND') { ended = length === 0 && pos === buffer.length; break }
  }
  return ended ? { width, height } : null
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length) return null
  const type = buffer.toString('ascii', 12, 16)
  const length = buffer.readUInt32LE(16)
  if (20 + length > buffer.length) return null
  if (type === 'VP8X' && length >= 10) {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
  }
  if (type === 'VP8 ' && length >= 10 && buffer[23] === 0x9d && buffer[24] === 1 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  if (type === 'VP8L' && length >= 5 && buffer[20] === 0x2f) {
    return { width: 1 + (buffer[21] | (buffer[22] & 0x3f) << 8),
      height: 1 + ((buffer[22] >> 6) | buffer[23] << 2 | (buffer[24] & 0x0f) << 10) }
  }
  return null
}

export async function validateCustomImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_CUSTOM_FILE_BYTES) throw new CustomError('图片须在15MB以内')
  const png = pngDimensions(buffer)
  const jpeg = png ? null : jpegDimensions(buffer)
  const webp = png || jpeg ? null : webpDimensions(buffer)
  const size = png || jpeg || webp
  if (!size) throw new CustomError('仅支持结构完整的 JPEG、PNG、WebP 图片')
  if (!size.width || !size.height || size.width > 12000 || size.height > 12000 || size.width * size.height > 40000000) {
    throw new CustomError('图片像素尺寸超出安全范围')
  }
  return png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp'
}

export async function writePrivateFile(buffer) {
  const root = assertStorageConfigured()
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await fs.stat(root)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('私有文件目录权限必须为 0700')
  const key = crypto.randomBytes(32).toString('hex')
  const target = path.join(root, key)
  await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o600 })
  return { key, sha256: crypto.createHash('sha256').update(buffer).digest('hex') }
}

export async function removePrivateFile(key) {
  if (!/^[a-f0-9]{64}$/.test(String(key || ''))) throw new Error('文件键无效')
  await fs.unlink(path.join(assertStorageConfigured(), key)).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export async function readPrivateFile(key) {
  if (!/^[a-f0-9]{64}$/.test(String(key || ''))) throw new Error('文件键无效')
  return fs.readFile(path.join(assertStorageConfigured(), key))
}
