import { parseSourceIdentity, type SourceIdentity } from './translation-sources.js'
import { parseReferenceAssetSelection, referenceExact, referenceInteger, referenceObject, referenceString, type ReferenceAssetSelection } from './reference-memory.js'

/** Effective topic memory matched to the saved image source, for main-model selection. */
export interface ImageTranslationMemory {
  readonly terms: readonly {
    readonly ref: { readonly id: string; readonly entryVersion: number }
    readonly forms: readonly string[]
    readonly preferred: string
    readonly sourceLanguage: string | null
  }[]
  readonly entities: readonly {
    readonly ref: ReferenceAssetSelection
    readonly name: string
    readonly aliases: readonly string[]
  }[]
  readonly topicId: string
  readonly targetLanguage: string
}

export const IMAGE_MEMORY_MATCH_LIMIT = 12

export function parseImageTranslationMemory(value: unknown): ImageTranslationMemory {
  referenceObject(value)
  referenceExact(value, ['topicId', 'terms', 'entities', 'targetLanguage'])
  referenceString(value.topicId)
  referenceString(value.targetLanguage, 80)
  if (!Array.isArray(value.terms) || value.terms.length > IMAGE_MEMORY_MATCH_LIMIT ||
    !Array.isArray(value.entities) || value.entities.length > IMAGE_MEMORY_MATCH_LIMIT) throw new TypeError('Invalid image memory matches')
  const labels = (data: unknown): void => {
    if (!Array.isArray(data) || data.length > 20) throw new TypeError('Invalid image memory labels')
    for (const label of data) referenceString(label, 500)
  }
  for (const term of value.terms) {
    referenceObject(term)
    referenceExact(term, ['ref', 'forms', 'preferred', 'sourceLanguage'])
    referenceObject(term.ref)
    referenceExact(term.ref, ['id', 'entryVersion'])
    referenceString(term.ref.id); referenceInteger(term.ref.entryVersion, 1)
    labels(term.forms); referenceString(term.preferred, 4000)
    if (term.sourceLanguage !== null) referenceString(term.sourceLanguage, 80)
  }
  for (const entity of value.entities) {
    referenceObject(entity)
    referenceExact(entity, ['ref', 'name', 'aliases'])
    const ref = parseReferenceAssetSelection(entity.ref)
    if (ref.kind !== 'entity') throw new TypeError('Invalid image entity match')
    referenceString(entity.name, 500); labels(entity.aliases)
  }
  return structuredClone(value) as unknown as ImageTranslationMemory
}

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
  readonly speakers?: readonly ImageSpeaker[]
  readonly expectedInputId?: string
  readonly recognition?: ImageRecognition
}

export interface ImageSpeaker {
  readonly block: number
  readonly speaker: string | null
}
export interface ImageRecognition {
  readonly status: 'text' | 'empty'
  readonly requirements: string
  readonly unclear?: string
}
export interface ImageUnitState extends ImageInput {
  readonly inputId: string
  readonly topicId: string
  readonly original: SourceIdentity
  readonly recognition?: ImageRecognition
}

export interface ImageInput {
  readonly source: string
  readonly backgroundDescription: string
  readonly speakers?: readonly ImageSpeaker[]
}

export function parseImageUnitState(value: unknown): ImageUnitState {
  const state = value as ImageUnitState
  if (!state || typeof state.inputId !== 'string' || typeof state.topicId !== 'string' || typeof state.source !== 'string' || state.source.length > 400000 ||
    typeof state.backgroundDescription !== 'string' || state.backgroundDescription.length > 4000) throw new TypeError('Invalid image input state')
  return { inputId: state.inputId, topicId: state.topicId, original: parseSourceIdentity(state.original), source: state.source, backgroundDescription: state.backgroundDescription,
    ...(state.speakers === undefined ? {} : { speakers: parseImageSpeakers(state.speakers) }),
    ...(state.recognition === undefined ? {} : { recognition: parseImageRecognition(state.recognition) }) }
}

export function imageInputKey(input: ImageInput): string {
  return JSON.stringify([input.source, input.backgroundDescription, input.speakers ?? []])
}

export function parseImageSpeakers(value: unknown): ImageSpeaker[] {
  if (!Array.isArray(value) || value.length > 250) throw new TypeError('Invalid image speakers')
  const seen = new Set<number>()
  return value.map(item => {
    if (!item || Object.keys(item).length !== 2 || !Number.isSafeInteger(item.block) || item.block < 1 || item.block > 10000 ||
      seen.has(item.block) || !(item.speaker === null || typeof item.speaker === 'string' && item.speaker.trim() && item.speaker.length <= 160)) {
      throw new TypeError('Invalid image dialogue block')
    }
    seen.add(item.block)
    return { block: item.block as number, speaker: item.speaker as string | null }
  }).sort((a, b) => a.block - b.block)
}

export function parseImageRecognition(value: unknown): ImageRecognition {
  const entry = value as ImageRecognition
  if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['status', 'requirements', 'unclear'].includes(key)) ||
    !['text', 'empty'].includes(entry.status) || typeof entry.requirements !== 'string' || entry.requirements.length > 8000 ||
    entry.unclear !== undefined && (typeof entry.unclear !== 'string' || entry.unclear.length > 900)) throw new TypeError('Invalid image recognition')
  return { ...entry }
}

export function retainImageSpeakers(previous: string, source: string, speakers: readonly ImageSpeaker[]): readonly ImageSpeaker[] {
  if (previous === source) return speakers
  const before = imageTextBlocks(previous), after = imageTextBlocks(source)
  if (!before || !after) return []
  return speakers.flatMap(({ block, speaker }) => {
    const text = before[block - 1]
    const position = text === undefined ? -1 : after.indexOf(text)
    if (text !== undefined && position >= 0 && after.lastIndexOf(text) === position && before.indexOf(text) === before.lastIndexOf(text)) {
      return [{ block: position + 1, speaker }]
    }
    return before.length === after.length ? [{ block, speaker: null }] : []
  }).filter((entry, _, all) => all.filter(other => other.block === entry.block).length === 1).sort((a, b) => a.block - b.block)
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

export function imageBlockNumber(index: number): string { return String(index + 1).padStart(2, '0') }

export function imageTextBlocks(text: string): string[] | undefined {
  const markers = [...text.matchAll(/^【(\d+)】[ \t]*/gm)]
  if (!markers.length || text.slice(0, markers[0]!.index).trim()) return undefined
  const blocks: string[] = []
  for (const [index, marker] of markers.entries()) {
    if (marker[1] !== imageBlockNumber(index)) return undefined
    const block = text.slice(marker.index + marker[0].length, markers[index + 1]?.index).trim()
    if (!block) return undefined
    blocks.push(block)
  }
  return blocks
}

export function imageLetteringPrompt(source: string, translation: string, size?: { readonly width: number; readonly height: number }): string {
  const outputSizeInstruction = size ? `输出像素（${size.width} × ${size.height} 像素）。` : ''
  const sourceBlocks = imageTextBlocks(source), translationBlocks = imageTextBlocks(translation)
  const pairs = sourceBlocks && translationBlocks?.length === sourceBlocks.length
    ? sourceBlocks.map((block, index) => `【${imageBlockNumber(index)}】\n原文\n${block}\n译文\n${translationBlocks[index]}`) : undefined
  return [
    '请直接用支持参考图编辑的生图工具编辑所附原图，返回一张翻嵌图。缺少原图时先索取，工具不可用时说明限制。',
    `保留完整底图，包括四边和构图。保留原图画面不变。${outputSizeInstruction}若无法按原尺寸输出，优先保留完整画幅和原长宽比。`,
    '用原文定位，只擦净待替换的旧字、描边和注音（含未转写的注音），补齐它们遮住的线条和纹理。保留未译文字、气泡的轮廓、填充和透明度，让气泡下的画面保持连续。',
    '将给定译文逐字嵌回对应位置，保留标点。可在气泡内自行调整字号、字距和断行，使文字清晰且排版自然。出图前按阅读顺序连读每处文字，包括换行和换列的衔接处，核对它与对应译文逐字一致。',
    ...(pairs ? ['以下按阅读顺序逐块给出原文和译文。每个编号对应一处文字，编号只供定位。', ...pairs]
      : ['当前原文：\n' + source, '给定译文：\n' + translation]),
  ].join('\n\n')
}
