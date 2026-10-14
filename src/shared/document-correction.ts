import { parseTranslationSourceScope, type TranslationSourceScope } from './translation-sources.js'
import { parseDocumentCallContextReference, parseDocumentSourceVersion, type DocumentCallContextReference,
  type DocumentSourceVersion, type VersionReference } from './translation-batch.js'
import { sourceCodePointLength, type TranslationSourceRange } from './translation-source-read.js'

export interface DocumentSourcePatch {
  /** Half-open old-source code point range. An empty range inserts at its boundary. */
  readonly range: TranslationSourceRange
  readonly replacementText: string
}
export interface DocumentCorrectionMapping {
  readonly oldRange: TranslationSourceRange
  readonly newRange: TranslationSourceRange
  readonly replacementSha256: string
}
export interface TranslationBatchCorrection {
  readonly scope: TranslationSourceScope
  readonly unitId: string
  readonly expectedSourceVersion: number
  readonly operationId: string
  readonly patches: readonly DocumentSourcePatch[]
}
export interface DocumentCorrectionFact {
  readonly operationId: string
  readonly fromSourceVersion: number
  readonly toSourceVersion: number
  readonly oldLength: number
  readonly newLength: number
  readonly mappings: readonly DocumentCorrectionMapping[]
  readonly createdAt: string
}
export interface DocumentCorrectionCommit {
  readonly scope: TranslationSourceScope
  readonly unitId: string
  readonly expectedSourceVersion: number
  readonly source: DocumentSourceVersion
  readonly fact: DocumentCorrectionFact
}
export interface DocumentCorrectionReceipt {
  readonly scope: TranslationSourceScope
  readonly unitId: string
  readonly operationId: string
  readonly sourceVersion: number
  readonly storage: 'saved' | 'runtime_only'
  readonly storageError: string | null
}
/** Main-model decision identifies an original complete revision, never a replacement body. */
export interface DocumentReuseRequest {
  readonly chunkId: string
  readonly sourceVersion: number
  readonly planRef: VersionReference
  readonly revisionId: string
  readonly basis: string
}
export interface DocumentReuseDependencyEvidence {
  readonly sourceVersion: number
  readonly sourceSha256: string
  readonly outputRange: TranslationSourceRange
  readonly outputSha256: string
  readonly contextRef: DocumentCallContextReference
  readonly contextSha256: string
  readonly rulesSha256: string
  readonly protectionSha256: string
}
/** Created only after Host reads and compares both actual sources and frozen dependencies. */
export interface DocumentReuseApproval {
  readonly id: string
  readonly operationId: string
  readonly createdAt: string
  readonly chunkId: string
  readonly sourceVersion: number
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly reuseRef: { readonly sourceVersion: number; readonly planVersion: number; readonly revisionId: string }
  readonly basis: string
  readonly evidence: { readonly previous: DocumentReuseDependencyEvidence; readonly current: DocumentReuseDependencyEvidence }
}

type Data = Record<string, unknown>
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected document correction fields')
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TypeError('Invalid document correction number')
}
function text(value: unknown, maximum = 2048, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || sourceCodePointLength(value) > maximum || /[\uD800-\uDFFF]/u.test(value)) throw new TypeError('Invalid document correction text')
}
function time(value: unknown): asserts value is string { text(value, 40); if (!Number.isFinite(Date.parse(value))) throw new TypeError('Invalid document correction time') }
function range(value: unknown, empty = false, maximum = Number.MAX_SAFE_INTEGER): TranslationSourceRange {
  exact(value, ['start', 'end']); integer(value.start, 0, maximum); integer(value.end, value.start + (empty ? 0 : 1), maximum)
  return { start: value.start, end: value.end }
}
function ref(value: unknown): VersionReference { exact(value, ['id', 'version']); text(value.id); integer(value.version); return { id: value.id, version: value.version } }
function digest(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError('Invalid document correction checksum') }
function list(value: unknown, maximum = 256): asserts value is unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new TypeError('Invalid document correction list') }
function budget(value: unknown): void { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 196608) throw new TypeError('Document correction packet exceeds transport budget') }
export function parseDocumentSourcePatches(value: unknown, maximum = Number.MAX_SAFE_INTEGER): readonly DocumentSourcePatch[] {
  list(value)
  if (!value.length) throw new TypeError('Document correction needs an explicit patch')
  const patches = value.map(raw => {
    exact(raw, ['range', 'replacementText']); text(raw.replacementText, 2_000_000, true)
    const parsed = range(raw.range, true, maximum)
    if (parsed.start === parsed.end && !raw.replacementText) throw new TypeError('Empty insertion does not correct source')
    return { range: parsed, replacementText: raw.replacementText }
  }).sort((left, right) => left.range.start - right.range.start || left.range.end - right.range.end)
  for (let index = 1; index < patches.length; index++) {
    const previous = patches[index - 1]!.range, current = patches[index]!.range
    if (current.start < previous.end || current.start === previous.start) throw new TypeError('Document correction patches overlap or share an insertion boundary')
  }
  return patches
}
export function parseTranslationBatchCorrection(value: unknown): TranslationBatchCorrection {
  budget(value); exact(value, ['scope', 'unitId', 'expectedSourceVersion', 'operationId', 'patches'])
  text(value.unitId); text(value.operationId); integer(value.expectedSourceVersion)
  return { scope: parseTranslationSourceScope(value.scope), unitId: value.unitId, expectedSourceVersion: value.expectedSourceVersion,
    operationId: value.operationId, patches: parseDocumentSourcePatches(value.patches) }
}
export function parseDocumentCorrectionFact(value: unknown): DocumentCorrectionFact {
  exact(value, ['operationId', 'fromSourceVersion', 'toSourceVersion', 'oldLength', 'newLength', 'mappings', 'createdAt'])
  text(value.operationId); integer(value.fromSourceVersion); integer(value.toSourceVersion); integer(value.oldLength); integer(value.newLength); time(value.createdAt); list(value.mappings)
  if (value.toSourceVersion !== value.fromSourceVersion + 1 || !value.mappings.length) throw new TypeError('Invalid document correction source transition')
  const oldLength = value.oldLength, newLength = value.newLength
  let delta = 0, end = -1, start = -1
  const mappings = value.mappings.map(raw => {
    exact(raw, ['oldRange', 'newRange', 'replacementSha256']); digest(raw.replacementSha256)
    const oldRange = range(raw.oldRange, true, oldLength), newRange = range(raw.newRange, true, newLength)
    if (oldRange.start < end || oldRange.start === start || newRange.start !== oldRange.start + delta) throw new TypeError('Document correction mapping is inconsistent')
    end = oldRange.end; start = oldRange.start; delta += newRange.end - newRange.start - (oldRange.end - oldRange.start)
    return { oldRange, newRange, replacementSha256: raw.replacementSha256 }
  })
  if (value.oldLength + delta !== value.newLength) throw new TypeError('Document correction mapping length changed')
  return { operationId: value.operationId, fromSourceVersion: value.fromSourceVersion, toSourceVersion: value.toSourceVersion,
    oldLength: value.oldLength, newLength: value.newLength, mappings, createdAt: value.createdAt }
}
export function parseDocumentCorrectionCommit(value: unknown): DocumentCorrectionCommit {
  budget(value); exact(value, ['scope', 'unitId', 'expectedSourceVersion', 'source', 'fact']); text(value.unitId); integer(value.expectedSourceVersion)
  const source = parseDocumentSourceVersion(value.source), fact = parseDocumentCorrectionFact(value.fact)
  if (source.version !== fact.toSourceVersion || source.operationId !== fact.operationId || value.expectedSourceVersion !== fact.fromSourceVersion || source.createdAt !== fact.createdAt) throw new TypeError('Document correction commit identities changed')
  return { scope: parseTranslationSourceScope(value.scope), unitId: value.unitId, expectedSourceVersion: value.expectedSourceVersion, source, fact }
}
export function parseDocumentCorrectionReceipt(value: unknown): DocumentCorrectionReceipt {
  exact(value, ['scope', 'unitId', 'operationId', 'sourceVersion', 'storage', 'storageError']); text(value.unitId); text(value.operationId); integer(value.sourceVersion)
  if (!['saved', 'runtime_only'].includes(String(value.storage))) throw new TypeError('Invalid document correction storage')
  if (value.storageError !== null) text(value.storageError, 2048)
  return { scope: parseTranslationSourceScope(value.scope), unitId: value.unitId, operationId: value.operationId, sourceVersion: value.sourceVersion,
    storage: value.storage as DocumentCorrectionReceipt['storage'], storageError: value.storageError as string | null }
}
export function parseDocumentReuseRequest(value: unknown): DocumentReuseRequest {
  exact(value, ['chunkId', 'sourceVersion', 'planRef', 'revisionId', 'basis']); text(value.chunkId); integer(value.sourceVersion); text(value.revisionId); text(value.basis, 1000)
  return { chunkId: value.chunkId, sourceVersion: value.sourceVersion, planRef: ref(value.planRef), revisionId: value.revisionId, basis: value.basis }
}
export function parseDocumentReuseRequests(value: unknown): readonly DocumentReuseRequest[] {
  list(value); const requests = value.map(parseDocumentReuseRequest)
  if (new Set(requests.map(request => request.chunkId)).size !== requests.length || new Set(requests.map(request => request.revisionId)).size !== requests.length) throw new TypeError('Duplicate document reuse approval')
  return requests
}
function evidence(value: unknown): DocumentReuseDependencyEvidence {
  exact(value, ['sourceVersion', 'sourceSha256', 'outputRange', 'outputSha256', 'contextRef', 'contextSha256', 'rulesSha256', 'protectionSha256']); integer(value.sourceVersion)
  for (const key of ['sourceSha256', 'outputSha256', 'contextSha256', 'rulesSha256', 'protectionSha256']) digest(value[key])
  return { sourceVersion: value.sourceVersion, sourceSha256: value.sourceSha256 as string, outputRange: range(value.outputRange), outputSha256: value.outputSha256 as string,
    contextRef: parseDocumentCallContextReference(value.contextRef, Number.MAX_SAFE_INTEGER), contextSha256: value.contextSha256 as string,
    rulesSha256: value.rulesSha256 as string, protectionSha256: value.protectionSha256 as string }
}
export function parseDocumentReuseApproval(value: unknown): DocumentReuseApproval {
  exact(value, ['id', 'operationId', 'createdAt', 'chunkId', 'sourceVersion', 'planRef', 'preparationRef', 'reuseRef', 'basis', 'evidence'])
  text(value.id); text(value.operationId); time(value.createdAt); text(value.chunkId); integer(value.sourceVersion); text(value.basis, 1000)
  exact(value.reuseRef, ['sourceVersion', 'planVersion', 'revisionId']); integer(value.reuseRef.sourceVersion); integer(value.reuseRef.planVersion); text(value.reuseRef.revisionId)
  exact(value.evidence, ['previous', 'current']); const previous = evidence(value.evidence.previous), current = evidence(value.evidence.current)
  if (previous.sourceVersion !== value.reuseRef.sourceVersion || current.sourceVersion !== value.sourceVersion || current.sourceVersion <= previous.sourceVersion ||
    ['outputSha256', 'contextSha256', 'rulesSha256', 'protectionSha256'].some(key => previous[key as keyof DocumentReuseDependencyEvidence] !== current[key as keyof DocumentReuseDependencyEvidence])) throw new TypeError('Document reuse dependencies were not verified equal')
  return { id: value.id, operationId: value.operationId, createdAt: value.createdAt, chunkId: value.chunkId, sourceVersion: value.sourceVersion,
    planRef: ref(value.planRef), preparationRef: ref(value.preparationRef), reuseRef: { sourceVersion: value.reuseRef.sourceVersion, planVersion: value.reuseRef.planVersion, revisionId: value.reuseRef.revisionId }, basis: value.basis, evidence: { previous, current } }
}
