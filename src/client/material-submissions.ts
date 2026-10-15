import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope, type TranslationMaterialScope } from '../shared/translation-material.js'
import { parseTranslationMaterialResult, type TranslationMaterialsPort, type TranslationMaterialCapability, type TranslationMaterialReceipt, type TranslationMaterialQuery, type TranslationMaterialResult } from '../shared/translation-material-remote.js'
import { MAX_TOPIC_BRIDGE_REPLY_BYTES } from '../shared/topic-bridge.js'
import { INLINE_TRANSLATION_SOURCE_CODE_POINTS } from '../shared/translation-source-read.js'
import type { NormalTranslationMaterialTarget } from '../shared/normal-translation.js'
import type { SessionStore } from './session-store.js'
import type { LocalSession } from './sessions.js'
import type { TopicBridgeClient } from './topic-bridge.js'
import { MAX_TRANSLATION_SOURCE_BYTES, type TranslationSourcesPort, type TranslationSourceCapability } from '../shared/translation-sources.js'
import type { NativeFileUploadPort } from './object-assets-client.js'
import type {
  ComposerExtensionService,
  ComposerSubmissionAdapter,
  ComposerSubmissionGesture,
  ComposerSubmissionOutcome,
} from 'dsh-composer-extension/contracts'

export type MaterialSubmissionGesture = ComposerSubmissionGesture
export type MaterialSubmissionOutcome = ComposerSubmissionOutcome
export type MaterialSubmissionContribution = Pick<ComposerSubmissionAdapter, 'freeze'>
export type MaterialSubmissionRegistry = ComposerExtensionService
type ComposerOwner = Parameters<ComposerExtensionService['register']>[0]
export interface NativeMaterialSubmissionRegistry {
  readonly protocolVersion?: number
  register(owner: ComposerOwner, contribution: MaterialSubmissionContribution): () => void
}
export type TranslationMaterialsRemotePort = { [K in keyof TranslationMaterialsPort]: (...args: Parameters<TranslationMaterialsPort[K]>) => Promise<unknown> }
type Remote = TranslationMaterialsRemotePort | (() => Promise<TranslationMaterialsRemotePort | undefined>) | undefined
interface Options {
  readonly store: SessionStore
  readonly topics: Pick<TopicBridgeClient, 'getStatus' | 'retain' | 'subscribe'>
  readonly remote: Remote
  readonly registry?: MaterialSubmissionRegistry | undefined
  readonly owner: ComposerOwner
  readonly composerReason?: string
  readonly upload?: NativeFileUploadPort
  readonly sources?: TranslationSourcesPort
}
interface SelectedFile { readonly file: File; readonly version: number }
interface PastedTextCarrier { readonly kind: 'pasted_text'; readonly text: string; readonly name: string; readonly bytes: number; readonly totalCodePoints: number }
type SourceCarrier = { readonly kind: 'selected_file'; readonly selected: SelectedFile } | PastedTextCarrier
interface FrozenDraft { readonly session: LocalSession; readonly draftVersion: number; readonly materialId: string; readonly signature: string; readonly carrier?: SourceCarrier }
interface Submission {
  readonly identity: TranslationMaterialScope
  readonly kind: TranslationMaterialEnvelope['kind']
  readonly draft: FrozenDraft | undefined
  readonly generation: number
  envelope: TranslationMaterialEnvelope | undefined
  readonly sessionId: string | undefined
  readonly direct: boolean
  stage: 'frozen' | 'preparing' | 'prepared' | 'submitted' | 'attached' | 'unknown' | 'released' | 'failed'
  reason: string | undefined
  finished: boolean
  started: boolean
  settling: boolean
  consumed?: boolean
  sent?: boolean
  preparation?: Promise<void>
  controller?: AbortController
  hostStarted: boolean
}
export interface MaterialSubmissionStatus {
  readonly busy: boolean
  readonly blocked: string | undefined
  readonly message: string | undefined
  readonly unknown: boolean
}
export interface LongDraftSource { readonly name: string; readonly bytes: number; readonly totalCodePoints: number }
const SEAM_MISSING = '普通模式暂不可用：当前 DSH 缺少同步发送材料接口。'
const FILE_AND_TEXT = '待译原文与 TXT 请选择一种；请移除文件或清空待译原文，翻译要求仍在主输入区发送。'
const BYTE_BLOCKED = `材料超过传输上限（${MAX_TOPIC_BRIDGE_REPLY_BYTES} 字节）。请缩短待译稿；内容未截断。`
function id(): string { return crypto.randomUUID() }
function sameScope(a: TranslationMaterialScope, b: TranslationMaterialScope): boolean {
  return a.ownerId === b.ownerId && a.mainSessionId === b.mainSessionId && a.requestId === b.requestId && a.operationId === b.operationId
}
function signature(session: LocalSession, fileVersion: number): string {
  return JSON.stringify([session.input, session.targetLanguage, session.instruction, session.model, session.maxInputChars, fileVersion])
}
function detail(error: unknown): string { return error instanceof Error ? error.message : '材料提交未完成，草稿保留。' }
/** Reject lone UTF-16 surrogates before any UTF-8 encoder can replace them. */
function pastedTextSize(text: string): { readonly bytes: number; readonly totalCodePoints: number } {
  let bytes = 0, totalCodePoints = 0
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) throw new Error('待译原文含有不完整的 Unicode 字符，请修正后重试；正文保留。')
    totalCodePoints++
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  if (bytes > MAX_TRANSLATION_SOURCE_BYTES) throw new Error('待译原文超过 2 MiB UTF-8 上限；正文保持完整。')
  return { bytes, totalCodePoints }
}
function composerReasonLabel(reason?: string): string {
  if (reason === 'composer_submissions_unavailable') return '普通模式暂不可用：Composer 扩展已加载，但当前 DSH 缺少同步发送材料接口；请安装匹配的宿主补丁并重启 DSH。'
  if (reason === 'composer_extension_disposed' || reason === 'composer_extension_unavailable') return '普通模式暂不可用：Composer 扩展尚未就绪。'
  if (reason === 'composer_protocol_undeclared') return `当前 DSH 的同步提交接口未声明协议版本（${reason}）。`
  if (reason?.startsWith('composer_protocol_unsupported')) return `当前 DSH 的同步提交协议版本不受支持（${reason}）。`
  return reason ?? SEAM_MISSING
}

/** One root lifetime owns capture, bridge retention and immutable submission receipts. */
export class MaterialSubmissionsClient {
  private readonly submissions = new Map<string, Submission>()
  private readonly versions = new Map<string, { signature: string; version: number }>()
  private readonly files = new Map<string, SelectedFile>()
  private readonly fileVersions = new Map<string, number>()
  private readonly omitted = new Map<string, { revision: number; selected: boolean }>()
  private readonly retained = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()
  private readonly stopStore: () => void
  private readonly stopTopics: () => void
  private unregister: (() => void) | undefined
  private registry: MaterialSubmissionRegistry | undefined
  private composerReason: string | undefined
  private capability: TranslationMaterialCapability | undefined
  private sourceCapability: TranslationSourceCapability | undefined
  private sourceReason: string | undefined
  private serviceReason: string | undefined
  private loading: Promise<void> | undefined
  private generation = 0
  private disposed = false
  constructor(private readonly options: Options) {
    this.stopStore = options.store.subscribe(() => { this.reconcile(); this.emit() })
    this.stopTopics = options.topics.subscribe(() => this.emit())
    this.setComposerBridge(options.registry, options.composerReason)
    this.reconcile()
    void this.load()
  }
  setComposerBridge(registry?: MaterialSubmissionRegistry, reason?: string): void {
    if (this.disposed || (this.registry === registry && this.composerReason === reason)) return
    this.unregister?.()
    this.unregister = undefined
    this.registry = undefined
    this.composerReason = reason
    this.unregister = registry?.register(this.options.owner, {
      key: 'dsh-translation-plugin.material-submissions',
      freeze: gesture => this.freeze(gesture),
    })
    this.registry = registry
    this.emit()
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private draftVersion(session: LocalSession): number {
    const current = signature(session, this.fileVersions.get(session.id) ?? 0), old = this.versions.get(session.id)
    if (old?.signature === current) return old.version
    const version = (old?.version ?? 0) + 1
    this.versions.set(session.id, { signature: current, version })
    return version
  }
  private live(session: LocalSession): boolean {
    return session.archivedAt === null && !this.options.store.isSessionDeleted(session.id) &&
      this.options.store.getTopics(session.ownerId).some(topic => topic.id === session.topicId)
  }
  private reconcile(): void {
    if (this.disposed) return
    const needed = new Set<string>()
    for (const owner of this.options.store.getOwnerIds()) for (const session of this.options.store.getAvailableSessions(owner)) {
      this.draftVersion(session)
      if (session.mode === 'normal' && this.live(session) && (session.input.trim() || this.files.has(session.id))) needed.add(owner)
    }
    for (const sessionId of this.files.keys()) if (!this.options.store.getSession(sessionId)) this.files.delete(sessionId)
    for (const item of this.submissions.values()) if (item.settling || ['frozen', 'preparing', 'prepared', 'unknown'].includes(item.stage) ||
      (!item.consumed && item.kind === 'material' && ['submitted', 'attached'].includes(item.stage))) needed.add(item.identity.ownerId)
    for (const owner of needed) if (!this.retained.has(owner)) this.retained.set(owner, this.options.topics.retain(owner))
    for (const [owner, release] of this.retained) if (!needed.has(owner)) { this.retained.delete(owner); release() }
  }
  setFileSelected(sessionId: string, file: File | undefined): void {
    const version = (this.fileVersions.get(sessionId) ?? 0) + 1
    this.fileVersions.set(sessionId, version)
    if (file) this.files.set(sessionId, { file, version }); else this.files.delete(sessionId)
    this.reconcile(); this.emit()
  }
  getSelectedFile(sessionId: string): File | undefined { return this.files.get(sessionId)?.file }
  /** Sent files are immutable records, separate from the next editable draft. */
  getSentFiles(sessionId: string): readonly { readonly materialId: string; readonly name: string; readonly sourceId: string | undefined }[] {
    return [...this.submissions.values()].filter(item => item.sessionId === sessionId && item.sent && item.draft?.carrier?.kind === 'selected_file')
      .map(item => ({ materialId: item.draft!.materialId,
        name: item.draft!.carrier!.kind === 'selected_file' ? item.draft!.carrier!.selected.file.name : item.draft!.carrier!.name,
        sourceId: item.envelope?.kind === 'material' ? item.envelope.material.sourceRef?.sourceId : undefined }))
  }
  private confirmSent(item: Submission): void {
    if (item.sent || !item.draft) return
    item.sent = true
    const carrier = item.draft.carrier, sessionId = item.draft.session.id
    if (carrier?.kind === 'selected_file' && this.files.get(sessionId)?.version === carrier.selected.version) {
      this.files.delete(sessionId)
      this.fileVersions.set(sessionId, (this.fileVersions.get(sessionId) ?? 0) + 1)
    }
  }
  clearSelectedFiles(ownerId: string): void {
    for (const sessionId of [...this.files.keys()]) if (this.options.store.getSession(sessionId)?.ownerId === ownerId) this.setFileSelected(sessionId, undefined)
  }
  setOmit(ownerId: string, omitted: boolean): void {
    this.omitted.set(ownerId, { revision: (this.omitted.get(ownerId)?.revision ?? 0) + 1, selected: omitted })
    this.emit()
  }
  getAttachment(ownerId: string): { readonly label: string; readonly omitted: boolean; readonly available: boolean } | undefined {
    const session = this.options.store.getActiveSession(ownerId)
    if (!session || session.mode !== 'normal' || !this.live(session) || (!session.input.trim() && !this.files.has(session.id))) return undefined
    return { label: this.unregister ? `附带待译稿：${session.remark || session.name}` : composerReasonLabel(this.composerReason),
      omitted: this.omitted.get(ownerId)?.selected ?? false, available: !!this.unregister }
  }
  private async port(): Promise<TranslationMaterialsRemotePort> {
    const remote = typeof this.options.remote === 'function' ? await this.options.remote() : this.options.remote
    if (!remote) throw new Error('材料提交服务尚未就绪。')
    return remote
  }
  private async call<T>(method: keyof TranslationMaterialsPort, request?: TranslationMaterialEnvelope | TranslationMaterialScope | Parameters<TranslationMaterialsPort['finish']>[0], guard?: () => void): Promise<T> {
    const port = await this.port()
    guard?.()
    const response = await (method === 'capabilities' ? port.capabilities() : (port[method] as (request: unknown) => Promise<unknown>).call(port, request))
    if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) throw new Error('未取得材料服务传输回执；提交结果尚不确定。')
    const result = parseTranslationMaterialResult(method, (response as { value?: unknown }).value) as TranslationMaterialResult<T>
    if (!result.ok) throw new MaterialRejected(result.error.message, result.error.code)
    return result.value
  }
  load(): Promise<void> {
    if (this.loading) return this.loading
    const generation = this.generation
    const material = this.call<TranslationMaterialCapability>('capabilities').then(value => {
      if (!this.disposed && generation === this.generation) { this.capability = value; this.serviceReason = value.reason }
    }).catch(error => { if (!this.disposed && generation === this.generation) { this.capability = undefined; this.serviceReason = detail(error) } })
    const source = this.options.sources?.capabilities().then(result => {
      if (!this.disposed && generation === this.generation) {
        this.sourceCapability = result.ok ? result.value : undefined
        this.sourceReason = result.ok ? result.value.reason : result.error.message
      }
    }).catch(error => { if (!this.disposed && generation === this.generation) { this.sourceCapability = undefined; this.sourceReason = detail(error) } })
    this.loading = Promise.all([material, source]).then(() => {}).finally(() => { if (generation === this.generation) { this.loading = undefined; this.emit() } })
    return this.loading
  }
  private inputReason(session: LocalSession): string | undefined {
    if (!this.live(session)) return '会话已归档、删除或主题不可用，草稿保留。'
    const file = this.files.get(session.id)?.file
    if (file) {
      if (session.input.trim()) return FILE_AND_TEXT
      if (!/\.txt$/iu.test(file.name)) return '首版只支持 UTF-8 TXT 原稿，请选择 .txt 文件。'
      if (!file.size) return 'TXT 原稿为空，请选择有内容的文件。'
      if (file.size > MAX_TRANSLATION_SOURCE_BYTES) return 'TXT 原稿超过 2 MiB 上限；所选文件保留。'
      return undefined
    }
    if (!session.input.trim()) return this.getSentFiles(session.id).length
      ? '文件已发送；可在主会话继续说明处理要求，或添加新的待译材料。' : '请输入待译材料。'
    try { pastedTextSize(session.input) } catch (error) { return detail(error) }
    return undefined
  }
  private readiness(ownerId: string, file = false): string | undefined {
    if (!this.unregister) return composerReasonLabel(this.composerReason)
    if (!this.capability?.ready || !this.capability.directSubmit) return this.serviceReason ?? '正在检查材料提交服务…'
    const topic = this.options.topics.getStatus(ownerId)
    if (!topic.ready) return topic.reason ?? '正在连接此主会话的材料通道…'
    if (file && (!this.options.upload || !this.sourceCapability?.ready)) return this.sourceReason ?? 'TXT 原稿上传或导入服务尚未就绪。'
    return undefined
  }
  private boundedEnvelope(value: unknown): TranslationMaterialEnvelope {
    const envelope = parseTranslationMaterialEnvelope(value)
    // Shared bounded bridge margin leaves room for Gateway's RPC wrapper (256 KiB uplink).
    if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) throw new Error(BYTE_BLOCKED)
    return envelope
  }
  private config(draft: FrozenDraft) {
    const session = draft.session
    return { materialId: draft.materialId, sourceVersion: 1, topicId: session.topicId, translationSessionId: session.id,
      draftVersion: draft.draftVersion, targetLanguage: session.targetLanguage, instruction: session.instruction,
      model: session.model, maxInputChars: session.maxInputChars }
  }
  getStatus(sessionId: string): MaterialSubmissionStatus {
    const session = this.options.store.getSession(sessionId)
    const latest = [...this.submissions.values()].filter(item => item.sessionId === sessionId).at(-1)
    const busy = !!latest && ['frozen', 'preparing', 'prepared'].includes(latest.stage)
    const unknown = latest?.stage === 'unknown'
    let blocked = session ? this.inputReason(session) : '翻译会话不存在。'
    if (!blocked && session) {
      try { blocked = this.readiness(session.ownerId, this.files.has(session.id) || !!this.previewPastedCarrier(session)) }
      catch (error) { blocked = detail(error) }
    }
    if (busy) blocked = '正在提交材料…'
    if (unknown) blocked = '提交结果尚不确定，请先检查提交状态。'
    let message = latest?.reason
    if (this.getSentFiles(sessionId).length && !session?.input.trim() && !this.files.has(sessionId)) message = '文件已发送并冻结；待处理文件见会话记录。'
    else if (latest?.consumed) message = session && latest.draft && this.draftVersion(session) !== latest.draft.draftVersion
      ? '翻译业务已受理；当前草稿的后续修改保留。' : '翻译业务已受理；原提交材料已记录。'
    else if (latest?.draft && ['submitted', 'attached'].includes(latest.stage)) {
      const sent = latest.draft.draftVersion, current = session ? this.draftVersion(session) : sent
      message = current === sent ? `已向主会话提交草稿版本 ${sent}；待译草稿保留。`
        : `已提交的是草稿版本 ${sent}；当前草稿为版本 ${current}。`
    }
    return { busy, blocked, message, unknown }
  }
  private pastedCarrier(draft: FrozenDraft, identity: TranslationMaterialScope): PastedTextCarrier | undefined {
    const text = draft.session.input, size = pastedTextSize(text)
    const inline = { ...identity, kind: 'material', material: { ...this.config(draft), sourceText: text } }
    if (size.totalCodePoints > INLINE_TRANSLATION_SOURCE_CODE_POINTS || size.totalCodePoints > draft.session.maxInputChars ||
      new TextEncoder().encode(JSON.stringify(inline)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) {
      // Check the frozen config and scope before starting any upload; only the source transport changes.
      this.boundedEnvelope({ ...inline, material: { ...this.config(draft), sourceText: 'x' } })
      return { kind: 'pasted_text', text, name: '长原稿.txt', ...size }
    }
    this.boundedEnvelope(inline)
    return undefined
  }
  private previewPastedCarrier(session: LocalSession): PastedTextCarrier | undefined {
    const previewId = '00000000-0000-0000-0000-000000000000'
    return this.pastedCarrier({ session, materialId: previewId, draftVersion: this.draftVersion(session), signature: '' },
      { ownerId: session.ownerId, mainSessionId: session.ownerId, requestId: previewId, operationId: previewId })
  }
  /** Editable draft projection; actual capture uses the exact submission identity in record(). */
  getLongDraft(sessionId: string): LongDraftSource | undefined {
    const session = this.options.store.getSession(sessionId)
    if (!session || session.mode !== 'normal' || this.files.has(session.id) || !session.input.trim()) return undefined
    try {
      const carrier = this.previewPastedCarrier(session)
      return carrier ? { name: carrier.name, bytes: carrier.bytes, totalCodePoints: carrier.totalCodePoints } : undefined
    } catch { return undefined }
  }
  private record(session: LocalSession | undefined, ownerId: string, requestId: string, kind: TranslationMaterialEnvelope['kind'], direct: boolean): Submission {
    const identity = { ownerId, mainSessionId: ownerId, requestId, operationId: id() }
    const selected = session ? this.files.get(session.id) : undefined
    const captured: FrozenDraft | undefined = kind === 'material' && session ? { session: structuredClone(session), draftVersion: this.draftVersion(session),
      materialId: id(), signature: signature(session, this.fileVersions.get(session.id) ?? 0) } : undefined
    const carrier = captured ? selected ? { kind: 'selected_file' as const, selected } : this.pastedCarrier(captured, identity) : undefined
    const draft = captured && carrier ? { ...captured, carrier } : captured
    const envelope = draft ? carrier ? undefined : this.boundedEnvelope({ ...identity, kind: 'material', material: { ...this.config(draft), sourceText: draft.session.input } })
      : this.boundedEnvelope({ ...identity, kind })
    const item: Submission = { identity, kind, draft, generation: this.generation, envelope, sessionId: session?.id, direct,
      stage: 'frozen', reason: undefined, started: false, finished: false, settling: false, hostStarted: false }
    this.submissions.set(JSON.stringify([ownerId, requestId]), item); this.reconcile(); this.emit()
    return item
  }
  private checkReceipt(item: Submission, receipt: TranslationMaterialReceipt): void {
    if (!sameScope(item.identity, receipt) || item.kind !== receipt.kind) throw new Error('材料服务回执身份不匹配；提交结果尚不确定。')
    item.stage = receipt.stage
    if (receipt.stage === 'submitted' || receipt.stage === 'attached') this.confirmSent(item)
  }
  /** The bridge may only admit the exact browser snapshot that was prepared for this main submission. */
  resolveSubmittedMaterial(envelope: TranslationMaterialEnvelope & { readonly kind: 'material' }): TranslationMaterialEnvelope & { readonly kind: 'material' } | undefined {
    const item = this.submissions.get(JSON.stringify([envelope.ownerId, envelope.requestId]))
    if (this.disposed || !item || item.envelope?.kind !== 'material' ||
      !['prepared', 'submitted', 'attached', 'unknown'].includes(item.stage) ||
      JSON.stringify(item.envelope) !== JSON.stringify(parseTranslationMaterialEnvelope(envelope))) return undefined
    return structuredClone(item.envelope)
  }
  /** Read the submitted A snapshot by exact identity; later draft B is unrelated. */
  resolveSubmittedTarget(target: NormalTranslationMaterialTarget): Extract<TranslationMaterialEnvelope, { kind: 'material' }> | undefined {
    const item = this.submissions.get(JSON.stringify([target.mainSessionId, target.requestId])), envelope = item?.envelope
    if (envelope?.kind !== 'material' || envelope.mainSessionId !== target.mainSessionId || envelope.material.materialId !== target.materialId ||
      envelope.material.sourceVersion !== target.sourceVersion) return undefined
    return this.resolveSubmittedMaterial(envelope)
  }
  /** Business acceptance consumes only the unchanged submitted draft, including its edit history. */
  consumeSubmittedMaterial(envelope: TranslationMaterialEnvelope & { readonly kind: 'material' }): void {
    const item = this.submissions.get(JSON.stringify([envelope.ownerId, envelope.requestId]))
    if (!item || !this.resolveSubmittedMaterial(envelope) || item.consumed) return
    item.consumed = true
    const session = this.options.store.getSession(envelope.material.translationSessionId)
    const carrier = item.draft?.carrier
    if (carrier?.kind === 'selected_file' && this.files.get(envelope.material.translationSessionId)?.version === carrier.selected.version)
      this.setFileSelected(envelope.material.translationSessionId, undefined)
    if (session && session.ownerId === envelope.ownerId && session.topicId === envelope.material.topicId &&
      carrier?.kind !== 'selected_file' && this.draftVersion(session) === envelope.material.draftVersion && signature(session, this.fileVersions.get(session.id) ?? 0) === item.draft?.signature)
      this.options.store.updateSession(session.id, { input: '' })
    this.reconcile(); this.emit()
  }
  private active(item: Submission, signal: AbortSignal): void {
    if (signal.aborted || item.finished || this.disposed || item.generation !== this.generation) throw new Error('材料准备已取消。')
  }
  private async materialEnvelope(item: Submission, signal: AbortSignal): Promise<TranslationMaterialEnvelope> {
    this.active(item, signal)
    if (item.envelope) return item.envelope
    const draft = item.draft, carrier = draft?.carrier, sources = this.options.sources, upload = this.options.upload
    if (!draft || !carrier || !sources || !upload) throw new Error('TXT 原稿上传或导入服务尚未就绪。')
    // Generated TXT is a carrier for this frozen text, never a second user-selected material.
    const file = carrier.kind === 'selected_file' ? carrier.selected.file
      : new File([new TextEncoder().encode(carrier.text)], carrier.name, { type: 'text/plain;charset=utf-8' })
    const receipt = await upload.upload(item.identity.ownerId, file, file.name, signal, () => {})
    this.active(item, signal)
    if (!receipt || typeof receipt !== 'object' || (receipt as { ok?: unknown }).ok !== true) throw new Error('TXT 原稿上传未完成；草稿与文件保留。')
    const value = (receipt as { value?: { receiptId?: unknown } }).value
    if (!value || typeof value.receiptId !== 'string' || !value.receiptId) throw new Error('TXT 原稿上传收据无效。')
    const source = await sources.importReceipt({ scope: { ownerId: item.identity.ownerId, mainSessionId: item.identity.mainSessionId,
      topicId: draft.session.topicId, translationSessionId: draft.session.id }, receiptId: value.receiptId, idempotencyKey: draft.materialId }, signal)
    this.active(item, signal)
    if (!source.ok) throw new MaterialRejected(source.error.message, source.error.code)
    item.envelope = this.boundedEnvelope({ ...item.identity, kind: 'material', material: { ...this.config(draft), sourceRef: source.value } })
    return item.envelope
  }
  private prepare(item: Submission, signal: AbortSignal, method: 'prepare' | 'submit'): Promise<void> {
    if (item.preparation) return item.preparation
    this.active(item, signal)
    const reason = this.readiness(item.identity.ownerId, !!item.draft?.carrier)
    if (reason) { item.stage = 'failed'; item.reason = reason; this.reconcile(); this.emit(); return Promise.reject(new Error(reason)) }
    const controller = new AbortController(), cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true }); item.controller = controller
    item.started = true; item.stage = 'preparing'; this.emit()
    item.preparation = (async () => {
      try {
        const envelope = await this.materialEnvelope(item, controller.signal)
        const receipt = await this.call<TranslationMaterialReceipt>(method, envelope, () => { this.active(item, controller.signal); item.hostStarted = true })
        this.active(item, controller.signal)
        if (!sameScope(item.identity, receipt) || item.kind !== receipt.kind || !(method === 'prepare' ? receipt.stage === 'prepared' : ['submitted', 'attached'].includes(receipt.stage))) throw new Error('材料准备回执身份或阶段无效。')
        this.checkReceipt(item, receipt)
      } catch (error) {
        item.reason = detail(error)
        item.stage = !item.hostStarted || error instanceof MaterialRejected ? 'failed' : 'unknown'
        throw error
      } finally { signal.removeEventListener('abort', cancel); delete item.controller; this.reconcile(); this.emit() }
    })()
    return item.preparation
  }
  private freeze(gesture: MaterialSubmissionGesture): ReturnType<MaterialSubmissionContribution['freeze']> {
    if (this.disposed || !this.retained.has(gesture.sessionId)) return undefined
    const old = this.submissions.get(JSON.stringify([gesture.sessionId, gesture.requestId]))
    const session = this.options.store.getActiveSession(gesture.sessionId)
    const omitState = this.omitted.get(gesture.sessionId), omit = omitState?.selected ? omitState.revision : undefined
    let item: Submission | undefined = old, failure: string | undefined
    if (!item) {
      try {
        const kind = omit ? 'omit' : session?.mode === 'normal' && (session.input.trim() || this.files.has(session.id)) ? 'material' : 'none'
        if (kind === 'material' && session) {
          const status = this.getStatus(session.id)
          if (status.busy || status.unknown) throw new Error(status.blocked ?? '材料提交尚未结算。')
          const reason = this.inputReason(session); if (reason) throw new Error(reason)
        }
        item = this.record(session, gesture.sessionId, gesture.requestId, kind, false)
        if (omit) this.omitted.set(gesture.sessionId, { revision: omit, selected: false })
      } catch (error) { failure = detail(error) }
    }
    const frozen = item
    return {
      prepare: async signal => {
        if (failure) throw new Error(failure)
        if (!frozen || signal.aborted || this.disposed) throw new Error('材料提交已取消。')
        return this.prepare(frozen, signal, 'prepare')
      },
      finish: outcome => {
        if (!frozen || frozen.finished) return
        frozen.finished = true
        if (outcome !== 'accepted') frozen.controller?.abort()
        if (omit && outcome !== 'accepted' && this.omitted.get(gesture.sessionId)?.revision === omit) this.omitted.set(gesture.sessionId, { revision: omit, selected: true })
        const result = outcome === 'accepted' ? 'submitted' : outcome === 'handled' || outcome === 'cancelled' ? 'no_prompt' : outcome
        if (!frozen.started) { frozen.stage = result === 'unknown' ? 'unknown' : 'released'; this.reconcile(); this.emit(); return }
        frozen.stage = result === 'submitted' ? 'submitted' : result === 'unknown' ? 'unknown' : 'released'
        if (result === 'submitted') this.confirmSent(frozen)
        frozen.settling = true
        // A disposal can finish while prepare is in flight. Cleanup must follow its ACK.
        void Promise.resolve(frozen.preparation).catch(() => {}).then(() => frozen.hostStarted
          ? this.call<TranslationMaterialReceipt>('finish', { ...frozen.identity, outcome: result })
          : undefined).then(receipt => { if (receipt) this.checkReceipt(frozen, receipt) })
          .catch(error => {
            // A typed missing record after a confirmed no-prompt outcome is released.
            frozen.stage = error instanceof MaterialRejected && error.code === 'not_found' && (result === 'no_prompt' || result === 'failed') ? 'released' : 'unknown'
            frozen.reason ??= detail(error)
          }).finally(() => { frozen.settling = false; this.reconcile(); this.emit() })
        this.reconcile(); this.emit()
      },
    }
  }
  async send(sessionId: string): Promise<void> {
    const status = this.getStatus(sessionId), session = this.options.store.getSession(sessionId)
    if (this.disposed || !session || session.mode !== 'normal' || status.blocked) return
    const item = this.record(session, session.ownerId, id(), 'material', true)
    try { await this.prepare(item, new AbortController().signal, 'submit') }
    catch (error) { item.reason = detail(error) }
    finally { item.finished = true; this.reconcile(); this.emit() }
  }
  async query(sessionId: string): Promise<void> {
    const item = [...this.submissions.values()].filter(value => value.sessionId === sessionId && value.stage === 'unknown').at(-1)
    if (!item || this.disposed) return
    try {
      const result = await this.call<TranslationMaterialQuery | null>('query', item.identity)
      if (result && result.receipt.stage === 'prepared') item.reason = '材料已准备，主会话接收状态仍未确认。'
      else if (result) { this.checkReceipt(item, result.receipt); item.reason = undefined }
      else item.reason = '服务中尚无此提交记录；不能据此确认主会话未收到材料。'
    } catch (error) { item.reason = detail(error) }
    this.reconcile(); this.emit()
  }
  reset(): void {
    this.generation++; this.loading = undefined; this.capability = undefined; this.sourceCapability = undefined
    for (const item of this.submissions.values()) if (['frozen', 'preparing', 'prepared', 'submitted'].includes(item.stage)) {
      item.controller?.abort(); item.stage = item.hostStarted ? 'unknown' : 'failed'
      item.reason = item.hostStarted ? '连接已重置，请检查原提交状态。' : '连接已重置，材料尚未发送；草稿保留。'
    }
    this.reconcile(); this.emit(); void this.load()
  }
  dispose(): void {
    if (this.disposed) return
    this.unregister?.(); this.stopStore(); this.stopTopics()
    this.disposed = true; this.generation++
    for (const item of this.submissions.values()) item.controller?.abort()
    for (const release of this.retained.values()) release()
    this.retained.clear(); this.listeners.clear(); this.files.clear(); this.fileVersions.clear(); this.omitted.clear(); this.submissions.clear(); this.versions.clear()
  }
}
class MaterialRejected extends Error { constructor(message: string, readonly code: string) { super(message) } }
