const WIDTH = 960
const MARGIN = 48
const LINE_HEIGHT = 36
const FONT = '24px system-ui, "Microsoft YaHei", sans-serif'

export async function readImageSize(bytes: Uint8Array<ArrayBuffer>): Promise<{ width: number; height: number } | undefined> {
  try {
    const image = await createImageBitmap(new Blob([bytes]))
    const { width, height } = image
    image.close()
    return { width, height }
  } catch { return undefined }
}

export async function renderTextImage(sections: readonly { readonly label: string; readonly text: string }[]): Promise<Blob> {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前环境无法绘制文字图片。')
  context.font = FONT
  const lines: string[] = []
  for (const { label, text } of sections) {
    if (lines.length) lines.push('')
    lines.push(label, '')
    for (const paragraph of text.split(/\r\n?|\n/u)) {
      let line = ''
      for (const character of paragraph) {
        if (context.measureText(line + character).width > WIDTH - MARGIN * 2 && line) {
          lines.push(line)
          line = ''
        }
        line += character
      }
      lines.push(line)
    }
  }
  const height = MARGIN * 2 + lines.length * LINE_HEIGHT
  if (height > 32767) throw new Error('文字过长，无法保存为单张 PNG。')
  canvas.width = WIDTH
  canvas.height = height
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, WIDTH, height)
  context.font = FONT
  context.fillStyle = '#161616'
  context.textBaseline = 'top'
  lines.forEach((line, index) => context.fillText(line, MARGIN, MARGIN + index * LINE_HEIGHT))
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法编码文字图片。')), 'image/png')
  })
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ ((byte & 1) ? 0xedb88320 : 0)
  return byte
})

/** Store original bytes unchanged in a UTF-8 named ZIP. */
export function imageLetteringArchive(format: 'png' | 'jpg' | 'webp', original: Uint8Array<ArrayBuffer>, prompt: string): Blob {
  const encoder = new TextEncoder()
  const entries = [
    { name: encoder.encode(`原图.${format}`), bytes: original },
    { name: encoder.encode('翻嵌提示词.txt'), bytes: encoder.encode(prompt) },
  ]
  const local: BlobPart[] = [], central: BlobPart[] = []
  let offset = 0, directoryBytes = 0
  for (const { name, bytes } of entries) {
    let crc = 0xffffffff
    for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!
    crc ^= 0xffffffff
    const header = new DataView(new ArrayBuffer(30))
    header.setUint32(0, 0x04034b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, 0x0800, true)
    header.setUint16(12, 0x21, true)
    header.setUint32(14, crc, true)
    header.setUint32(18, bytes.byteLength, true)
    header.setUint32(22, bytes.byteLength, true)
    header.setUint16(26, name.byteLength, true)
    local.push(header.buffer, name, bytes)

    const record = new DataView(new ArrayBuffer(46))
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(4, 20, true)
    new Uint8Array(record.buffer).set(new Uint8Array(header.buffer, 4, 26), 6)
    record.setUint32(42, offset, true)
    central.push(record.buffer, name)
    offset += header.byteLength + name.byteLength + bytes.byteLength
    directoryBytes += record.byteLength + name.byteLength
  }
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, directoryBytes, true)
  end.setUint32(16, offset, true)
  return new Blob([...local, ...central, end.buffer], { type: 'application/zip' })
}
