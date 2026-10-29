import { parseLibrarySourceRequest, type LibrarySourceRequest, type LibrarySourceValue } from '../shared/library-sources.js'
import type { HistoryScope } from '../shared/history-bundle.js'
import { historyTargetMatches } from './history-resources.js'
import { MAX_TRANSLATION_SOURCE_BYTES, TRANSLATION_SOURCES_REMOTE, parseTranslationSourceAsset, parseTranslationSourceRequest, parseTranslationSourceScope, toSourceIdentity,
  translationSourceResultBytes, type TranslationSourceAsset, type TranslationSourceAssetPage, type TranslationSourceAssetRead,
  type TranslationSourceCapability, type TranslationSourceErrorCode, type TranslationSourceImport, type TranslationSourceResult,
  type TranslationSourceScope } from '../shared/translation-sources.js'
import { MAX_TRANSLATION_SOURCE_PAGE_BYTES, MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { QuickHostContext } from './quick-translation.js'
import { TRANSLATION_SOURCE_STORAGE_REMOTE, parseTranslationSourceStorageRequest, type TranslationSourceConfirmReference,
  type TranslationSourcePrepareSave, type TranslationSourceQueryReference, type TranslationSourceReference, type TranslationSourceReleaseReference,
  type TranslationSourceRestored, type TranslationSourceStorageCapability, type TranslationSourceStorageErrorCode,
  type TranslationSourceStorageResult, type TranslationSourceStoredRead } from '../shared/translation-source-storage.js'
import { loadTranslationSourceStorage, sourceSha256, type StoredSourceReference, type TranslationSourceHostOptions,
  type TranslationSourceStorage } from './source-storage.js'
import { TRANSLATION_SOURCE_INTEGRITY_REMOTE, parseTranslationSourceRangeHash,
  type TranslationSourceRangeHash } from '../shared/translation-source-integrity.js'

interface Agent { readonly id: string; readonly session: { readonly id: string }; readonly ctx: unknown }
interface FileRef { readonly attachmentId: string; readonly name: string; readonly bytes: number }
interface Attachments { readFileStream(ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array> }
interface Uploads { resolve(agent: Agent, receiptId: string): FileRef | undefined }
interface Controller {
  resolveAgent(id: string): Promise<{ readonly agent: Agent } | { readonly error: unknown }>
  canOpenWorkspacePath(): boolean
  openWorkspacePath(request: { path: string }, signal: AbortSignal): Promise<{ opened: true }>
}
interface SourceRecord { readonly scope: TranslationSourceScope; readonly peerId: string; readonly agent: Agent | undefined; readonly source: TranslationSourceAsset; readonly text: string; readonly bytes: Uint8Array; readonly codePointOffsets: Uint32Array }
interface Pending { readonly peerId: string; readonly agent: Agent; readonly promise: Promise<TranslationSourceResult<TranslationSourceAsset>> }
function ok<T>(value: T): { readonly ok: true; readonly value: T } { return { ok: true, value: structuredClone(value) } }
function bad<T>(code: TranslationSourceErrorCode, message: string, stage: string): TranslationSourceResult<T> { return { ok: false, error: { code, message, stage } } }
function sameScope(a: TranslationSourceScope, b: TranslationSourceScope): boolean {
  return a.topicId === b.topicId && a.translationSessionId === b.translationSessionId && (a.namespaceId && b.namespaceId ? a.namespaceId === b.namespaceId : a.ownerId === b.ownerId && a.mainSessionId === b.mainSessionId)
}
function storageBad<T>(code: TranslationSourceStorageErrorCode, message: string, stage: string): TranslationSourceStorageResult<T> { return { ok: false, error: { code, message, stage } } }
function indexText(text: string): Uint32Array {
  const offsets = new Uint32Array(sourceCodePointLength(text) + 1)
  let point = 0, offset = 0
  for (const character of text) { offsets[point++] = offset; offset += character.length }
  offsets[point] = text.length
  return offsets
}

/** Runtime source indexes and independently managed saved copies. Native attachments keep their own storage policy. */
export class TranslationSourcesService {
  readonly typertRemote: { readonly service: TranslationSourcesService; readonly serviceKey: 'translationSources'; readonly namespace: 'translationSources' }
  private readonly sources = new Map<string, SourceRecord>()
  private readonly receipts = new Map<string, string>()
  private readonly bindings = new Map<string, { readonly signature: string; readonly peerId: string }>()
  private readonly pending = new Map<string, Pending>()
  private readonly referenceQueues = new Map<string, Promise<unknown>>()
  private storage: Promise<TranslationSourceStorage> | undefined
  private storageInstance: TranslationSourceStorage | undefined
  private disposed = false
  private storageCleanup = false
  private storageGeneration = 0
  private libraryReads = 0
  constructor(readonly ctx: QuickHostContext, private readonly options: TranslationSourceHostOptions = {}) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationSources', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationSources', namespace: 'translationSources' })
  }
  private owns(scope: TranslationSourceScope, peerId: string | undefined, agent?: Pick<Agent, 'id' | 'session'>): boolean {
    const topics = this.ctx.get?.('translationTopics') as { ownsConnection(ownerId: string, peerId: string): boolean; ownsLibrary(namespaceId: string, peerId: string): boolean } | undefined
    const agents = this.ctx.get?.('agents') as { get(id: string): Agent | undefined } | undefined
    return !this.disposed && !this.storageCleanup && !!peerId && (scope.namespaceId ? topics?.ownsLibrary(scope.namespaceId, peerId) === true : topics?.ownsConnection(scope.ownerId, peerId) === true) && (!agent ||
      agent.id === scope.mainSessionId && agent.session.id === scope.mainSessionId && agents?.get(scope.mainSessionId) === agent)
  }
  private ready(): boolean {
    const attachments = this.ctx.get?.('attachments') as Attachments | undefined, uploads = this.ctx.get?.('fileUploads') as Uploads | undefined
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    return !this.disposed && typeof attachments?.readFileStream === 'function' && typeof uploads?.resolve === 'function' && typeof controller?.resolveAgent === 'function'
  }
  async capabilities(): Promise<TranslationSourceResult<TranslationSourceCapability>> {
    const ready = this.ready()
    return ok({ ready, storage: 'runtime_only', encoding: 'utf-8', acceptsBinary: true, maxBytes: MAX_TRANSLATION_SOURCE_BYTES,
      maxPageCodePoints: MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, maxPageBytes: MAX_TRANSLATION_SOURCE_PAGE_BYTES,
      ...(ready ? {} : { reason: '宿主文件上传及附件读取服务尚未就绪。' }) })
  }
  private referenceRecord(scope: TranslationSourceScope, source: TranslationSourceAsset, peerId: string,
    agent?: Pick<Agent, 'id' | 'session'>): TranslationSourceResult<SourceRecord> {
    if (!this.ready()) return bad('unavailable', '宿主固定源资产服务尚未就绪。', 'resolve_source')
    if (!this.owns(scope, peerId, agent)) return bad('scope_mismatch', '固定源资产不属于此主会话连接或 Agent。', 'resolve_source')
    const record = this.sources.get(source.sourceId)
    if (!record || !sameScope(record.scope, scope)) return bad('not_found', '此范围的固定源资产不存在。', 'resolve_source')
    if (record.peerId !== peerId || !this.owns(scope, peerId) || (!scope.namespaceId && agent && record.agent !== agent)) return bad('scope_mismatch', '固定源资产所属连接或主 Agent 已失效。', 'resolve_source')
    if (source.version !== record.source.version) return bad('stale_version', '引用的固定源资产版本不一致。', 'resolve_source')
    if (source.name !== record.source.name || source.bytes !== record.source.bytes || source.totalCodePoints !== record.source.totalCodePoints ||
      source.encoding !== record.source.encoding || source.bom !== record.source.bom || source.sha256 !== record.source.sha256 ||
      source.persistence !== record.source.persistence) return bad('integrity_failed', '固定源引用的元数据与原资产不一致。', 'resolve_source')
    return { ok: true, value: record }
  }
  /** In-process material preparation; no new Remote or unrestricted Agent tool is exposed. */
  validateReference(scope: TranslationSourceScope, source: TranslationSourceAsset, peerId: string): TranslationSourceResult<TranslationSourceAsset> {
    let fixedScope: TranslationSourceScope, reference: TranslationSourceAsset
    try { fixedScope = parseTranslationSourceScope(scope); reference = parseTranslationSourceAsset(source) }
    catch { return bad('invalid_input', '固定源引用格式无效。', 'resolve_source') }
    const found = this.referenceRecord(fixedScope, reference, peerId)
    return found.ok ? ok(found.value.source) : found
  }
  /** Private correction writer: immutable assets are created only from Host-verified text. */
  async createCorrectedForAgent(scope: TranslationSourceScope, text: string, name: string, peerId: string, agent: Agent): Promise<TranslationSourceResult<TranslationSourceAsset>> {
    const generation = this.storageGeneration
    if (!this.owns(scope, peerId, agent)) return bad('scope_mismatch', '纠错原稿不属于实际主 Agent。', 'correct_document_source')
    const bytes = new TextEncoder().encode(text), totalCodePoints = sourceCodePointLength(text)
    if (!totalCodePoints || bytes.byteLength > MAX_TRANSLATION_SOURCE_BYTES || /[\uD800-\uDFFF]/u.test(text)) return bad('invalid_input', '纠错后的原稿为空、编码无效或超过 2 MiB。', 'correct_document_source')
    const source: TranslationSourceAsset = { sourceId: `source-${crypto.randomUUID()}`, version: 1, name, bytes: bytes.byteLength,
      totalCodePoints, encoding: 'utf-8', bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, sha256: await sourceSha256(bytes), persistence: 'runtime_only' }
    if (generation !== this.storageGeneration || !this.owns(scope, peerId, agent)) return bad('scope_mismatch', '纠错原稿生成时所属连接或存储范围已变化。', 'correct_document_source')
    this.sources.set(source.sourceId, { scope, peerId, agent, source, text, bytes, codePointOffsets: indexText(text) })
    return ok(source)
  }
  /** Called only after Materials confirms this exact material was delivered to the actual main Agent. */
  readForAgent(scope: TranslationSourceScope, source: TranslationSourceAsset, range: TranslationSourceRange, peerId: string,
    agent: Pick<Agent, 'id' | 'session'>): TranslationSourceResult<{ readonly totalCodePoints: number; readonly text: string }> {
    const found = this.referenceRecord(scope, source, peerId, agent)
    if (!found.ok) return found
    return this.slice(found.value, range)
  }
  /** Host-internal full body for one translation call; the 4000-point page limit is a model-facing tool rule. */
  readFullForAgent(scope: TranslationSourceScope, source: TranslationSourceAsset, peerId: string,
    agent: Pick<Agent, 'id' | 'session'>): TranslationSourceResult<{ readonly totalCodePoints: number; readonly text: string }> {
    const found = this.referenceRecord(scope, source, peerId, agent)
    if (!found.ok) return found
    if (found.value.source.encoding !== 'utf-8') return bad('unsupported_file', '此原稿是二进制文件，不能按文本翻译；请先提取正文。', 'read_source')
    return ok({ totalCodePoints: found.value.source.totalCodePoints, text: found.value.text })
  }
  private slice(record: SourceRecord, range: TranslationSourceRange): TranslationSourceResult<{ readonly totalCodePoints: number; readonly text: string }> {
    if (record.source.encoding !== 'utf-8') return bad('unsupported_file', '此原稿是二进制文件，不能按文本范围读取；请直接读取缓存原件。', 'read_source')
    const { start, end } = range
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return bad('invalid_range', '原文读取范围无效。', 'read_source')
    if (end - start > MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) return bad('page_too_large', '每页最多 4000 个 Unicode 码点，未截断。', 'read_source')
    if (end > record.source.totalCodePoints) return bad('range_out_of_bounds', '范围超出固定原文长度，未截断。', 'read_source')
    return { ok: true, value: { totalCodePoints: record.source.totalCodePoints,
      text: record.text.slice(record.codePointOffsets[start]!, record.codePointOffsets[end]!) } }
  }
  /** A live Agent can accept the upload immediately; a cold Session must not hang the panel. */
  private async resolveUploadAgent(id: string): Promise<{ readonly agent: Agent } | { readonly error: unknown } | 'timeout'> {
    const live = (this.ctx.get?.('agents') as { get(id: string): Agent | undefined } | undefined)?.get(id)
    const pending = live ? Promise.resolve({ agent: live }) : (this.ctx.get?.('sessionController') as Controller).resolveAgent(id)
    pending.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([pending, new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 30_000) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  async importReceipt(input: TranslationSourceImport, signal: AbortSignal): Promise<TranslationSourceResult<TranslationSourceAsset>> {
    const generation = this.storageGeneration
    let request: TranslationSourceImport
    try { request = parseTranslationSourceRequest('importReceipt', input) as TranslationSourceImport } catch { return bad('invalid_input', '文件导入参数无效。', 'resolve_upload') }
    const peerId = this.ctx.invocation?.peer.id
    if (!this.owns(request.scope, peerId)) return bad('scope_mismatch', '文件导入不属于此主会话连接。', 'resolve_upload')
    signal.throwIfAborted()
    const attachments = this.ctx.get?.('attachments') as Attachments | undefined, uploads = this.ctx.get?.('fileUploads') as Uploads | undefined
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    if (typeof attachments?.readFileStream !== 'function' || typeof uploads?.resolve !== 'function' || !controller?.resolveAgent) return bad('unavailable', '宿主文件上传及附件读取服务尚未就绪。', 'resolve_upload')
    const bindingKey = JSON.stringify([request.scope.ownerId, request.idempotencyKey])
    const signature = JSON.stringify([request.scope.ownerId, request.scope.mainSessionId, request.scope.topicId, request.scope.translationSessionId, request.receiptId])
    const binding = this.bindings.get(bindingKey)
    if (binding && binding.signature !== signature) return bad('idempotency_conflict', '此导入请求标识已绑定另一份范围或上传收据。', 'resolve_upload')
    if (binding && binding.peerId !== peerId) return bad('scope_mismatch', '此导入请求属于另一连接。', 'resolve_upload')
    this.bindings.set(bindingKey, { signature, peerId: peerId! })
    let found: { readonly agent: Agent } | { readonly error: unknown } | 'timeout'
    try { found = await this.resolveUploadAgent(request.scope.mainSessionId) }
    catch { signal.throwIfAborted(); return bad('unavailable', '无法解析所属主会话的上传服务。', 'resolve_upload') }
    signal.throwIfAborted()
    if (found === 'timeout') return bad('main_agent_busy', '所属主会话尚未就绪或仍在处理上一回合；原稿尚未导入，请稍后重试。', 'resolve_upload')
    if ('error' in found) return bad('unavailable', '所属普通主会话不可用。', 'resolve_upload')
    const agent = found.agent
    // Gateway invocation is synchronous. All later checks use the captured peer and exact Agent.
    if (generation !== this.storageGeneration || !this.owns(request.scope, peerId, agent)) return bad('scope_mismatch', '上传主 Agent 身份、所属连接或存储范围已变化。', 'resolve_upload')
    const existing = this.sources.get(this.receipts.get(signature) ?? '')
    if (existing) return existing.peerId === peerId && existing.agent === agent ? ok(existing.source) : bad('scope_mismatch', '此固定源资产属于另一连接或 Agent。', 'resolve_upload')
    let pending = this.pending.get(signature)
    if (pending && (pending.peerId !== peerId || pending.agent !== agent)) return bad('scope_mismatch', '此导入正在另一连接或 Agent 中准备。', 'resolve_upload')
    if (!pending) {
      const file = uploads.resolve(agent, request.receiptId)
      if (!file) return bad('receipt_not_found', '上传收据已失效或不属于此主会话。', 'resolve_upload')
      const promise = this.decode(request.scope, peerId!, agent, file, attachments, signal, signature)
      pending = { peerId: peerId!, agent, promise }; this.pending.set(signature, pending)
      const clear = (): void => { if (this.pending.get(signature) === pending) this.pending.delete(signature) }
      void promise.then(clear, clear)
    }
    const result = await pending.promise
    signal.throwIfAborted()
    if (!this.owns(request.scope, peerId, agent)) return bad('scope_mismatch', '文件导入所属连接或 Agent 已失效。', 'resolve_upload')
    return result
  }
  private async decode(scope: TranslationSourceScope, peerId: string, agent: Agent, file: FileRef, attachments: Attachments,
    signal: AbortSignal, signature: string): Promise<TranslationSourceResult<TranslationSourceAsset>> {
    // Format is not decided from the extension. Valid UTF-8 becomes readable text; every other
    // file keeps its exact bytes and is never decoded, guessed or converted into TXT.
    if (typeof file.name !== 'string' || !file.name.trim() || file.name === '.' || file.name === '..' ||
      sourceCodePointLength(file.name) > 255 || /[\\/<>:"|?*\u0000-\u001f\u007f]/u.test(file.name)) return bad('invalid_input', '宿主返回的原件名称无效。', 'resolve_upload')
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) return bad('integrity_failed', '上传原件字节元信息无效。', 'read_original')
    if (file.bytes > MAX_TRANSLATION_SOURCE_BYTES) return bad('source_too_large', '原件超过 2 MiB 上限，未导入。', 'read_original')
    const chunks: Uint8Array[] = []
    let count = 0
    try {
      for await (const chunk of attachments.readFileStream(file, signal)) {
        signal.throwIfAborted()
        count += chunk.byteLength
        if (count > MAX_TRANSLATION_SOURCE_BYTES) return bad('source_too_large', '原件流超过 2 MiB 上限，未导入。', 'read_original')
        if (count > file.bytes) return bad('integrity_failed', '上传原件实际字节与元信息不一致。', 'read_original')
        chunks.push(new Uint8Array(chunk))
      }
    } catch { signal.throwIfAborted(); return bad('integrity_failed', '原件不存在或附件完整性校验失败。', 'read_original') }
    signal.throwIfAborted()
    if (count !== file.bytes) return bad('integrity_failed', '上传原件实际字节与元信息不一致。', 'read_original')
    const bytes = new Uint8Array(count)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let text = '', binary = false
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { binary = true }
    if (!binary && !text) return bad('empty_source', '原件没有可读取的正文。', 'decode_text')
    const totalCodePoints = binary ? 0 : sourceCodePointLength(text)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))
    signal.throwIfAborted()
    if (!this.owns(scope, peerId, agent)) return bad('scope_mismatch', '原件准备完成前所属连接或 Agent 已失效。', 'decode_text')
    const source = parseTranslationSourceAsset({ sourceId: `source-${crypto.randomUUID()}`, version: 1, name: file.name, bytes: count,
      totalCodePoints, encoding: binary ? 'binary' : 'utf-8', bom: binary ? false : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), persistence: 'runtime_only' })
    this.sources.set(source.sourceId, { scope, peerId, agent, source, text, bytes, codePointOffsets: indexText(text) }); this.receipts.set(signature, source.sourceId)
    return ok(source)
  }
  async readRange(input: TranslationSourceAssetRead): Promise<TranslationSourceResult<TranslationSourceAssetPage>> {
    let request: TranslationSourceAssetRead
    try { request = parseTranslationSourceRequest('readRange', input) as TranslationSourceAssetRead }
    catch (error) { return bad(error instanceof Error && 'code' in error && error.code === 'invalid_range' ? 'invalid_range' : 'invalid_input', '原文读取范围或身份无效。', 'read_source') }
    const peerId = this.ctx.invocation?.peer.id
    if (!this.owns(request.scope, peerId)) return bad('scope_mismatch', '原文读取不属于此主会话连接。', 'read_source')
    const record = this.sources.get(request.sourceId)
    if (!record || !sameScope(record.scope, request.scope)) return bad('not_found', '此范围的固定源资产不存在。', 'read_source')
    if (record.peerId !== peerId || !this.owns(request.scope, peerId)) return bad('scope_mismatch', '原文所属连接或主 Agent 已失效。', 'read_source')
    if (request.version !== record.source.version) return bad('stale_version', '引用的固定源资产版本不一致。', 'read_source')
    const page = this.slice(record, request.range)
    if (!page.ok) return page
    const result = ok({ scope: request.scope, source: record.source, range: request.range, text: page.value.text })
    return translationSourceResultBytes(result) > MAX_TRANSLATION_SOURCE_PAGE_BYTES ? bad('page_too_large', '完整分页回复超过 32768 UTF-8 字节，未截断。', 'read_source') : result
  }
  /** Exact copy validation stays at the authorized Host; no entire range is returned to Client. */
  async verifyRangeHash(input: TranslationSourceRangeHash): Promise<TranslationSourceResult<{ readonly verified: true }>> {
    let request: TranslationSourceRangeHash
    try { request = parseTranslationSourceRangeHash(input) }
    catch { return bad('invalid_input', '原稿范围校验参数无效。', 'verify_source_range') }
    const peerId = this.ctx.invocation?.peer.id
    if (!this.owns(request.scope, peerId)) return bad('scope_mismatch', '原稿范围校验不属于此主会话连接。', 'verify_source_range')
    const record = this.sources.get(request.sourceId)
    if (!record || !sameScope(record.scope, request.scope)) return bad('not_found', '此范围的固定源资产不存在。', 'verify_source_range')
    if (record.peerId !== peerId || !this.owns(request.scope, peerId)) return bad('scope_mismatch', '原稿所属连接或主 Agent 已失效。', 'verify_source_range')
    if (request.version !== record.source.version) return bad('stale_version', '引用的固定源资产版本不一致。', 'verify_source_range')
    if (request.range.end > record.source.totalCodePoints) return bad('range_out_of_bounds', '原稿校验范围超出固定源。', 'verify_source_range')
    const text = record.text.slice(record.codePointOffsets[request.range.start]!, record.codePointOffsets[request.range.end]!)
    const digest = await sourceSha256(new TextEncoder().encode(text))
    if (this.sources.get(request.sourceId) !== record || !this.owns(request.scope, peerId) || record.peerId !== peerId) return bad('scope_mismatch', '原稿范围校验时所属连接或 Agent 已失效。', 'verify_source_range')
    return digest === request.sha256 ? ok({ verified: true }) : bad('integrity_failed', '原稿完整复制范围校验失败。', 'verify_source_range')
  }
  private storagePort(): Promise<TranslationSourceStorage> {
    if (!this.storage) {
      const loaded = this.options.storage ? Promise.resolve(this.options.storage) : (this.options.loadStorage?.() ?? loadTranslationSourceStorage(this.ctx))
      this.storage = loaded
      void loaded.then(instance => { this.storageInstance = instance }, () => { if (this.storage === loaded) this.storage = undefined })
    }
    return this.storage
  }
  /**
   * Notice-time helper: the exact cached original is available only once the storage has loaded.
   * The Client waits for this cache write before preparing file material, so a notice normally has it.
   */
  cachedOriginalPath(source: TranslationSourceAsset): string | undefined {
    try { return this.storageInstance?.originalPath(source) } catch { return undefined }
  }
  private storageOwns(scope: TranslationSourceScope, peerId: string | undefined, agent?: Agent, namespaceId?: string): boolean {
    if (!namespaceId) return this.owns(scope, peerId, agent)
    const topics = this.ctx.get?.('translationTopics') as { ownsLibrary(namespaceId: string, peerId: string): boolean } | undefined
    return !this.disposed && !this.storageCleanup && !!peerId && topics?.ownsLibrary(namespaceId, peerId) === true
  }
  private async currentAgent(scope: TranslationSourceScope, peerId: string | undefined, namespaceId?: string): Promise<TranslationSourceStorageResult<{ agent: Agent | undefined; generation: number }>> {
    const generation = this.storageGeneration
    if (!this.storageOwns(scope, peerId, undefined, namespaceId)) return storageBad('scope_mismatch', '原稿存储不属于此资料库连接。', 'authorize_source_storage')
    if (namespaceId || scope.namespaceId) return { ok: true, value: { agent: undefined, generation } }
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    if (!controller?.resolveAgent) return storageBad('unavailable', '宿主主会话服务尚未就绪。', 'authorize_source_storage')
    let found: Awaited<ReturnType<Controller['resolveAgent']>>
    try { found = await controller.resolveAgent(scope.mainSessionId) } catch { return storageBad('unavailable', '无法解析原稿所属主会话。', 'authorize_source_storage') }
    if (generation !== this.storageGeneration || !this.owns(scope, peerId)) return storageBad('scope_mismatch', '原稿存储所属连接或范围已变化。', 'authorize_source_storage')
    if ('error' in found) return storageBad('unavailable', '原稿所属普通主会话不可用。', 'authorize_source_storage')
    return this.owns(scope, peerId, found.agent) ? { ok: true, value: { agent: found.agent, generation } } : storageBad('scope_mismatch', '原稿存储所属主 Agent 已失效。', 'authorize_source_storage')
  }
  private async referenceTransaction<T>(scope: TranslationSourceScope, referenceKey: string, peerId: string, agent: Agent | undefined, namespaceId: string | undefined, generation: number,
    action: (storage: TranslationSourceStorage, prior: StoredSourceReference | undefined) => Promise<TranslationSourceStorageResult<T>>): Promise<TranslationSourceStorageResult<T>> {
    const key = JSON.stringify([scope, referenceKey]), previous = this.referenceQueues.get(key)
    const operation = (async (): Promise<TranslationSourceStorageResult<T>> => {
      if (previous) await previous
      if (generation !== this.storageGeneration || !this.storageOwns(scope, peerId, agent, namespaceId)) return storageBad('scope_mismatch', '原稿引用所属连接或存储范围已变化。', 'source_reference')
      let storage: TranslationSourceStorage
      try { storage = await this.storagePort() } catch { return storageBad('unavailable', '宿主原稿持久存储尚未就绪。', 'load_source_storage') }
      if (!this.storageOwns(scope, peerId, agent, namespaceId)) return storageBad('scope_mismatch', '原稿引用所属连接或 Agent 已失效。', 'source_reference')
      try {
        const prior = await storage.readReference(scope, referenceKey)
        if (!this.storageOwns(scope, peerId, agent, namespaceId)) return storageBad('scope_mismatch', '原稿引用所属连接或 Agent 已失效。', 'source_reference')
        const result = await action(storage, prior)
        if (!this.storageOwns(scope, peerId, agent, namespaceId)) return storageBad('scope_mismatch', '原稿引用所属连接或 Agent 已失效。', 'source_reference')
        return result
      } catch (error) {
        return storageBad(error instanceof TypeError || error instanceof SyntaxError ? 'source_corrupt' : 'storage_failed',
          error instanceof TypeError || error instanceof SyntaxError ? '原稿内容或引用映射校验失败。' : '原稿存储读写失败。', 'source_reference')
      }
    })()
    this.referenceQueues.set(key, operation)
    void operation.finally(() => { if (this.referenceQueues.get(key) === operation) this.referenceQueues.delete(key) })
    return operation
  }
  async storageCapabilities(): Promise<TranslationSourceStorageResult<TranslationSourceStorageCapability>> {
    if (this.disposed) return ok({ ready: false, storage: 'runtime_only', nativeOpen: false, referenceProtocol: 1, maxBytes: MAX_TRANSLATION_SOURCE_BYTES, reason: '原稿存储服务已卸载。' })
    try { await this.storagePort() } catch { return ok({ ready: false, storage: 'runtime_only', nativeOpen: false, referenceProtocol: 1, maxBytes: MAX_TRANSLATION_SOURCE_BYTES, reason: '宿主原稿持久存储尚未就绪。' }) }
    const ready = !this.disposed && typeof (this.ctx.get?.('sessionController') as Controller | undefined)?.resolveAgent === 'function'
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    return ok({ ready, storage: ready ? 'saved' : 'runtime_only', nativeOpen: ready && typeof controller?.canOpenWorkspacePath === 'function' && controller.canOpenWorkspacePath(),
      referenceProtocol: 1, maxBytes: MAX_TRANSLATION_SOURCE_BYTES, ...(ready ? {} : { reason: '宿主主会话服务尚未就绪。' }) })
  }
  async prepareSave(input: TranslationSourcePrepareSave): Promise<TranslationSourceStorageResult<TranslationSourceReference>> {
    let request: TranslationSourcePrepareSave
    try { request = parseTranslationSourceStorageRequest('prepareSave', input) as TranslationSourcePrepareSave } catch { return storageBad('invalid_input', '原稿保存参数无效。', 'prepare_source_save') }
    const peerId = this.ctx.invocation?.peer.id, authorized = await this.currentAgent(request.scope, peerId, request.namespaceId)
    if (!authorized.ok) return authorized
    const { agent, generation } = authorized.value
    const signature = JSON.stringify({ scope: request.scope, sourceRef: request.sourceRef, referenceKey: request.referenceKey, operationId: request.operationId })
    return this.referenceTransaction(request.scope, request.referenceKey, peerId!, agent, request.namespaceId, generation, async (storage, prior) => {
      if (prior) return prior.prepareOperationId === request.operationId && prior.prepareSignature === signature ? ok(prior.reference)
        : storageBad('idempotency_conflict', '此原稿引用已绑定另一保存请求。', 'prepare_source_save')
      const found = this.referenceRecord(request.scope, request.sourceRef, peerId!, agent)
      if (!found.ok) return storageBad(found.error.code === 'not_found' ? 'not_found' : found.error.code === 'scope_mismatch' ? 'scope_mismatch' :
        found.error.code === 'unavailable' ? 'unavailable' : 'source_corrupt', found.error.message, 'prepare_source_save')
      // Captured immutable bytes preserve BOM and line endings independently of attachment retention.
      await storage.writeContent(toSourceIdentity(found.value.source), new Uint8Array(found.value.bytes))
      if (!this.storageOwns(request.scope, peerId, agent, request.namespaceId)) return storageBad('scope_mismatch', '保存原稿时所属连接或 Agent 已失效。', 'prepare_source_save')
      const reference: TranslationSourceReference = { scope: request.scope, source: toSourceIdentity(found.value.source), referenceKey: request.referenceKey,
        prepareToken: `source-prepare-${crypto.randomUUID()}`, referenceVersion: 1, storage: 'saved', state: 'prepared', historyToken: null }
      await storage.writeReference({ schemaVersion: 1, reference, prepareOperationId: request.operationId, prepareSignature: signature, operations: [] })
      return ok(reference)
    })
  }
  async confirmReference(input: TranslationSourceConfirmReference): Promise<TranslationSourceStorageResult<TranslationSourceReference>> {
    let request: TranslationSourceConfirmReference
    try { request = parseTranslationSourceStorageRequest('confirmReference', input) as TranslationSourceConfirmReference } catch { return storageBad('invalid_input', '原稿引用确认参数无效。', 'confirm_source_reference') }
    const peerId = this.ctx.invocation?.peer.id, authorized = await this.currentAgent(request.scope, peerId, request.namespaceId)
    if (!authorized.ok) return authorized
    return this.referenceTransaction(request.scope, request.referenceKey, peerId!, authorized.value.agent, request.namespaceId, authorized.value.generation, async (storage, prior) => {
      if (!prior) return storageBad('not_found', '此范围的原稿引用不存在。', 'confirm_source_reference')
      const { namespaceId: _connectionNamespace, ...transaction } = request
      const signature = JSON.stringify(transaction), repeated = prior.operations.find(item => item.operationId === request.operationId)
      if (repeated) return repeated.method === 'confirmReference' && repeated.signature === signature ? ok(repeated.result) : storageBad('idempotency_conflict', '此操作标识已绑定另一引用事务。', 'confirm_source_reference')
      if (request.operationId === prior.prepareOperationId) return storageBad('idempotency_conflict', '此操作标识已用于准备保存。', 'confirm_source_reference')
      if (prior.reference.prepareToken !== request.prepareToken) return storageBad('token_mismatch', '原稿保存准备标识不一致。', 'confirm_source_reference')
      if (prior.reference.state === 'released') return storageBad('reference_released', '此原稿引用已释放。', 'confirm_source_reference')
      if (prior.reference.historyToken !== null && prior.reference.historyToken !== request.historyToken) return storageBad('idempotency_conflict', '此原稿引用已确认到另一历史提交。', 'confirm_source_reference')
      // The caller invokes this only after committing the exact Client history token; B3-03 owns that commit.
      const reference: TranslationSourceReference = { ...prior.reference, state: 'confirmed', historyToken: request.historyToken }
      await storage.writeReference({ ...prior, reference, operations: [...prior.operations, { method: 'confirmReference', operationId: request.operationId, signature, result: reference }] })
      return ok(reference)
    })
  }
  async queryReference(input: TranslationSourceQueryReference): Promise<TranslationSourceStorageResult<TranslationSourceReference>> {
    let request: TranslationSourceQueryReference
    try { request = parseTranslationSourceStorageRequest('queryReference', input) as TranslationSourceQueryReference } catch { return storageBad('invalid_input', '原稿引用查询参数无效。', 'query_source_reference') }
    const peerId = this.ctx.invocation?.peer.id, authorized = await this.currentAgent(request.scope, peerId, request.namespaceId)
    if (!authorized.ok) return authorized
    return this.referenceTransaction(request.scope, request.referenceKey, peerId!, authorized.value.agent, request.namespaceId, authorized.value.generation, async (_storage, prior) => prior ? ok(prior.reference) : storageBad('not_found', '此范围的原稿引用不存在。', 'query_source_reference'))
  }
  private confirmed(prior: StoredSourceReference | undefined, request: TranslationSourceStoredRead): TranslationSourceStorageResult<TranslationSourceReference> {
    if (!prior) return storageBad('not_found', '此范围的原稿引用不存在。', 'authorize_saved_source')
    if (!sameScope(prior.reference.scope, request.scope) || prior.reference.referenceKey !== request.referenceKey) return storageBad('scope_mismatch', '已保存原稿引用范围不一致。', 'authorize_saved_source')
    if (JSON.stringify(prior.reference.source) !== JSON.stringify(request.source)) return storageBad('source_corrupt', '已保存原稿身份与引用不一致。', 'authorize_saved_source')
    if (prior.reference.state === 'released') return storageBad('reference_released', '此原稿引用已释放。', 'authorize_saved_source')
    if (prior.reference.state !== 'confirmed') return storageBad('reference_unconfirmed', '此原稿引用尚未确认到已保存历史。', 'authorize_saved_source')
    if (prior.reference.historyToken !== request.historyToken) return storageBad('token_mismatch', '已保存原稿与历史提交标识不一致。', 'authorize_saved_source')
    return ok(prior.reference)
  }
  private async verifiedContent(storage: TranslationSourceStorage, request: TranslationSourceStoredRead, peerId: string, agent: Agent | undefined, current = () => this.storageOwns(request.scope, peerId, agent, request.namespaceId)): Promise<TranslationSourceStorageResult<{ bytes: Uint8Array; text: string }>> {
    const history = this.ctx.get?.('translationHistory') as { sourceReferenceAvailable(reference: TranslationSourceStoredRead): Promise<boolean> } | undefined
    if (history && !await history.sourceReferenceAvailable(request)) return storageBad('reference_released', '原稿所属历史已删除。', 'verify_saved_source')
    const bytes = await storage.readContent(request.source)
    if (!current()) return storageBad('scope_mismatch', '读取已保存原稿时所属连接或 Agent 已失效。', 'verify_saved_source')
    if (!bytes) return storageBad('source_missing', '已保存原稿内容不存在。', 'verify_saved_source')
    if (bytes.byteLength !== request.source.bytes) return storageBad('source_corrupt', '已保存原稿字节大小不一致。', 'verify_saved_source')
    const digest = await sourceSha256(bytes)
    if (!current()) return storageBad('scope_mismatch', '校验已保存原稿时所属连接或 Agent 已失效。', 'verify_saved_source')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return storageBad('source_corrupt', '已保存原稿不是有效 UTF-8。', 'verify_saved_source') }
    if (digest !== request.source.sha256 || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) !== request.source.bom ||
      sourceCodePointLength(text) !== request.source.totalCodePoints) return storageBad('source_corrupt', '已保存原稿内容与固定身份不一致。', 'verify_saved_source')
    if (history && !await history.sourceReferenceAvailable(request)) return storageBad('reference_released', '原稿所属历史已删除。', 'verify_saved_source')
    return { ok: true, value: { bytes, text } }
  }
  /** Read-only access proved by an exact saved history commit, independent of the old main Agent. */
  async readLibrarySource(input: LibrarySourceRequest, signal?: AbortSignal, capturedPeerId?: string): Promise<TranslationSourceStorageResult<LibrarySourceValue>> {
    let request: LibrarySourceRequest
    try { request = parseLibrarySourceRequest(input) } catch { return storageBad('invalid_input', '共享原稿读取凭据或范围无效。', 'read_library_source') }
    // In-process background restoration passes the actual peer captured at admission.
    // The public Remote supplies no third argument and uses its own invocation.
    const peerId = capturedPeerId ?? this.ctx.invocation?.peer.id
    const topics = this.ctx.get?.('translationTopics') as { ownsAssetConnection(scope: { namespaceId: string; ownerId: string }, peerId: string): boolean } | undefined
    const current = (): boolean => !this.disposed && !this.storageCleanup && !signal?.aborted && !!peerId && !!topics?.ownsAssetConnection({ namespaceId: request.namespaceId, ownerId: request.stored.scope.ownerId }, peerId)
    if (!current()) return storageBad('scope_mismatch', '共享原稿读取不属于已连接的本地资产库。', 'read_library_source')
    this.libraryReads++
    try {
      const storage = await this.storagePort(), prior = await storage.readReference(request.stored.scope, request.stored.referenceKey)
      if (!current()) return storageBad('scope_mismatch', '共享原稿连接已失效。', 'read_library_source')
      const confirmed = this.confirmed(prior, request.stored)
      if (!confirmed.ok) return confirmed
      if (confirmed.value.prepareToken !== request.prepareToken) return storageBad('token_mismatch', '共享原稿准备凭据不一致。', 'read_library_source')
      const content = await this.verifiedContent(storage, { ...request.stored, namespaceId: request.namespaceId }, peerId!, undefined, current)
      if (!content.ok) return content
      const latest = await storage.readReference(request.stored.scope, request.stored.referenceKey)
      const history = this.ctx.get?.('translationHistory') as { sourceReferenceAvailable(reference: TranslationSourceStoredRead): Promise<boolean> } | undefined
      if (history && !await history.sourceReferenceAvailable({ ...request.stored, namespaceId: request.namespaceId })) return storageBad('reference_released', '原稿所属历史已删除。', 'read_library_source')
      if (!current() || JSON.stringify(latest?.reference) !== JSON.stringify(prior?.reference)) return storageBad('scope_mismatch', '共享原稿引用或连接已变化。', 'read_library_source')
      if (request.action === 'open') {
        const controller = this.ctx.get?.('sessionController') as Controller | undefined
        if (!controller?.canOpenWorkspacePath?.()) return storageBad('unavailable', '宿主不支持在系统应用中打开原稿。', 'read_library_source')
        await controller.openWorkspacePath({ path: storage.originalPath(request.stored.source) }, signal ?? new AbortController().signal)
        return current() ? ok({ kind: 'opened' }) : storageBad('scope_mismatch', '共享原稿连接已失效。', 'read_library_source')
      }
      const offsets = indexText(content.value.text), range = request.range!
      const text = content.value.text.slice(offsets[range.start]!, offsets[range.end]!)
      if (request.action === 'page') return ok({ kind: 'page', text })
      const digest = await sourceSha256(new TextEncoder().encode(text))
      if (history && !await history.sourceReferenceAvailable({ ...request.stored, namespaceId: request.namespaceId })) return storageBad('reference_released', '原稿所属历史已删除。', 'read_library_source')
      if (!current()) return storageBad('scope_mismatch', '共享原稿连接已失效。', 'read_library_source')
      return digest === request.sha256 ? ok({ kind: 'verified' }) : storageBad('source_corrupt', '共享原稿复制范围的哈希不一致。', 'read_library_source')
    } catch { return storageBad('storage_failed', '共享原稿读取或打开未完成。', 'read_library_source') }
    finally { this.libraryReads-- }
  }
  async restore(input: TranslationSourceStoredRead): Promise<TranslationSourceStorageResult<TranslationSourceRestored>> {
    let request: TranslationSourceStoredRead
    try { request = parseTranslationSourceStorageRequest('restore', input) as TranslationSourceStoredRead } catch { return storageBad('invalid_input', '原稿恢复参数无效。', 'restore_source') }
    const peerId = this.ctx.invocation?.peer.id, authorized = await this.currentAgent(request.scope, peerId, request.namespaceId)
    if (!authorized.ok) return authorized
    return this.restoreAuthorized(request, peerId!, authorized.value.agent, authorized.value.generation)
  }
  /** Private document recovery. The actual owner bridge supplies the current Peer, never the request body. */
  async restoreForAgent(input: TranslationSourceStoredRead, peerId: string, agent: Agent): Promise<TranslationSourceStorageResult<TranslationSourceRestored>> {
    let request: TranslationSourceStoredRead
    try { request = parseTranslationSourceStorageRequest('restore', input) as TranslationSourceStoredRead } catch { return storageBad('invalid_input', '原稿恢复参数无效。', 'restore_source') }
    if (!this.storageOwns(request.scope, peerId, agent, request.namespaceId)) return storageBad('scope_mismatch', '原稿恢复不属于实际主 Agent 和负责人连接。', 'restore_source')
    return this.restoreAuthorized(request, peerId, agent, this.storageGeneration)
  }
  private restoreAuthorized(request: TranslationSourceStoredRead, peerId: string, agent: Agent | undefined, generation: number): Promise<TranslationSourceStorageResult<TranslationSourceRestored>> {
    return this.referenceTransaction(request.scope, request.referenceKey, peerId!, agent, request.namespaceId, generation, async (storage, prior) => {
      const reference = this.confirmed(prior, request)
      if (!reference.ok) return reference
      const content = await this.verifiedContent(storage, request, peerId!, agent, () => this.storageOwns(request.scope, peerId, agent, request.namespaceId))
      if (!content.ok) return content
      if (!this.storageOwns(request.scope, peerId, agent, request.namespaceId)) return storageBad('scope_mismatch', '恢复原稿时所属连接或 Agent 已失效。', 'restore_source')
      const source = parseTranslationSourceAsset({ ...request.source, persistence: 'runtime_only' })
      this.sources.set(source.sourceId, { scope: request.namespaceId ? { ...request.scope, namespaceId: request.namespaceId } : request.scope, peerId: peerId!, agent, source, text: content.value.text, bytes: content.value.bytes, codePointOffsets: indexText(content.value.text) })
      return ok({ scope: request.scope, source, referenceKey: request.referenceKey, referenceVersion: reference.value.referenceVersion, storage: 'saved', state: 'confirmed' })
    })
  }
  async openOriginal(input: TranslationSourceStoredRead, signal: AbortSignal): Promise<TranslationSourceStorageResult<{ readonly opened: true }>> {
    let request: TranslationSourceStoredRead
    try { request = parseTranslationSourceStorageRequest('openOriginal', input) as TranslationSourceStoredRead } catch { return storageBad('invalid_input', '原稿打开参数无效。', 'open_source_original') }
    signal.throwIfAborted()
    const peerId = this.ctx.invocation?.peer.id, authorized = await this.currentAgent(request.scope, peerId, request.namespaceId)
    signal.throwIfAborted()
    if (!authorized.ok) return authorized
    const { agent, generation } = authorized.value
    return this.referenceTransaction(request.scope, request.referenceKey, peerId!, agent, request.namespaceId, generation, async (storage, prior) => {
      const reference = this.confirmed(prior, request)
      if (!reference.ok) return reference
      const controller = this.ctx.get?.('sessionController') as Controller | undefined
      if (!controller?.canOpenWorkspacePath?.() || typeof controller.openWorkspacePath !== 'function') return storageBad('unavailable', '当前宿主不支持在系统应用中打开原稿。', 'open_source_original')
      const content = await this.verifiedContent(storage, request, peerId!, agent, () => this.storageOwns(request.scope, peerId, agent, request.namespaceId))
      signal.throwIfAborted()
      if (!content.ok) return content
      if (!this.storageOwns(request.scope, peerId, agent, request.namespaceId)) return storageBad('scope_mismatch', '打开原稿时所属连接或 Agent 已失效。', 'open_source_original')
      try { await controller.openWorkspacePath({ path: storage.originalPath(request.source) }, signal) }
      catch { signal.throwIfAborted(); return storageBad('open_failed', '原稿未能在系统应用中打开。', 'open_source_original') }
      signal.throwIfAborted()
      return ok({ opened: true })
    })
  }
  async releaseReference(input: TranslationSourceReleaseReference): Promise<TranslationSourceStorageResult<TranslationSourceReference>> {
    let request: TranslationSourceReleaseReference
    try { request = parseTranslationSourceStorageRequest('releaseReference', input) as TranslationSourceReleaseReference } catch { return storageBad('invalid_input', '原稿引用释放参数无效。', 'release_source_reference') }
    const peerId = this.ctx.invocation?.peer.id, authorized = await this.currentAgent(request.scope, peerId, request.namespaceId)
    if (!authorized.ok) return authorized
    return this.referenceTransaction(request.scope, request.referenceKey, peerId!, authorized.value.agent, request.namespaceId, authorized.value.generation, async (storage, prior) => {
      if (!prior) return storageBad('not_found', '此范围的原稿引用不存在。', 'release_source_reference')
      const { namespaceId: _connectionNamespace, ...transaction } = request
      const signature = JSON.stringify(transaction), repeated = prior.operations.find(item => item.operationId === request.operationId)
      if (repeated) return repeated.method === 'releaseReference' && repeated.signature === signature ? ok(repeated.result) : storageBad('idempotency_conflict', '此操作标识已绑定另一引用事务。', 'release_source_reference')
      if (request.operationId === prior.prepareOperationId) return storageBad('idempotency_conflict', '此操作标识已用于准备保存。', 'release_source_reference')
      if (request.expectedVersion !== prior.reference.referenceVersion) return storageBad('stale_version', '原稿引用版本已变化。', 'release_source_reference')
      if (prior.reference.state === 'released') return storageBad('reference_released', '此原稿引用已释放。', 'release_source_reference')
      const reference: TranslationSourceReference = { ...prior.reference, state: 'released', referenceVersion: prior.reference.referenceVersion + 1 }
      await storage.writeReference({ ...prior, reference, operations: [...prior.operations, { method: 'releaseReference', operationId: request.operationId, signature, result: reference }] })
      return ok(reference)
    })
  }
  hasActiveJobs(): boolean { return this.pending.size > 0 || this.referenceQueues.size > 0 || this.libraryReads > 0 }
  historyUnitBusy(scope: HistoryScope, unitId: string): boolean {
    if (unitId !== '*') return false
    return [...this.pending.keys()].some(signature => {
      const [, , topicId, translationSessionId] = JSON.parse(signature) as string[]
      return historyTargetMatches(scope, unitId, { topicId, translationSessionId })
    }) || [...this.referenceQueues.keys()].some(signature => historyTargetMatches(scope, unitId, JSON.parse(signature)[0]))
  }
  heldSourceDigests(ids: ReadonlySet<string>): readonly string[] { return [...this.sources].filter(([id]) => ids.has(id)).map(([, record]) => record.source.sha256) }
  forgetSourceIds(ids: ReadonlySet<string>, retained: ReadonlySet<string>): void {
    for (const id of ids) if (!retained.has(id)) {
      this.sources.delete(id)
      for (const [receipt, sourceId] of this.receipts) if (sourceId === id) { this.receipts.delete(receipt); this.bindings.delete(receipt) }
    }
  }
  /** Scoped file cleanup must not split a source's content write and reference commit. */
  beginStorageCleanup(): (() => void) | undefined {
    if (this.disposed || this.storageCleanup || this.hasActiveJobs()) return undefined
    this.storageCleanup = true
    this.storageGeneration++
    return () => { this.storageCleanup = false }
  }
  forgetTopic(topicId: string, ownerId: string, namespaceId?: string): void {
    for (const [id, record] of this.sources) if (record.scope.topicId === topicId &&
      (record.scope.namespaceId && namespaceId ? record.scope.namespaceId === namespaceId : record.scope.ownerId === ownerId)) this.sources.delete(id)
  }
  forgetSession(namespaceId: string, sessionId: string): void {
    for (const [id, record] of this.sources) if (record.scope.namespaceId === namespaceId && record.scope.translationSessionId === sessionId) this.sources.delete(id)
  }
  dispose(): void { this.disposed = true; this.sources.clear(); this.receipts.clear(); this.bindings.clear(); this.pending.clear(); this.referenceQueues.clear(); this.storage = undefined; this.storageInstance = undefined }
}
export function installTranslationSources(ctx: QuickHostContext, registerRemote = true, options: TranslationSourceHostOptions = {}): TranslationSourcesService {
  if (ctx.root && !Object.hasOwn(ctx.root.reflect.props, 'invocation')) ctx.root.accessor('invocation', { get: () => undefined })
  const service = new TranslationSourcesService(ctx, options); ctx.provide('translationSources', service)
  const register = (scope: QuickHostContext): void => {
    const registry = (scope.get?.('typert') ?? scope.typert) as QuickHostContext['typert']
    registry?.register({ package: TRANSLATION_SOURCES_REMOTE.package, face: 'host', schemas: [], invocations: [...TRANSLATION_SOURCES_REMOTE.descriptors, ...TRANSLATION_SOURCE_STORAGE_REMOTE.descriptors, ...TRANSLATION_SOURCE_INTEGRITY_REMOTE.descriptors],
      model: { package: TRANSLATION_SOURCES_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
  }
  if (registerRemote) { if (ctx.inject) ctx.inject(['typert'], register); else register(ctx) }
  ctx.effect?.(() => () => service.dispose(), 'translation runtime sources lifetime')
  return service
}
