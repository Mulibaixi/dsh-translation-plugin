/** Reference inputs are distinct from admitted translation sources. */
export const REFERENCE_PAGE_BYTES = 32768
export const REFERENCE_PAGE_POINTS = 4000
export const REFERENCE_TOPIC_BYTES = 64 * 1024 * 1024
export const REFERENCE_NAMESPACE_BYTES = 256 * 1024 * 1024
export interface ReferenceScope {
  readonly namespaceId: string; readonly ownerId: string; readonly topicId: string; readonly generation: number
}
export interface ReferenceInput {
  /** Original main conversation, independent of the shared topic storage anchor. */
  readonly mainSessionId?: string
  readonly messageSeq: number; readonly messageId: string; readonly blockIndex: number
  readonly kind: 'file' | 'image'; readonly attachmentId: string; readonly name: string
  readonly bytes: number; readonly mediaType: string | null
}
export interface ReferenceIndex {
  readonly schemaVersion: 1; readonly scope: ReferenceScope; readonly version: number
}
export interface ReferenceFacts {
  readonly index: ReferenceIndex; readonly topicName: string
}
export interface FrozenReferenceContext {
  readonly scope: ReferenceScope
  readonly manifestRef: ReferenceContextRef
  readonly assets: readonly ReferenceContextAsset[]
  readonly files?: readonly ReferenceFileExcerpt[]
  readonly records?: readonly TranslationRecordExcerpt[]
}
export interface TranslationRecordSelection {
  readonly sessionId: string; readonly unitId: string; readonly sourceVersion: number; readonly finalId: string
  readonly sourceRange: { readonly start: number; readonly end: number } | null
  readonly translationRange: { readonly start: number; readonly end: number } | null
  readonly sha256: string
}
export interface TranslationRecordExcerpt {
  readonly selection: TranslationRecordSelection; readonly targetLanguage: string
  readonly source: string | null; readonly translation: string | null
  readonly sourceTotalCodePoints: number; readonly translationTotalCodePoints: number
}
export function parseTranslationRecordSelection(value: unknown): TranslationRecordSelection {
  referenceObject(value); referenceExact(value, ['sessionId', 'unitId', 'sourceVersion', 'finalId', 'sourceRange', 'translationRange', 'sha256'])
  referenceString(value.sessionId, 3000); referenceString(value.unitId); referenceString(value.finalId); referenceInteger(value.sourceVersion, 1)
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new TypeError('Invalid translation record digest')
  let size = 0
  for (const range of [value.sourceRange, value.translationRange]) if (range !== null) {
    referenceObject(range); referenceExact(range, ['start', 'end']); referenceInteger(range.start); referenceInteger(range.end, 1)
    if (range.end <= range.start) throw new TypeError('Invalid translation record range')
    size += range.end - range.start
  }
  if (size < 1 || size > REFERENCE_PAGE_POINTS) throw new RangeError('译例片段总计须为 1～4000 个 Unicode 码点。')
  return structuredClone(value) as unknown as TranslationRecordSelection
}
export function parseTranslationRecordExcerpt(value: unknown): TranslationRecordExcerpt {
  referenceObject(value); referenceExact(value, ['selection', 'targetLanguage', 'source', 'translation', 'sourceTotalCodePoints', 'translationTotalCodePoints'])
  const selection = parseTranslationRecordSelection(value.selection); referenceString(value.targetLanguage, 80)
  referenceInteger(value.sourceTotalCodePoints); referenceInteger(value.translationTotalCodePoints)
  for (const [text, range, total] of [[value.source, selection.sourceRange, value.sourceTotalCodePoints], [value.translation, selection.translationRange, value.translationTotalCodePoints]] as const) {
    if (range === null ? text !== null : typeof text !== 'string' || Array.from(text).length !== range.end - range.start || range.end > (total as number)) throw new TypeError('Invalid translation record excerpt')
  }
  return structuredClone(value) as unknown as TranslationRecordExcerpt
}
/** Exact immutable original and Unicode code-point coordinates, never a guessed bilingual alignment. */
export interface ReferenceFileSelection {
  readonly id: string; readonly version: number; readonly sha256: string
  readonly range: { readonly start: number; readonly end: number }
}
export interface ReferenceFileExcerpt {
  readonly selection: ReferenceFileSelection; readonly name: string; readonly category: 'full_text' | 'reference'
  readonly totalCodePoints: number; readonly text: string
}
export function parseReferenceFileSelection(value: unknown): ReferenceFileSelection {
  referenceObject(value); referenceExact(value, ['id', 'version', 'sha256', 'range'])
  referenceString(value.id); referenceInteger(value.version, 1)
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new TypeError('Invalid reference original digest')
  referenceObject(value.range); referenceExact(value.range, ['start', 'end']); referenceInteger(value.range.start); referenceInteger(value.range.end, 1)
  if (value.range.end <= value.range.start || value.range.end - value.range.start > REFERENCE_PAGE_POINTS) throw new RangeError('参考文件范围须为 1～4000 个 Unicode 码点。')
  return structuredClone(value) as unknown as ReferenceFileSelection
}
export function parseReferenceFileExcerpt(value: unknown): ReferenceFileExcerpt {
  referenceObject(value); referenceExact(value, ['selection', 'name', 'category', 'totalCodePoints', 'text'])
  const selection = parseReferenceFileSelection(value.selection)
  referenceString(value.name, 255); referenceInteger(value.totalCodePoints); referenceString(value.text, REFERENCE_PAGE_POINTS, true)
  if (!['full_text', 'reference'].includes(String(value.category)) || selection.range.end > value.totalCodePoints || Array.from(value.text).length !== selection.range.end - selection.range.start)
    throw new TypeError('Invalid reference file excerpt')
  return structuredClone(value) as unknown as ReferenceFileExcerpt
}
export interface ReferenceContextRef { readonly id: string; readonly version: 1 }
export interface ReferenceAssetSelection { readonly kind: 'entity' | 'fact' | 'relation'; readonly id: string; readonly version: number; readonly purpose: 'background' | 'translation_guidance' }
export interface ReferenceContextAsset extends ReferenceAssetSelection { readonly content: string }
export interface ReferenceManifest {
  readonly id: string; readonly version: 1; readonly scope: ReferenceScope
  readonly assets: readonly ReferenceContextAsset[]
  readonly files?: readonly ReferenceFileExcerpt[]
  readonly records?: readonly TranslationRecordExcerpt[]
}
export function parseReferenceContextRef(value: unknown): ReferenceContextRef {
  referenceObject(value); referenceExact(value, ['id', 'version']); referenceString(value.id)
  if (value.version !== 1) throw new TypeError('Invalid reference context version')
  return { id: value.id, version: 1 }
}
export function parseReferenceAssetSelection(value: unknown): ReferenceAssetSelection {
  referenceObject(value); referenceExact(value, ['kind', 'id', 'version', 'purpose']); referenceString(value.id); referenceInteger(value.version, 1)
  if (!['entity', 'fact', 'relation'].includes(String(value.kind)) || !['background', 'translation_guidance'].includes(String(value.purpose))) throw new TypeError('Invalid reference asset selection')
  return structuredClone(value) as unknown as ReferenceAssetSelection
}
export function parseReferenceContextAsset(value: unknown): ReferenceContextAsset {
  referenceObject(value); const { content, ...selection } = value
  parseReferenceAssetSelection(selection); referenceString(content, 32768)
  return structuredClone(value) as unknown as ReferenceContextAsset
}
export function parseReferenceManifest(value: unknown): ReferenceManifest {
  referenceObject(value); referenceExact(value, ['id', 'version', 'scope', 'assets'], ['files', 'records'])
  parseReferenceContextRef({ id: value.id, version: value.version }); parseReferenceScope(value.scope)
  if (!Array.isArray(value.assets) || value.assets.length > 100) throw new TypeError('Reference selection exceeds budget')
  value.assets.forEach(parseReferenceContextAsset)
  if (value.files !== undefined) {
    if (!Array.isArray(value.files) || value.files.length > 8) throw new TypeError('Reference file selection exceeds budget')
    value.files.forEach(parseReferenceFileExcerpt)
    if (new Set(value.files.map(item => JSON.stringify((item as ReferenceFileExcerpt).selection))).size !== value.files.length) throw new TypeError('Duplicate reference file selection')
  }
  if (value.records !== undefined) {
    if (!Array.isArray(value.records) || value.records.length > 8) throw new TypeError('Translation record selection exceeds budget')
    value.records.forEach(parseTranslationRecordExcerpt)
    if (new Set(value.records.map(item => JSON.stringify((item as TranslationRecordExcerpt).selection))).size !== value.records.length) throw new TypeError('Duplicate translation record selection')
  }
  return structuredClone(value) as unknown as ReferenceManifest
}
/** Only Host-resolved, bounded selections enter an isolated model request. */
export function referencePayload(context: FrozenReferenceContext | undefined): Record<string, unknown> {
  return context ? { background_assets: context.assets, ...(context.files?.length ? { reference_file_excerpts: context.files } : {}), ...(context.records?.length ? { translation_record_excerpts: context.records } : {}) } : {}
}
export function referenceBytes(value: unknown): number { return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength }
export function referenceObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid reference object')
}
export function referenceExact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected reference fields')
}
export function referenceString(value: unknown, max = 2048, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Array.from(value).length > max || value.includes('\0') || new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) !== value) throw new TypeError('Invalid reference text')
}
export function referenceInteger(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError('Invalid reference integer')
}
export function parseReferenceScope(value: unknown): ReferenceScope {
  referenceObject(value); referenceExact(value, ['namespaceId', 'ownerId', 'topicId', 'generation'])
  for (const key of ['namespaceId', 'ownerId', 'topicId']) referenceString(value[key])
  referenceInteger(value.generation)
  return structuredClone(value) as unknown as ReferenceScope
}
export function parseReferenceIndex(value: unknown): ReferenceIndex {
  referenceObject(value); referenceExact(value, ['schemaVersion', 'scope', 'version']); parseReferenceScope(value.scope); referenceInteger(value.version)
  if (value.schemaVersion !== 1) throw new TypeError('Invalid reference context index')
  return structuredClone(value) as unknown as ReferenceIndex
}
export function parseReferenceFacts(value: unknown): ReferenceFacts {
  referenceObject(value); referenceExact(value, ['index', 'topicName']); parseReferenceIndex(value.index); referenceString(value.topicName)
  return structuredClone(value) as unknown as ReferenceFacts
}
export interface ReferenceRemotePort {
  clearRemote(request: ReferenceScope): Promise<unknown>
}
const packageName = 'dsh-translation-plugin'
const codec = (name: string, parse: (value: unknown) => unknown) => ({ mode: 'strict' as const, typeSymbol: `${packageName}#references/${name}`, create: () => ({ parse }) })
export const REFERENCE_REMOTE = { package: packageName, descriptors: [
  { id: `${packageName}#translationReferences/clearRemote`, service: 'translationReferences', namespace: 'translationReferences', method: 'clearRemote',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('scope', parseReferenceScope) }], result: codec('cleared', value => {
      referenceObject(value); referenceExact(value, ['cleared']); if (value.cleared !== true) throw new TypeError('Invalid reference clear result'); return { cleared: true }
    }) },
] }
