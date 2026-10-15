/** Reference inputs are distinct from admitted translation sources. */
export const REFERENCE_PROTOCOL = 1 as const
export const REFERENCE_PAGE_BYTES = 32768
export const REFERENCE_PAGE_POINTS = 4000
export const REFERENCE_DOCUMENT_BYTES = 8 * 1024 * 1024
export const REFERENCE_TOPIC_BYTES = 64 * 1024 * 1024
export const REFERENCE_NAMESPACE_BYTES = 256 * 1024 * 1024
export interface ReferenceScope {
  readonly namespaceId: string; readonly ownerId: string; readonly topicId: string; readonly generation: number
}
export interface ReferenceInput {
  readonly messageSeq: number; readonly messageId: string; readonly blockIndex: number
  readonly kind: 'file' | 'image'; readonly attachmentId: string; readonly name: string
  readonly bytes: number; readonly mediaType: string | null
}
export interface ReferenceSegment {
  readonly id: string; readonly version: 1; readonly text: string; readonly locator: string
  readonly interpretation: 'model_interpreted' | 'uncertain'
}
export interface ReferenceDocument {
  readonly id: string; readonly version: 1; readonly input: ReferenceInput; readonly purpose: string
  readonly state: 'extracting' | 'ready' | 'partial' | 'revoked'; readonly revision: number
  readonly reviewed: boolean; readonly coverage: string; readonly unresolved: string
  readonly segments: readonly ReferenceSegment[]; readonly createdAt: string
}
export interface ReferenceSummary extends Omit<ReferenceDocument, 'segments'> {
  readonly segmentCount: number; readonly textBytes: number
}
export interface ReferenceIndex {
  readonly schemaVersion: 1; readonly scope: ReferenceScope; readonly version: number
  readonly documents: readonly ReferenceSummary[]
}
export interface ReferenceFacts {
  readonly index: ReferenceIndex; readonly rememberHistory: boolean; readonly topicName: string
}
export interface ReferenceEvidenceRef {
  readonly kind: 'reference'; readonly referenceId: string; readonly referenceVersion: 1
  readonly segmentId: string; readonly segmentVersion: 1
  readonly range: { readonly start: number; readonly end: number } | null
  readonly role: 'basis' | 'example'
}
export interface ReferenceReadRequest {
  readonly scope: ReferenceScope; readonly referenceId: string; readonly segmentId: string
  readonly referenceVersion: 1; readonly segmentVersion: 1
  readonly range: { readonly start: number; readonly end: number } | null
}
export interface ReferenceText {
  readonly request: ReferenceReadRequest; readonly text: string; readonly locator: string
  readonly interpretation: 'model_interpreted' | 'uncertain'; readonly reviewed: boolean
}
export interface FrozenReferenceContext {
  readonly scope: ReferenceScope
  readonly manifestRef: ReferenceContextRef
  readonly assets: readonly ReferenceContextAsset[]
  readonly excerpts: readonly ReferenceText[]
}
export interface ReferenceContextRef { readonly id: string; readonly version: 1 }
export interface ReferenceAssetSelection { readonly kind: 'entity' | 'fact' | 'relation'; readonly id: string; readonly version: number; readonly purpose: 'background' | 'translation_guidance' }
export interface ReferenceContextAsset extends ReferenceAssetSelection { readonly content: string }
export interface ReferenceManifest {
  readonly id: string; readonly version: 1; readonly scope: ReferenceScope
  readonly assets: readonly ReferenceContextAsset[]; readonly references: readonly ReferenceEvidenceRef[]
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
  referenceObject(value); referenceExact(value, ['id', 'version', 'scope', 'assets', 'references'])
  parseReferenceContextRef({ id: value.id, version: value.version }); parseReferenceScope(value.scope)
  if (!Array.isArray(value.assets) || value.assets.length > 100 || !Array.isArray(value.references) || value.references.length > 100) throw new TypeError('Reference selection exceeds budget')
  value.assets.forEach(parseReferenceContextAsset); value.references.forEach(parseReferenceEvidence)
  return structuredClone(value) as unknown as ReferenceManifest
}
/** Only Host-resolved, bounded selections enter an isolated model request. */
export function referencePayload(context: FrozenReferenceContext | undefined): Record<string, unknown> {
  return context ? { background_assets: context.assets, reference_excerpts: context.excerpts.map(excerpt => ({
    reference: excerpt.request, locator: excerpt.locator, interpretation: excerpt.interpretation, text: excerpt.text,
  })) } : {}
}
export interface ReferenceEvidencePort {
  cached?(scope: { readonly ownerId: string; readonly topicId: string }, ref: ReferenceEvidenceRef): string | undefined
  resolve(scope: { readonly ownerId: string; readonly topicId: string }, ref: ReferenceEvidenceRef): Promise<{ readonly text?: string; readonly unloaded: boolean; isCurrent(): boolean }>
  view?(scope: { readonly ownerId: string; readonly topicId: string }, ref: ReferenceEvidenceRef): Promise<ReferenceText | undefined>
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
export function parseReferenceInput(value: unknown): ReferenceInput {
  referenceObject(value); referenceExact(value, ['messageSeq', 'messageId', 'blockIndex', 'kind', 'attachmentId', 'name', 'bytes', 'mediaType'])
  referenceInteger(value.messageSeq); referenceInteger(value.blockIndex); referenceInteger(value.bytes)
  for (const key of ['messageId', 'attachmentId', 'name']) referenceString(value[key])
  if (!['file', 'image'].includes(String(value.kind))) throw new TypeError('Invalid reference input kind')
  if (value.mediaType !== null) referenceString(value.mediaType, 200)
  return structuredClone(value) as unknown as ReferenceInput
}
export function parseReferenceEvidence(value: unknown): ReferenceEvidenceRef {
  referenceObject(value); referenceExact(value, ['kind', 'referenceId', 'referenceVersion', 'segmentId', 'segmentVersion', 'range', 'role'])
  if (value.kind !== 'reference' || value.referenceVersion !== 1 || value.segmentVersion !== 1 || !['basis', 'example'].includes(String(value.role))) throw new TypeError('Invalid reference evidence')
  referenceString(value.referenceId); referenceString(value.segmentId)
  if (value.range !== null) {
    referenceObject(value.range); referenceExact(value.range, ['start', 'end']); referenceInteger(value.range.start); referenceInteger(value.range.end, 1)
    if (value.range.end <= value.range.start) throw new TypeError('Invalid reference range')
  }
  return structuredClone(value) as unknown as ReferenceEvidenceRef
}
export function parseReferenceDocument(value: unknown): ReferenceDocument {
  referenceObject(value); referenceExact(value, ['id', 'version', 'input', 'purpose', 'state', 'revision', 'reviewed', 'coverage', 'unresolved', 'segments', 'createdAt'])
  referenceString(value.id); parseReferenceInput(value.input); referenceString(value.purpose, 4000); referenceInteger(value.revision, 1)
  if (value.version !== 1 || typeof value.reviewed !== 'boolean' || !['extracting', 'ready', 'partial', 'revoked'].includes(String(value.state))) throw new TypeError('Invalid reference document state')
  referenceString(value.coverage, 4000, true); referenceString(value.unresolved, 4000, true); referenceString(value.createdAt, 80)
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.segments) || value.segments.length > 4096) throw new TypeError('Invalid reference segments')
  const ids = new Set<string>(); let bytes = 0
  for (const segment of value.segments) {
    referenceObject(segment); referenceExact(segment, ['id', 'version', 'text', 'locator', 'interpretation'])
    referenceString(segment.id); referenceString(segment.text, REFERENCE_PAGE_POINTS); referenceString(segment.locator, 1000)
    if (ids.has(segment.id) || segment.version !== 1 || !['model_interpreted', 'uncertain'].includes(String(segment.interpretation))) throw new TypeError('Invalid reference segment')
    ids.add(segment.id); bytes += referenceBytes(segment.text)
  }
  if (bytes > REFERENCE_DOCUMENT_BYTES) throw new TypeError('Reference document exceeds budget')
  return structuredClone(value) as unknown as ReferenceDocument
}
export function summarizeReference(value: ReferenceDocument): ReferenceSummary {
  const { segments, ...metadata } = value
  return { ...metadata, segmentCount: segments.length, textBytes: segments.reduce((sum, segment) => sum + referenceBytes(segment.text), 0) }
}
export function parseReferenceIndex(value: unknown): ReferenceIndex {
  referenceObject(value); referenceExact(value, ['schemaVersion', 'scope', 'version', 'documents']); parseReferenceScope(value.scope); referenceInteger(value.version)
  if (value.schemaVersion !== 1 || !Array.isArray(value.documents) || value.documents.length > 32) throw new TypeError('Invalid reference index')
  const ids = new Set<string>()
  for (const metadata of value.documents) {
    referenceObject(metadata); const { segmentCount, textBytes, ...doc } = metadata
    parseReferenceDocument({ ...doc, segments: [] }); referenceInteger(segmentCount); referenceInteger(textBytes)
    if ((segmentCount as number) > 4096 || (textBytes as number) > REFERENCE_DOCUMENT_BYTES || ids.has(doc.id as string)) throw new TypeError('Invalid reference summary')
    ids.add(doc.id as string)
  }
  return structuredClone(value) as unknown as ReferenceIndex
}
export function parseReferenceFacts(value: unknown): ReferenceFacts {
  referenceObject(value); referenceExact(value, ['index', 'rememberHistory', 'topicName']); parseReferenceIndex(value.index); referenceString(value.topicName)
  if (typeof value.rememberHistory !== 'boolean') throw new TypeError('Invalid reference persistence')
  return structuredClone(value) as unknown as ReferenceFacts
}
export function parseReferenceRead(value: unknown): ReferenceReadRequest {
  referenceObject(value); referenceExact(value, ['scope', 'referenceId', 'segmentId', 'referenceVersion', 'segmentVersion', 'range']); parseReferenceScope(value.scope)
  const { scope: _scope, ...evidence } = value
  parseReferenceEvidence({ ...evidence, kind: 'reference', role: 'basis' })
  return structuredClone(value) as unknown as ReferenceReadRequest
}
export function parseReferenceText(value: unknown): ReferenceText {
  referenceObject(value); referenceExact(value, ['request', 'text', 'locator', 'interpretation', 'reviewed']); parseReferenceRead(value.request)
  referenceString(value.text, REFERENCE_PAGE_POINTS); referenceString(value.locator, 1000)
  if (!['model_interpreted', 'uncertain'].includes(String(value.interpretation)) || typeof value.reviewed !== 'boolean' || referenceBytes(value) > REFERENCE_PAGE_BYTES) throw new TypeError('Invalid reference page')
  return structuredClone(value) as unknown as ReferenceText
}
export interface ReferenceRemotePort {
  readRemote(request: ReferenceReadRequest): Promise<unknown>
  clearRemote(request: ReferenceScope): Promise<unknown>
  persistRemote(request: ReferenceScope): Promise<unknown>
}
const packageName = 'dsh-translation-plugin'
const codec = (name: string, parse: (value: unknown) => unknown) => ({ mode: 'strict' as const, typeSymbol: `${packageName}#references/${name}`, create: () => ({ parse }) })
export const REFERENCE_REMOTE = { package: packageName, descriptors: [
  { id: `${packageName}#translationReferences/persistRemote`, service: 'translationReferences', namespace: 'translationReferences', method: 'persistRemote',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('scope', parseReferenceScope) }], result: codec('persisted', value => {
      referenceObject(value); referenceExact(value, ['persisted']); if (value.persisted !== true) throw new TypeError('Invalid reference persistence result'); return { persisted: true }
    }) },
  { id: `${packageName}#translationReferences/readRemote`, service: 'translationReferences', namespace: 'translationReferences', method: 'readRemote',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('read', parseReferenceRead) }], result: codec('text', parseReferenceText) },
  { id: `${packageName}#translationReferences/clearRemote`, service: 'translationReferences', namespace: 'translationReferences', method: 'clearRemote',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('scope', parseReferenceScope) }], result: codec('cleared', value => {
      referenceObject(value); referenceExact(value, ['cleared']); if (value.cleared !== true) throw new TypeError('Invalid reference clear result'); return { cleared: true }
    }) },
] }
