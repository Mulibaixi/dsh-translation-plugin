export interface ImageUnitTarget {
  readonly kind: 'image_unit'
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly unitId: string
  readonly sourceVersion?: never
}

export interface ImageUnitUpdate {
  readonly target: ImageUnitTarget
  readonly operationId: string
  readonly sourceText?: string
  readonly backgroundDescription?: string
}

export const IMAGE_BACKGROUND_LIMIT = 2000
export const MAX_IMAGE_ORIGINAL_BYTES = 50 * 1024 * 1024

export function matchesImageOriginal(format: NonNullable<ReturnType<typeof imageFileFormat>>, bytes: Uint8Array): boolean {
  if (format === 'png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  if (format === 'jpg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const marker = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.length < 21 || marker(0) !== 'RIFF' || marker(8) !== 'WEBP') return false
  const chunk = marker(12)
  return chunk === 'VP8 ' || chunk === 'VP8L' || chunk === 'VP8X' && !(bytes[20]! & 0x02)
}
export function imageFileFormat(name: string): 'png' | 'jpg' | 'webp' | undefined {
  if (/\.png$/iu.test(name)) return 'png'
  if (/\.jpe?g$/iu.test(name)) return 'jpg'
  if (/\.webp$/iu.test(name)) return 'webp'
  return undefined
}

export function imageLetteringPrompt(source: string, translation: string, size?: { readonly width: number; readonly height: number }): string {
  const outputSizeInstruction = size ? `输出像素（${size.width} × ${size.height} 像素）。` : ''
  return [
    '请直接用支持参考图编辑的生图工具编辑所附原图，返回一张翻嵌图。缺少原图时先索取，工具不可用时说明限制。',
    `保留完整底图，包括四边和构图。保留原图画面不变。${outputSizeInstruction}若无法按原尺寸输出，优先保留完整画幅和原长宽比。`,
    '用原文定位，只擦净待替换的旧字、描边和注音（含未转写的注音），补齐它们遮住的线条和纹理。保留未译文字、气泡的轮廓、填充和透明度，让气泡下的画面保持连续。',
    '将给定译文逐字嵌回对应位置，保留标点。可在气泡内自行调整字号、字距和断行，使文字清晰且排版自然。出图前按阅读顺序连读每处文字，包括换行和换列的衔接处，核对它与对应译文逐字一致。',
    '当前原文：\n' + source,
    '给定译文：\n' + translation,
  ].join('\n\n')
}
