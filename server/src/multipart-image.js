const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function parseDisposition(value) {
  const name = /(?:^|;)\s*name="([^"]+)"/i.exec(value || '')?.[1]
  const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(value || '')?.[1]
  return { name, filename }
}

export function parseImageUpload(contentType, body) {
  const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''))
  const boundaryValue = boundary && (boundary[1] || boundary[2])
  if (!boundaryValue || boundaryValue.length > 70 || !Buffer.isBuffer(body)) {
    throw Object.assign(new Error('上传格式不正确'), { code: 'BAD_UPLOAD' })
  }
  const delimiter = Buffer.from(`--${boundaryValue}`)
  const separator = Buffer.from('\r\n\r\n')
  const imageDelimiter = Buffer.from(`\r\n--${boundaryValue}`)
  const fields = {}
  let imageBuffer = null
  let offset = body.indexOf(delimiter)

  if (offset !== 0) throw Object.assign(new Error('上传格式不正确'), { code: 'BAD_UPLOAD' })
  while (offset >= 0) {
    offset += delimiter.length
    if (body.subarray(offset, offset + 2).toString() === '--') break
    if (body.subarray(offset, offset + 2).toString() !== '\r\n') {
      throw Object.assign(new Error('上传格式不正确'), { code: 'BAD_UPLOAD' })
    }
    offset += 2
    const headerEnd = body.indexOf(separator, offset)
    if (headerEnd < 0) throw Object.assign(new Error('上传格式不正确'), { code: 'BAD_UPLOAD' })
    const headers = body.subarray(offset, headerEnd).toString('utf8')
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headers)?.[1]
    const { name, filename } = parseDisposition(disposition)
    const dataStart = headerEnd + separator.length
    const nextDelimiter = body.indexOf(imageDelimiter, dataStart)
    if (nextDelimiter < 0) throw Object.assign(new Error('上传格式不正确'), { code: 'BAD_UPLOAD' })
    const part = body.subarray(dataStart, nextDelimiter)
    if (filename !== undefined) {
      if (name !== 'image' || imageBuffer) throw Object.assign(new Error('只允许上传一张图片'), { code: 'BAD_UPLOAD' })
      if (!part.length || part.length > MAX_IMAGE_BYTES) {
        throw Object.assign(new Error('图片大小需在 1B 至 8MB 之间'), { code: 'IMAGE_SIZE' })
      }
      imageBuffer = Buffer.from(part)
    } else if (name) {
      if (!['settings', 'taskType'].includes(name) || part.length > 4096) {
        throw Object.assign(new Error('上传字段不受支持'), { code: 'BAD_UPLOAD' })
      }
      fields[name] = part.toString('utf8')
    }
    offset = nextDelimiter + 2
  }
  if (!imageBuffer) throw Object.assign(new Error('没有收到图片文件'), { code: 'BAD_UPLOAD' })
  return { imageBuffer, fields }
}

export function validateImageSignature(imageBuffer) {
  const png = imageBuffer.length >= 8 && imageBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = imageBuffer.length >= 3 && imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff
  const webp = imageBuffer.length >= 12 && imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP'
  if (!png && !jpeg && !webp) {
    throw Object.assign(new Error('仅支持 JPEG、PNG 或 WebP 图片'), { code: 'IMAGE_TYPE' })
  }
}
