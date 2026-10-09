import { MAX_TRANSLATION_SOURCE_BYTES, TRANSLATION_SOURCES_REMOTE, parseTranslationSourceAsset, parseTranslationSourceRequest, parseTranslationSourceScope,
  translationSourceResultBytes, type TranslationSourceAsset, type TranslationSourceAssetPage, type TranslationSourceAssetRead,
  type TranslationSourceCapability, type TranslationSourceErrorCode, type TranslationSourceImport, type TranslationSourceResult,
  type TranslationSourceScope } from '../shared/translation-sources.js'
import { MAX_TRANSLATION_SOURCE_PAGE_BYTES, MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { QuickHostContext } from './quick-translation.js'

interface Agent { readonly id: string; readonly session: { readonly id: string }; readonly ctx: unknown }
interface FileRef { readonly attachmentId: string; readonly name: string; readonly bytes: number }
interface Attachments { readFileStream(ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array> }
interface Uploads { resolve(agent: Agent, receiptId: string): FileRef | undefined }
interface Controller { resolveAgent(id: string): Promise<{ readonly agent: Agent } | { readonly error: unknown }> }
interface SourceRecord { readonly scope: TranslationSourceScope; readonly peerId: string; readonly agent: Agent; readonly source: TranslationSourceAsset; readonly text: string; readonly codePointOffsets: Uint32Array }
interface Pending { readonly peerId: string; readonly agent: Agent; readonly promise: Promise<TranslationSourceResult<TranslationSourceAsset>> }
function ok<T>(value: T): TranslationSourceResult<T> { return { ok: true, value: structuredClone(value) } }
function bad<T>(code: TranslationSourceErrorCode, message: string, stage: string): TranslationSourceResult<T> { return { ok: false, error: { code, message, stage } } }
function sameScope(a: TranslationSourceScope, b: TranslationSourceScope): boolean {
  return a.ownerId === b.ownerId && a.mainSessionId === b.mainSessionId && a.topicId === b.topicId && a.translationSessionId === b.translationSessionId
}

/** Runtime source content only. Native attachments retain their own DSH storage policy. */
export class TranslationSourcesService {
  readonly typertRemote: { readonly service: TranslationSourcesService; readonly serviceKey: 'translationSources'; readonly namespace: 'translationSources' }
  private readonly sources = new Map<string, SourceRecord>()
  private readonly receipts = new Map<string, string>()
  private readonly bindings = new Map<string, { readonly signature: string; readonly peerId: string }>()
  private readonly pending = new Map<string, Pending>()
  private disposed = false
  constructor(readonly ctx: QuickHostContext) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationSources', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationSources', namespace: 'translationSources' })
  }
  private owns(scope: TranslationSourceScope, peerId: string | undefined, agent?: Pick<Agent, 'id' | 'session'>): boolean {
    const topics = this.ctx.get?.('translationTopics') as { ownsConnection(ownerId: string, peerId: string): boolean } | undefined
    const agents = this.ctx.get?.('agents') as { get(id: string): Agent | undefined } | undefined
    return !this.disposed && !!peerId && !!topics?.ownsConnection(scope.ownerId, peerId) && (!agent ||
      agent.id === scope.mainSessionId && agent.session.id === scope.mainSessionId && agents?.get(scope.mainSessionId) === agent)
  }
  private ready(): boolean {
    const attachments = this.ctx.get?.('attachments') as Attachments | undefined, uploads = this.ctx.get?.('fileUploads') as Uploads | undefined
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    return !this.disposed && typeof attachments?.readFileStream === 'function' && typeof uploads?.resolve === 'function' && typeof controller?.resolveAgent === 'function'
  }
  async capabilities(): Promise<TranslationSourceResult<TranslationSourceCapability>> {
    const ready = this.ready()
    return ok({ ready, storage: 'runtime_only', encoding: 'utf-8', maxBytes: MAX_TRANSLATION_SOURCE_BYTES,
      maxPageCodePoints: MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, maxPageBytes: MAX_TRANSLATION_SOURCE_PAGE_BYTES,
      ...(ready ? {} : { reason: '宿主 TXT 上传及附件读取服务尚未就绪。' }) })
  }
  private referenceRecord(scope: TranslationSourceScope, source: TranslationSourceAsset, peerId: string,
    agent?: Pick<Agent, 'id' | 'session'>): TranslationSourceResult<SourceRecord> {
    if (!this.ready()) return bad('unavailable', '宿主固定源资产服务尚未就绪。', 'resolve_source')
    if (!this.owns(scope, peerId, agent)) return bad('scope_mismatch', '固定源资产不属于此主会话连接或 Agent。', 'resolve_source')
    const record = this.sources.get(source.sourceId)
    if (!record || !sameScope(record.scope, scope)) return bad('not_found', '此范围的固定源资产不存在。', 'resolve_source')
    if (record.peerId !== peerId || !this.owns(scope, peerId, record.agent) || (agent && record.agent !== agent)) return bad('scope_mismatch', '固定源资产所属连接或主 Agent 已失效。', 'resolve_source')
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
  /** Called only after Materials confirms this exact material was delivered to the actual main Agent. */
  readForAgent(scope: TranslationSourceScope, source: TranslationSourceAsset, range: TranslationSourceRange, peerId: string,
    agent: Pick<Agent, 'id' | 'session'>): TranslationSourceResult<{ readonly totalCodePoints: number; readonly text: string }> {
    const found = this.referenceRecord(scope, source, peerId, agent)
    if (!found.ok) return found
    return this.slice(found.value, range)
  }
  private slice(record: SourceRecord, range: TranslationSourceRange): TranslationSourceResult<{ readonly totalCodePoints: number; readonly text: string }> {
    const { start, end } = range
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return bad('invalid_range', '原文读取范围无效。', 'read_source')
    if (end - start > MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) return bad('page_too_large', '每页最多 4000 个 Unicode 码点，未截断。', 'read_source')
    if (end > record.source.totalCodePoints) return bad('range_out_of_bounds', '范围超出固定原文长度，未截断。', 'read_source')
    return { ok: true, value: { totalCodePoints: record.source.totalCodePoints,
      text: record.text.slice(record.codePointOffsets[start]!, record.codePointOffsets[end]!) } }
  }
  async importReceipt(input: TranslationSourceImport, signal: AbortSignal): Promise<TranslationSourceResult<TranslationSourceAsset>> {
    let request: TranslationSourceImport
    try { request = parseTranslationSourceRequest('importReceipt', input) as TranslationSourceImport } catch { return bad('invalid_input', 'TXT 导入参数无效。', 'resolve_upload') }
    const peerId = this.ctx.invocation?.peer.id
    if (!this.owns(request.scope, peerId)) return bad('scope_mismatch', 'TXT 导入不属于此主会话连接。', 'resolve_upload')
    signal.throwIfAborted()
    const attachments = this.ctx.get?.('attachments') as Attachments | undefined, uploads = this.ctx.get?.('fileUploads') as Uploads | undefined
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    if (typeof attachments?.readFileStream !== 'function' || typeof uploads?.resolve !== 'function' || !controller?.resolveAgent) return bad('unavailable', '宿主 TXT 上传及附件读取服务尚未就绪。', 'resolve_upload')
    const bindingKey = JSON.stringify([request.scope.ownerId, request.idempotencyKey])
    const signature = JSON.stringify([request.scope.ownerId, request.scope.mainSessionId, request.scope.topicId, request.scope.translationSessionId, request.receiptId])
    const binding = this.bindings.get(bindingKey)
    if (binding && binding.signature !== signature) return bad('idempotency_conflict', '此导入请求标识已绑定另一份范围或上传收据。', 'resolve_upload')
    if (binding && binding.peerId !== peerId) return bad('scope_mismatch', '此导入请求属于另一连接。', 'resolve_upload')
    this.bindings.set(bindingKey, { signature, peerId: peerId! })
    let found: Awaited<ReturnType<Controller['resolveAgent']>>
    try { found = await controller.resolveAgent(request.scope.mainSessionId) }
    catch { signal.throwIfAborted(); return bad('unavailable', '无法解析所属主会话的上传服务。', 'resolve_upload') }
    signal.throwIfAborted()
    if ('error' in found) return bad('unavailable', '所属普通主会话不可用。', 'resolve_upload')
    const agent = found.agent
    // Gateway invocation is synchronous. All later checks use the captured peer and exact Agent.
    if (!this.owns(request.scope, peerId, agent)) return bad('scope_mismatch', '上传主 Agent 身份或所属连接已失效。', 'resolve_upload')
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
    if (!this.owns(request.scope, peerId, agent)) return bad('scope_mismatch', 'TXT 导入所属连接或 Agent 已失效。', 'resolve_upload')
    return result
  }
  private async decode(scope: TranslationSourceScope, peerId: string, agent: Agent, file: FileRef, attachments: Attachments,
    signal: AbortSignal, signature: string): Promise<TranslationSourceResult<TranslationSourceAsset>> {
    if (typeof file.name !== 'string' || !/\.txt$/iu.test(file.name)) return bad('unsupported_file', '首版只支持 UTF-8 TXT 原件。', 'decode_txt')
    if (sourceCodePointLength(file.name) > 255 || /[\\/<>:"|?*\u0000-\u001f\u007f]/u.test(file.name)) return bad('invalid_input', '宿主返回的 TXT 原件名称无效。', 'resolve_upload')
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) return bad('integrity_failed', '上传原件字节元信息无效。', 'read_original')
    if (file.bytes > MAX_TRANSLATION_SOURCE_BYTES) return bad('source_too_large', 'TXT 原件超过 2 MiB 上限，未导入。', 'read_original')
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), chunks: Uint8Array[] = [], pieces: string[] = []
    let count = 0, invalidUtf8 = false
    try {
      for await (const chunk of attachments.readFileStream(file, signal)) {
        signal.throwIfAborted()
        count += chunk.byteLength
        if (count > MAX_TRANSLATION_SOURCE_BYTES) return bad('source_too_large', 'TXT 原件流超过 2 MiB 上限，未导入。', 'read_original')
        if (count > file.bytes) return bad('integrity_failed', '上传原件实际字节与元信息不一致。', 'read_original')
        chunks.push(new Uint8Array(chunk))
        try { pieces.push(decoder.decode(chunk, { stream: true })) } catch { invalidUtf8 = true; break }
      }
    } catch { signal.throwIfAborted(); return bad('integrity_failed', '原件不存在或附件完整性校验失败。', 'read_original') }
    signal.throwIfAborted()
    if (invalidUtf8) return bad('invalid_utf8', '原件不是有效 UTF-8，未猜测或替换编码。', 'decode_txt')
    if (count !== file.bytes) return bad('integrity_failed', '上传原件实际字节与元信息不一致。', 'read_original')
    try { pieces.push(decoder.decode()) } catch { return bad('invalid_utf8', '原件不是完整有效的 UTF-8，未猜测或替换编码。', 'decode_txt') }
    const text = pieces.join(''), totalCodePoints = sourceCodePointLength(text)
    if (!totalCodePoints) return bad('empty_source', 'TXT 原件没有可读取的正文。', 'decode_txt')
    const codePointOffsets = new Uint32Array(totalCodePoints + 1)
    let codePoint = 0, utf16Offset = 0
    for (const point of text) { codePointOffsets[codePoint++] = utf16Offset; utf16Offset += point.length }
    codePointOffsets[totalCodePoints] = text.length
    const bytes = new Uint8Array(count)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))
    signal.throwIfAborted()
    if (!this.owns(scope, peerId, agent)) return bad('scope_mismatch', 'TXT 准备完成前所属连接或 Agent 已失效。', 'decode_txt')
    const source = parseTranslationSourceAsset({ sourceId: `source-${crypto.randomUUID()}`, version: 1, name: file.name, bytes: count,
      totalCodePoints, encoding: 'utf-8', bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), persistence: 'runtime_only' })
    this.sources.set(source.sourceId, { scope, peerId, agent, source, text, codePointOffsets }); this.receipts.set(signature, source.sourceId)
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
    if (record.peerId !== peerId || !this.owns(request.scope, peerId, record.agent)) return bad('scope_mismatch', '原文所属连接或主 Agent 已失效。', 'read_source')
    if (request.version !== record.source.version) return bad('stale_version', '引用的固定源资产版本不一致。', 'read_source')
    const page = this.slice(record, request.range)
    if (!page.ok) return page
    const result = ok({ scope: request.scope, source: record.source, range: request.range, text: page.value.text })
    return translationSourceResultBytes(result) > MAX_TRANSLATION_SOURCE_PAGE_BYTES ? bad('page_too_large', '完整分页回复超过 32768 UTF-8 字节，未截断。', 'read_source') : result
  }
  dispose(): void { this.disposed = true; this.sources.clear(); this.receipts.clear(); this.bindings.clear(); this.pending.clear() }
}
export function installTranslationSources(ctx: QuickHostContext, registerRemote = true): TranslationSourcesService {
  if (ctx.root && !Object.hasOwn(ctx.root.reflect.props, 'invocation')) ctx.root.accessor('invocation', { get: () => undefined })
  const service = new TranslationSourcesService(ctx); ctx.provide('translationSources', service)
  const register = (scope: QuickHostContext): void => {
    const registry = (scope.get?.('typert') ?? scope.typert) as QuickHostContext['typert']
    registry?.register({ package: TRANSLATION_SOURCES_REMOTE.package, face: 'host', schemas: [], invocations: TRANSLATION_SOURCES_REMOTE.descriptors,
      model: { package: TRANSLATION_SOURCES_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
  }
  if (registerRemote) { if (ctx.inject) ctx.inject(['typert'], register); else register(ctx) }
  ctx.effect?.(() => () => service.dispose(), 'translation runtime sources lifetime')
  return service
}
