import type { TermEvidenceRef } from '../memory/topic-terms.js'
import { documentSourceLength, sameVersionReference, type ChunkPlanItem, type ChunkRevision, type DocumentChunkPlan, type DocumentRevision, type DocumentSourceVersion } from '../shared/translation-batch.js'
import type { EvidenceReadRequest, EvidenceReadResult, EvidenceReadyResult, EvidenceUnavailableResult } from '../shared/translation-evidence.js'
import type { TranslationSourceIntegrityPort } from '../shared/translation-source-integrity.js'
import { MAX_TRANSLATION_SOURCE_PAGE_BYTES, MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength,
  type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { TranslationSourceStoragePort } from '../shared/translation-source-storage.js'
import { parseTranslationSourceResult, toSourceIdentity, translationSourceResultBytes,
  type TranslationSourceScope, type TranslationSourcesPort } from '../shared/translation-sources.js'
import { currentDocumentFinalRevision, currentFinalRevision, isDocumentUnit,
  type TextRevision, type TranslationUnit } from './translation-history.js'
import type { SessionStore } from './session-store.js'

export type EvidenceSessionPort = Pick<SessionStore, 'getSession' | 'getTranslationHistory' | 'getStatus' | 'isSessionDeleted' | 'readStoredSourceRequest'>
export interface TranslationEvidenceReader {
  capture(ownerId: string, topicId: string, ref: TermEvidenceRef): EvidenceReadRequest | EvidenceUnavailableResult
  read(request: EvidenceReadRequest): Promise<EvidenceReadResult>
  isCurrent(request: EvidenceReadRequest): boolean
}
export interface DocumentReadTarget {
  readonly ownerId: string; readonly topicId: string; readonly sessionId: string; readonly unitId: string
  readonly sourceVersion?: number; readonly manifestRevisionId?: string | null
}
export interface DocumentReadBlock extends ChunkPlanItem {
  readonly revisionId: string | null
  readonly revision: ChunkRevision | null
}
/** Content remains in the immutable history records; this handle fixes their identities, not UI selection. */
export interface DocumentReadSnapshot {
  readonly target: DocumentReadTarget & { readonly sourceVersion: number }
  readonly source: DocumentSourceVersion
  readonly manifest: DocumentRevision | null
  readonly plan: DocumentChunkPlan | null
  readonly blocks: readonly DocumentReadBlock[]
  readonly finalRevisionId: string | null
  readonly totalSourceCodePoints: number
  check(): EvidenceUnavailableResult | null
  readSource(range: TranslationSourceRange): Promise<EvidenceReadResult>
  readChunk(revisionId: string, range: TranslationSourceRange): Promise<EvidenceReadResult>
  openOriginal(signal: AbortSignal): Promise<{ readonly status: 'opened' } | EvidenceUnavailableResult>
}
export type DocumentReadHandle = DocumentReadSnapshot
export interface TranslationDocumentReader {
  captureDocument(target: DocumentReadTarget): DocumentReadSnapshot | EvidenceUnavailableResult
}
export interface TranslationSourceReaderOptions {
  readonly sessions: EvidenceSessionPort
  readonly sources?: TranslationSourcesPort
  readonly storage?: TranslationSourceStoragePort
  readonly integrity?: TranslationSourceIntegrityPort
  readonly authorize?: (request: EvidenceReadRequest) => boolean
  readonly maxCachedPages?: number
}
interface Snapshot {
  readonly unit: TranslationUnit
  readonly source: DocumentSourceVersion | { readonly version: number; readonly text: string }
  readonly scope: TranslationSourceScope
  readonly final: DocumentRevision | TextRevision | null
  readonly chunks: readonly ChunkRevision[]
  readonly totalCodePoints: number
  readonly checkFixed?: () => EvidenceUnavailableResult | null
}
interface CacheStamp {
  readonly source: WeakRef<Snapshot['source']>
  readonly final: WeakRef<DocumentRevision | TextRevision> | null
  readonly chunks: readonly WeakRef<ChunkRevision>[]
}
type LoadedText = { readonly text: string } | EvidenceUnavailableResult
function unavailable(request: EvidenceReadRequest | null, status: EvidenceUnavailableResult['status'], reason: string,
  totalCodePoints?: number): EvidenceUnavailableResult {
  return { status, request, reason, ...(totalCodePoints === undefined ? {} : { totalCodePoints }) }
}
function validRange(range: TranslationSourceRange): boolean {
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
/** Slice without making an Array.from copy of an entire document. */
function slicePoints(text: string, range: TranslationSourceRange): string {
  let point = 0, start = -1, offset = 0
  for (const character of text) {
    if (point === range.start) start = offset
    if (point === range.end) return text.slice(start, offset)
    point++; offset += character.length
  }
  return start >= 0 && point === range.end ? text.slice(start, offset) : ''
}
function sourceSame(left: Snapshot['source'], right: Snapshot['source']): boolean {
  if ('text' in left || 'text' in right) return 'text' in left && 'text' in right && left.version === right.version && left.text === right.text
  if (left.version !== right.version || left.body.kind !== right.body.kind) return false
  return left.body.kind === 'inline' && right.body.kind === 'inline' ? left.body.text === right.body.text
    : left.body.kind === 'asset' && right.body.kind === 'asset' && same(left.body.reference, right.body.reference) && same(left.historyCommit, right.historyCommit)
}
function snapshotSame(left: Snapshot, right: Snapshot): boolean {
  if (!sourceSame(left.source, right.source) || !same(left.scope, right.scope) || left.totalCodePoints !== right.totalCodePoints || left.final?.id !== right.final?.id) return false
  if (left.final && right.final && 'text' in left.final && 'text' in right.final && left.final.text !== right.final.text) return false
  return left.chunks.length === right.chunks.length && left.chunks.every((chunk, index) => {
    const current = right.chunks[index]!
    return chunk.id === current.id && chunk.status === current.status && chunk.sourceVersion === current.sourceVersion &&
      (chunk.content.kind === 'text' && current.content.kind === 'text' ? chunk.content.text === current.content.text : same(chunk.content, current.content))
  })
}

/** Exact evidence reads, with only bounded ready pages cached. Temporary failures are never cached. */
export class TranslationSourceReader implements TranslationEvidenceReader, TranslationDocumentReader {
  private readonly pages = new Map<string, { readonly stamp: CacheStamp; readonly result: EvidenceReadyResult }>()
  private readonly sourceLeases = new Set<string>()
  private readonly copyHashes = new Map<string, WeakRef<Snapshot['source']>>()
  private readonly maximum: number
  private disposed = false
  constructor(private readonly options: TranslationSourceReaderOptions) {
    const maximum = options.maxCachedPages ?? 16
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 64) throw new TypeError('Invalid evidence page cache limit')
    this.maximum = maximum
  }
  capture(ownerId: string, topicId: string, ref: TermEvidenceRef): EvidenceReadRequest | EvidenceUnavailableResult {
    const unit = this.options.sessions.getTranslationHistory(ref.sessionId)?.units.find(unit => unit.id === ref.unitId)
    const request: EvidenceReadRequest = { ownerId, topicId, sessionId: ref.sessionId, unitId: ref.unitId,
      sourceVersion: ref.kind === 'source' ? ref.sourceVersion ?? 1 : unit?.sourceVersion ?? 1,
      side: ref.kind, range: ref.range && { ...ref.range }, revisionId: ref.revisionId, selectionEventId: ref.selectionEventId }
    const snapshot = this.inspect(request)
    return 'status' in snapshot ? snapshot : request
  }
  isCurrent(request: EvidenceReadRequest): boolean { return !('status' in this.inspect(request)) }
  captureDocument(target: DocumentReadTarget): DocumentReadSnapshot | EvidenceUnavailableResult {
    target = { ...target }
    const sessions = this.options.sessions, session = sessions.getSession(target.sessionId)
    const unit = sessions.getTranslationHistory(target.sessionId)?.units.find(unit => unit.id === target.unitId)
    const sourceVersion = target.sourceVersion ?? unit?.sourceVersion ?? 1
    const request: EvidenceReadRequest = { ownerId: target.ownerId, topicId: target.topicId, sessionId: target.sessionId,
      unitId: target.unitId, sourceVersion, side: 'source', range: null, revisionId: null, selectionEventId: null }
    if (this.disposed) return unavailable(request, 'unloaded', 'reader_disposed')
    if (!session || sessions.isSessionDeleted(target.sessionId)) return unavailable(request, 'missing', 'session_missing')
    if (session.ownerId !== target.ownerId || session.topicId !== target.topicId || this.options.authorize && !this.options.authorize(request)) return unavailable(request, 'forbidden', 'scope_mismatch')
    if (sessions.getStatus(session.id) === 'conflict') return unavailable(request, 'unloaded', 'history_conflict')
    if (!unit || !isDocumentUnit(unit)) return unavailable(request, 'missing', 'document_missing')
    const source = unit.sourceVersions.find(source => source.version === sourceVersion)
    if (!source) return unavailable(request, 'missing', 'source_version_missing')
    const selected = currentDocumentFinalRevision(unit)
    const manifest = target.manifestRevisionId === undefined ? (selected?.sourceVersion === sourceVersion ? selected : undefined) ?? [...unit.revisions].reverse().find(revision => revision.sourceVersion === sourceVersion) ?? null
      : target.manifestRevisionId === null ? null : unit.revisions.find(revision => revision.id === target.manifestRevisionId) ?? null
    if (target.manifestRevisionId && !manifest || manifest && manifest.sourceVersion !== sourceVersion) return unavailable(request, 'missing', 'manifest_missing')
    const task = [...unit.tasks].reverse().find(task => task.sourceVersion === sourceVersion)
    const plan = manifest ? unit.plans.find(plan => sameVersionReference(plan, manifest.planRef)) ?? null
      : task ? unit.plans.find(plan => sameVersionReference(plan, task.planRef)) ?? null : null
    const blocks: DocumentReadBlock[] = (plan?.items ?? []).map(item => {
      const entry = manifest?.entries.find(entry => entry.chunkId === item.chunkId)
      const revision = entry ? unit.chunkRevisions.find(chunk => chunk.id === entry.revisionId) ?? null : !manifest && task && plan
        ? [...unit.chunkRevisions].reverse().find(chunk => chunk.chunkId === item.chunkId && chunk.taskId === task.taskId && chunk.sourceVersion === sourceVersion &&
          sameVersionReference(chunk.planRef, plan) && sameVersionReference(chunk.preparationRef, task.preparationRef)) ?? null : null
      return { ...item, revisionId: revision?.id ?? null, revision }
    })
    const scope: TranslationSourceScope = { ownerId: target.ownerId, mainSessionId: target.ownerId, topicId: target.topicId, translationSessionId: target.sessionId }
    const check = (): EvidenceUnavailableResult | null => {
      if (this.disposed) return unavailable(request, 'unloaded', 'reader_disposed')
      if (this.options.authorize && !this.options.authorize(request)) return unavailable(request, 'forbidden', 'authorization_changed')
      const currentSession = sessions.getSession(target.sessionId)
      if (!currentSession || sessions.isSessionDeleted(target.sessionId)) return unavailable(request, 'missing', 'session_missing')
      if (currentSession.ownerId !== target.ownerId || currentSession.topicId !== target.topicId) return unavailable(request, 'forbidden', 'scope_mismatch')
      if (sessions.getStatus(target.sessionId) === 'conflict') return unavailable(request, 'unloaded', 'history_conflict')
      const current = sessions.getTranslationHistory(target.sessionId)?.units.find(unit => unit.id === target.unitId)
      if (!current || !isDocumentUnit(current)) return unavailable(request, 'missing', 'document_missing')
      const retainedSource = current.sourceVersions.find(version => version.version === sourceVersion)
      if (!retainedSource) return unavailable(request, 'missing', 'source_version_missing')
      if (source.version !== retainedSource.version || source.body.kind !== retainedSource.body.kind ||
        (source.body.kind === 'inline' && retainedSource.body.kind === 'inline' ? source.body.text !== retainedSource.body.text
          : source.body.kind === 'asset' && retainedSource.body.kind === 'asset' && !same(source.body.reference, retainedSource.body.reference))) return unavailable(request, 'corrupt', 'source_identity_changed')
      const retainedPlan = plan && current.plans.find(value => sameVersionReference(value, plan))
      if (plan && retainedPlan !== plan && !same(plan, retainedPlan)) return unavailable(request, 'corrupt', 'plan_identity_changed')
      const retainedManifest = manifest && current.revisions.find(value => value.id === manifest.id)
      if (manifest && retainedManifest !== manifest && !same(manifest, retainedManifest)) return unavailable(request, 'corrupt', 'manifest_identity_changed')
      for (const block of blocks) if (block.revision) {
        const retained = current.chunkRevisions.find(chunk => chunk.id === block.revision!.id)
        if (!retained || retained !== block.revision && !same(block.revision, retained)) return manifest ? unavailable(request, 'corrupt', 'chunk_identity_changed') : unavailable(request, 'unloaded', 'evidence_changed')
      }
      return null
    }
    const snapshot: Snapshot = { unit, source, scope, final: manifest, chunks: blocks.flatMap(block => block.revision ? [block.revision] : []),
      totalCodePoints: documentSourceLength(source), checkFixed: check }
    const read = async (range: TranslationSourceRange, chunk?: ChunkRevision): Promise<EvidenceReadResult> => {
      range = { ...range }
      const fixed = { ...request, range: { ...range }, ...(chunk ? { side: 'final' as const, revisionId: manifest?.id ?? null } : {}) }
      const changed = check()
      if (changed) return changed
      if (this.options.authorize && !this.options.authorize(fixed)) return unavailable(fixed, 'forbidden', 'authorization_changed')
      const reading = { ...snapshot, checkFixed: () => this.options.authorize && !this.options.authorize(fixed) ? unavailable(fixed, 'forbidden', 'authorization_changed') : check() }
      const length = chunk ? chunk.content.kind === 'text' ? sourceCodePointLength(chunk.content.text) : chunk.content.range.end - chunk.content.range.start : documentSourceLength(source)
      if (!validRange(range) || range.end > length) return unavailable(fixed, 'missing', 'range_out_of_bounds', length)
      if (range.end - range.start > MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) return unavailable(fixed, 'unloaded', 'range_required', length)
      let loaded: LoadedText
      try {
        if (!chunk) loaded = await this.sourceText(fixed, reading, range)
        else if (chunk.sourceVersion !== sourceVersion || chunk.content.kind !== 'text' && chunk.status !== 'completed') return unavailable(fixed, 'missing', 'chunk_not_completed', length)
        else if (chunk.content.kind === 'text') loaded = { text: slicePoints(chunk.content.text, range) }
        else {
          const prepared = await this.prepareAsset(fixed, reading)
          if ('status' in prepared) return prepared
          const verified = await this.verifyCopy(fixed, reading, chunk, prepared)
          if (verified) return verified
          loaded = await this.sourceText(fixed, reading, { start: chunk.content.range.start + range.start, end: chunk.content.range.start + range.end }, prepared)
        }
      } catch { return unavailable(fixed, 'unloaded', 'transport_unavailable') }
      const after = reading.checkFixed()
      if (after) return after
      if ('status' in loaded) return loaded
      if (sourceCodePointLength(loaded.text) !== range.end - range.start) return unavailable(fixed, 'corrupt', 'range_length_mismatch')
      const result: EvidenceReadyResult = { status: 'ready', request: fixed, range: { ...range }, totalCodePoints: length,
        sourceVersion, manifestRevisionId: chunk ? manifest?.id ?? null : null, text: loaded.text }
      return translationSourceResultBytes({ ok: true, value: result }) > MAX_TRANSLATION_SOURCE_PAGE_BYTES ? unavailable(fixed, 'unloaded', 'range_required', length) : result
    }
    return { target: { ...target, sourceVersion }, source, manifest, plan, blocks, finalRevisionId: selected?.id ?? null,
      totalSourceCodePoints: documentSourceLength(source), check, readSource: range => read(range), openOriginal: async signal => {
        const before = check()
        if (before) return before
        if (source.body.kind !== 'asset' || !source.historyCommit) return unavailable(request, 'unloaded', 'original_projection_required')
        if (!this.options.storage) return unavailable(request, 'unloaded', 'storage_service_unavailable')
        try {
          const stored = await sessions.readStoredSourceRequest({ sessionId: target.sessionId, unitId: target.unitId, sourceVersion })
          const changed = check()
          if (changed) return changed
          if (!stored) return unavailable(request, 'unloaded', 'reference_unconfirmed')
          if (!same(stored.scope, scope) || !same(stored.source, source.body.reference)) return unavailable(request, 'forbidden', 'stored_scope_mismatch')
          const response = await this.options.storage.openOriginal(stored, signal)
          const after = check()
          return after ?? (response.ok ? { status: 'opened' } : this.businessError(request, response.error.code, true))
        } catch { return unavailable(request, 'unloaded', 'transport_unavailable') }
      }, readChunk: (revisionId, range) => {
        const block = blocks.find(block => block.revisionId === revisionId), chunk = block?.revision
        const entry = manifest?.entries.find(entry => entry.revisionId === revisionId)
        const binding = manifest ?? task
        if (!chunk || !block || !binding || !plan || manifest && (!entry || entry.reuseRef || !same(entry.outputRange, block.outputRange)) || chunk.chunkId !== block.chunkId ||
          chunk.taskId !== binding.taskId || !sameVersionReference(chunk.planRef, binding.planRef) || !sameVersionReference(chunk.preparationRef, binding.preparationRef) ||
          (block.mode === 'copy' ? chunk.kind !== 'copy' || chunk.content.kind !== 'source_copy' : chunk.kind === 'copy') ||
          chunk.content.kind === 'source_copy' && (chunk.content.sourceVersion !== sourceVersion || !same(chunk.content.range, block.outputRange))) {
          return Promise.resolve(unavailable(request, 'corrupt', 'manifest_invalid'))
        }
        return read(range, chunk)
      } }
  }
  clearCache(): void { this.pages.clear(); this.sourceLeases.clear(); this.copyHashes.clear() }
  dispose(): void { this.disposed = true; this.clearCache() }

  private inspect(request: EvidenceReadRequest): Snapshot | EvidenceUnavailableResult {
    if (this.disposed) return unavailable(request, 'unloaded', 'reader_disposed')
    if (!['ownerId', 'topicId', 'sessionId', 'unitId'].every(key => typeof request[key as keyof EvidenceReadRequest] === 'string' && !!(request[key as keyof EvidenceReadRequest] as string).trim()) ||
      !Number.isSafeInteger(request.sourceVersion) || request.sourceVersion < 1 || !['source', 'final'].includes(request.side) ||
      request.range !== null && !validRange(request.range) || (request.side === 'source' ? request.revisionId !== null || request.selectionEventId !== null :
        typeof request.revisionId !== 'string' || !request.revisionId || typeof request.selectionEventId !== 'string' || !request.selectionEventId)) return unavailable(request, 'corrupt', 'invalid_request')
    if (this.options.authorize && !this.options.authorize(request)) return unavailable(request, 'forbidden', 'authorization_changed')
    const sessions = this.options.sessions, session = sessions.getSession(request.sessionId)
    if (!session || sessions.isSessionDeleted(request.sessionId)) return unavailable(request, 'missing', 'session_missing')
    if (session.ownerId !== request.ownerId || session.topicId !== request.topicId) return unavailable(request, 'forbidden', 'scope_mismatch')
    if (sessions.getStatus(session.id) === 'conflict') return unavailable(request, 'unloaded', 'history_conflict')
    const history = sessions.getTranslationHistory(session.id), unit = history?.units.find(unit => unit.id === request.unitId)
    if (!unit) return unavailable(request, 'missing', 'unit_missing')
    if (unit.sourceVersion !== request.sourceVersion) return unavailable(request, 'missing', 'stale_source')
    const source = unit.sourceVersions.find(source => source.version === request.sourceVersion)
    if (!source) return unavailable(request, 'missing', 'source_version_missing')
    const scope: TranslationSourceScope = { ownerId: request.ownerId, mainSessionId: request.ownerId, topicId: request.topicId, translationSessionId: request.sessionId }
    if (request.side === 'source') {
      const totalCodePoints = isDocumentUnit(unit) ? documentSourceLength(source as DocumentSourceVersion) : sourceCodePointLength((source as { text: string }).text)
      if (request.range && request.range.end > totalCodePoints) return unavailable(request, 'missing', 'range_out_of_bounds', totalCodePoints)
      return { unit, source, scope, final: null, chunks: [], totalCodePoints }
    }
    const final = isDocumentUnit(unit) ? currentDocumentFinalRevision(unit) : currentFinalRevision(unit)
    const event = [...history!.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unit.id)
    if (!final || final.id !== request.revisionId || event?.revisionId !== final.id || event.id !== request.selectionEventId || final.sourceVersion !== request.sourceVersion) return unavailable(request, 'missing', 'stale_final')
    if ('text' in final) {
      const totalCodePoints = sourceCodePointLength(final.text)
      if (request.range && request.range.end > totalCodePoints) return unavailable(request, 'missing', 'range_out_of_bounds', totalCodePoints)
      return { unit, source, scope, final, chunks: [], totalCodePoints }
    }
    const chunks: ChunkRevision[] = [], document = unit as Extract<TranslationUnit, { kind: 'document' }>
    let totalCodePoints = 0
    for (const entry of final.entries) {
      const chunk = document.chunkRevisions.find(chunk => chunk.id === entry.revisionId)
      if (!chunk || chunk.status !== 'completed' || chunk.chunkId !== entry.chunkId || chunk.sourceVersion !== request.sourceVersion || entry.reuseRef) return unavailable(request, 'corrupt', 'manifest_invalid')
      if (chunk.content.kind === 'source_copy' && (chunk.content.sourceVersion !== request.sourceVersion || !validRange(chunk.content.range) || chunk.content.range.end > documentSourceLength(source as DocumentSourceVersion))) return unavailable(request, 'corrupt', 'copy_range_invalid')
      totalCodePoints += chunk.content.kind === 'text' ? sourceCodePointLength(chunk.content.text) : chunk.content.range.end - chunk.content.range.start
      if (!Number.isSafeInteger(totalCodePoints)) return unavailable(request, 'corrupt', 'manifest_invalid')
      chunks.push(chunk)
    }
    if (request.range && request.range.end > totalCodePoints) return unavailable(request, 'missing', 'range_out_of_bounds', totalCodePoints)
    return { unit, source, scope, final, chunks, totalCodePoints }
  }
  private after(request: EvidenceReadRequest, snapshot: Snapshot): EvidenceUnavailableResult | null {
    if (snapshot.checkFixed) return snapshot.checkFixed()
    const current = this.inspect(request)
    if ('status' in current) return current
    return snapshotSame(snapshot, current) ? null : unavailable(request, 'unloaded', 'evidence_changed')
  }
  async read(request: EvidenceReadRequest): Promise<EvidenceReadResult> {
    const fixed = structuredClone(request), snapshot = this.inspect(fixed)
    if ('status' in snapshot) return snapshot
    const range = fixed.range ?? { start: 0, end: snapshot.totalCodePoints }
    if (range.end > snapshot.totalCodePoints || !validRange(range)) return unavailable(fixed, 'missing', 'range_out_of_bounds', snapshot.totalCodePoints)
    if (range.end - range.start > MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) return unavailable(fixed, 'unloaded', 'range_required', snapshot.totalCodePoints)
    const key = JSON.stringify(fixed), cached = this.pages.get(key)
    if (cached && cached.stamp.source.deref() === snapshot.source && cached.stamp.final?.deref() === (snapshot.final ?? undefined) &&
      cached.stamp.chunks.length === snapshot.chunks.length && cached.stamp.chunks.every((chunk, index) => chunk.deref() === snapshot.chunks[index])) {
      try {
        const verified = await this.validateCachedAsset(fixed, snapshot, range)
        if (verified) { this.pages.delete(key); return verified }
      } catch { this.pages.delete(key); return unavailable(fixed, 'unloaded', 'transport_unavailable') }
      const changed = this.after(fixed, snapshot)
      if (changed) { this.pages.delete(key); return changed }
      this.pages.delete(key); this.pages.set(key, cached)
      return structuredClone(cached.result)
    }
    this.pages.delete(key)
    let loaded: LoadedText
    try { loaded = fixed.side === 'source' ? await this.sourceText(fixed, snapshot, range) : await this.finalText(fixed, snapshot, range) }
    catch { loaded = unavailable(fixed, 'unloaded', 'transport_unavailable') }
    const changed = this.after(fixed, snapshot)
    if (changed) return changed
    if ('status' in loaded) return loaded
    if (sourceCodePointLength(loaded.text) !== range.end - range.start) return unavailable(fixed, 'corrupt', 'range_length_mismatch')
    const result: EvidenceReadyResult = { status: 'ready', request: fixed, range, totalCodePoints: snapshot.totalCodePoints,
      sourceVersion: fixed.sourceVersion, manifestRevisionId: snapshot.final && !('text' in snapshot.final) ? snapshot.final.id : null, text: loaded.text }
    if (translationSourceResultBytes({ ok: true, value: result }) > MAX_TRANSLATION_SOURCE_PAGE_BYTES) return unavailable(fixed, 'unloaded', 'range_required', snapshot.totalCodePoints)
    if (this.maximum) {
      this.pages.set(key, { stamp: { source: new WeakRef(snapshot.source), final: snapshot.final ? new WeakRef(snapshot.final) : null,
        chunks: snapshot.chunks.map(chunk => new WeakRef(chunk)) }, result })
      while (this.pages.size > this.maximum) this.pages.delete(this.pages.keys().next().value!)
    }
    return structuredClone(result)
  }
  /** A separate explicit paging entry; it never silently replaces a whole reference. */
  async readPage(request: EvidenceReadRequest & { readonly range: TranslationSourceRange }): Promise<EvidenceReadResult> { return this.read(request) }
  private businessError(request: EvidenceReadRequest, code: string, saved = false): EvidenceUnavailableResult {
    if (code === 'scope_mismatch' || code === 'token_mismatch') return unavailable(request, 'forbidden', code)
    if (['integrity_failed', 'source_corrupt', 'invalid_utf8'].includes(code)) return unavailable(request, 'corrupt', code)
    if (['source_missing', 'reference_released'].includes(code) || code === 'not_found' && saved) return unavailable(request, 'missing', code)
    return unavailable(request, 'unloaded', code)
  }
  private async validateCachedAsset(request: EvidenceReadRequest, snapshot: Snapshot,
    range: TranslationSourceRange): Promise<EvidenceUnavailableResult | null> {
    const source = snapshot.source
    if (!('body' in source) || source.body.kind !== 'asset') return null
    if (request.side === 'final') {
      let offset = 0, hasCopy = false
      for (const chunk of snapshot.chunks) {
        const length = chunk.content.kind === 'text' ? sourceCodePointLength(chunk.content.text) : chunk.content.range.end - chunk.content.range.start
        if (chunk.content.kind === 'source_copy' && Math.max(range.start, offset) < Math.min(range.end, offset + length)) hasCopy = true
        offset += length
      }
      if (!hasCopy) return null
    }
    // Runtime page caches are tied to the bridge connection lifetime; reset/disposal clears them.
    if (!source.historyCommit) return null
    const prepared = await this.prepareAsset(request, snapshot)
    if ('status' in prepared) return prepared
    return this.after(request, snapshot)
  }
  private async prepareAsset(request: EvidenceReadRequest, snapshot: Snapshot, forceRestore = false): Promise<{ readonly saved: boolean } | EvidenceUnavailableResult> {
    const source = snapshot.source
    if (!('body' in source) || source.body.kind !== 'asset') return { saved: false }
    if (!this.options.sources) return unavailable(request, 'unloaded', 'source_service_unavailable')
    if (!source.historyCommit) return { saved: false }
    if (!this.options.storage) return unavailable(request, 'unloaded', 'storage_service_unavailable')
    const stored = await this.options.sessions.readStoredSourceRequest({ sessionId: request.sessionId, unitId: request.unitId, sourceVersion: request.sourceVersion })
    const changed = this.after(request, snapshot)
    if (changed) return changed
    if (!stored) return unavailable(request, 'unloaded', 'reference_unconfirmed')
    if (!same(stored.scope, snapshot.scope) || !same(stored.source, source.body.reference)) return unavailable(request, 'forbidden', 'stored_scope_mismatch')
    const leaseKey = JSON.stringify(stored)
    if (!forceRestore && this.sourceLeases.has(leaseKey)) {
      const response = await this.options.storage.queryReference({ scope: stored.scope, referenceKey: stored.referenceKey })
      const afterQuery = this.after(request, snapshot)
      if (afterQuery) return afterQuery
      if (!response.ok) { this.sourceLeases.delete(leaseKey); return this.businessError(request, response.error.code, true) }
      const reference = response.value
      if (reference.state === 'prepared') return unavailable(request, 'unloaded', 'reference_unconfirmed')
      if (reference.state === 'released') { this.sourceLeases.delete(leaseKey); return unavailable(request, 'missing', 'reference_released') }
      if (!same(reference.scope, snapshot.scope) || reference.referenceKey !== stored.referenceKey || reference.historyToken !== stored.historyToken) return unavailable(request, 'forbidden', 'stored_scope_mismatch')
      if (!same(reference.source, source.body.reference) || reference.referenceVersion !== 1 || reference.storage !== 'saved') return unavailable(request, 'corrupt', 'stored_identity_mismatch')
      return { saved: true }
    }
    const restored = await this.options.storage.restore(stored)
    const afterRestore = this.after(request, snapshot)
    if (afterRestore) return afterRestore
    if (!restored.ok) return this.businessError(request, restored.error.code, true)
    if (restored.value.state !== 'confirmed' || restored.value.referenceVersion !== 1 || !same(restored.value.scope, snapshot.scope) ||
      restored.value.referenceKey !== stored.referenceKey || !same(toSourceIdentity(restored.value.source), source.body.reference)) return unavailable(request, 'corrupt', 'restored_identity_mismatch')
    if (this.maximum) {
      this.sourceLeases.delete(leaseKey); this.sourceLeases.add(leaseKey)
      while (this.sourceLeases.size > this.maximum) this.sourceLeases.delete(this.sourceLeases.values().next().value!)
    }
    return { saved: true }
  }
  private async sourceText(request: EvidenceReadRequest, snapshot: Snapshot, range: TranslationSourceRange,
    prepared?: { readonly saved: boolean }): Promise<LoadedText> {
    const source = snapshot.source
    if ('text' in source) return { text: slicePoints(source.text, range) }
    if (source.body.kind === 'inline') return { text: slicePoints(source.body.text, range) }
    const preparation = prepared ?? await this.prepareAsset(request, snapshot)
    if ('status' in preparation) return preparation
    let start = range.start, pageSize = Math.min(MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, range.end - start), text = '', restoredAgain = false
    while (start < range.end) {
      const before = this.after(request, snapshot)
      if (before) return before
      const part = { start, end: Math.min(range.end, start + pageSize) }
      const raw = await this.options.sources!.readRange({ scope: snapshot.scope, sourceId: source.body.reference.sourceId, version: source.body.reference.version, range: part })
      const changed = this.after(request, snapshot)
      if (changed) return changed
      if (!raw.ok && raw.error.code === 'page_too_large' && pageSize > 1) { pageSize = Math.max(1, Math.floor(pageSize / 2)); continue }
      // A lost runtime index is recoverable. Only the saved-byte restore can confirm missing content.
      if (!raw.ok && raw.error.code === 'not_found' && preparation.saved && !restoredAgain) {
        restoredAgain = true
        const restored = await this.prepareAsset(request, snapshot, true)
        if ('status' in restored) return restored
        continue
      }
      if (!raw.ok) return this.businessError(request, raw.error.code)
      const page = (parseTranslationSourceResult('readRange', raw) as typeof raw).value
      if (!same(page.scope, snapshot.scope) || !same(toSourceIdentity(page.source), source.body.reference) || !same(page.range, part)) return unavailable(request, 'corrupt', 'page_identity_mismatch')
      text += page.text; start = part.end
    }
    return { text }
  }
  private async verifyCopy(request: EvidenceReadRequest, snapshot: Snapshot, chunk: ChunkRevision,
    prepared: { readonly saved: boolean }): Promise<EvidenceUnavailableResult | null> {
    if (chunk.content.kind !== 'source_copy') return unavailable(request, 'corrupt', 'copy_range_invalid')
    const source = snapshot.source
    const hashKey = JSON.stringify([request.ownerId, request.topicId, request.sessionId, request.unitId, request.sourceVersion,
      request.revisionId, request.selectionEventId, chunk.id, chunk.content])
    if (this.copyHashes.get(hashKey)?.deref() === source) return null
    const remember = (): null => {
      if (this.maximum) {
        this.copyHashes.delete(hashKey); this.copyHashes.set(hashKey, new WeakRef(source))
        while (this.copyHashes.size > this.maximum) this.copyHashes.delete(this.copyHashes.keys().next().value!)
      }
      return null
    }
    if ('body' in source && source.body.kind === 'asset') {
      if (!this.options.integrity) return unavailable(request, 'unloaded', 'copy_verification_unavailable')
      const target = { scope: snapshot.scope, sourceId: source.body.reference.sourceId,
        version: source.body.reference.version, range: chunk.content.range, sha256: chunk.content.sha256 }
      let response = await this.options.integrity.verifyRangeHash(target)
      if (!response.ok && response.error.code === 'not_found' && prepared.saved) {
        const restored = await this.prepareAsset(request, snapshot, true)
        if ('status' in restored) return restored
        response = await this.options.integrity.verifyRangeHash(target)
      }
      const changed = this.after(request, snapshot)
      if (changed) return changed
      return response.ok && response.value.verified === true ? remember() : response.ok ? unavailable(request, 'corrupt', 'copy_verification_invalid') : this.businessError(request, response.error.code)
    }
    if (!globalThis.crypto?.subtle) return unavailable(request, 'unloaded', 'copy_verification_unavailable')
    const text = 'text' in source ? source.text : source.body.kind === 'inline' ? source.body.text : ''
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(slicePoints(text, chunk.content.range)))
    const changed = this.after(request, snapshot)
    if (changed) return changed
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') === chunk.content.sha256 ? remember() : unavailable(request, 'corrupt', 'copy_hash_mismatch')
  }
  private async finalText(request: EvidenceReadRequest, snapshot: Snapshot, range: TranslationSourceRange): Promise<LoadedText> {
    if (snapshot.final && 'text' in snapshot.final) return { text: slicePoints(snapshot.final.text, range) }
    let offset = 0, text = '', prepared: { readonly saved: boolean } | undefined
    for (const chunk of snapshot.chunks) {
      const length = chunk.content.kind === 'text' ? sourceCodePointLength(chunk.content.text) : chunk.content.range.end - chunk.content.range.start
      const start = Math.max(range.start, offset), end = Math.min(range.end, offset + length)
      if (start < end) {
        if (chunk.content.kind === 'text') text += slicePoints(chunk.content.text, { start: start - offset, end: end - offset })
        else {
          if (!prepared) {
            const preparation = await this.prepareAsset(request, snapshot)
            if ('status' in preparation) return preparation
            prepared = preparation
          }
          const verified = await this.verifyCopy(request, snapshot, chunk, prepared)
          if (verified) return verified
          const loaded = await this.sourceText(request, snapshot, { start: chunk.content.range.start + start - offset, end: chunk.content.range.start + end - offset }, prepared)
          if ('status' in loaded) return loaded
          text += loaded.text
        }
      }
      offset += length
      if (offset >= range.end) break
    }
    return { text }
  }
}
export { TranslationSourceReader as SourceReader }
