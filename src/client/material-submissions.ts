import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope, type TranslationMaterialScope } from '../shared/translation-material.js'
import { parseTranslationMaterialResult, type TranslationMaterialsPort, type TranslationMaterialCapability, type TranslationMaterialReceipt, type TranslationMaterialQuery, type TranslationMaterialResult, type TranslationMaterialWorkflow } from '../shared/translation-material-remote.js'
import { MAX_TOPIC_BRIDGE_REPLY_BYTES } from '../shared/topic-bridge.js'
import { INLINE_TRANSLATION_SOURCE_CODE_POINTS } from '../shared/translation-source-read.js'
import type { NormalTranslationMaterialTarget } from '../shared/normal-translation.js'
import type { SessionStore } from './session-store.js'
import type { LocalSession } from './sessions.js'
import type { TopicBridgeClient } from './topic-bridge.js'
import { MAX_TRANSLATION_SOURCE_BYTES, type TranslationSourcesPort, type TranslationSourceCapability, type TranslationSourceScope, type TranslationSourceAsset } from '../shared/translation-sources.js'
import type { TranslationSourceStoragePort, TranslationSourceStoredRead } from '../shared/translation-source-storage.js'
import { FileIntakeStore, type FileIntakeRecord } from './file-intake-store.js'
import type { TranslationSourceHistoryCommit, TranslationSourceStorageClient } from './source-storage-client.js'
import { isDocumentUnit } from './translation-history.js'
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
  readonly topics: Pick<TopicBridgeClient, 'getStatus' | 'retain' | 'subscribe' | 'termCount'>
  readonly remote: Remote
  readonly registry?: MaterialSubmissionRegistry | undefined
  readonly owner: ComposerOwner
  readonly composerReason?: string
  readonly upload?: NativeFileUploadPort
  readonly sources?: TranslationSourcesPort
  readonly sourceStorage?: TranslationSourceStorageClient
  readonly sourceStoragePort?: TranslationSourceStoragePort
  /** Interface locale stamped onto every submission; the Host uses it only for the notice's reply-language line. */
  readonly uiLocale?: () => string | undefined
  /** A submission that never settles must clear its busy state and expose the stuck phase. */
  readonly stallMs?: number
  /** A prepared material that the main Session never accepts must not block the panel forever. */
  readonly handoffMs?: number
}
interface SelectedFile { readonly file: File; readonly version: number }
interface PastedTextCarrier { readonly kind: 'pasted_text'; readonly text: string; readonly name: string; readonly bytes: number; readonly totalCodePoints: number }
type SourceCarrier = { readonly kind: 'selected_file'; readonly selected: SelectedFile } | { readonly kind: 'frozen_file'; readonly unitId: string; readonly name: string } | PastedTextCarrier
interface FrozenDraft { readonly session: LocalSession; readonly draftVersion: number; readonly materialId: string; readonly signature: string; readonly carrier?: SourceCarrier }
interface Submission {
  readonly createdAt: string
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
  withdrawn?: boolean
  replacementId?: string
  textAction?: 'withdraw' | 'retry'
  fileAction?: 'retry' | 'remove'
  preserveDraft?: boolean
  settlement?: Promise<void>
  preparation?: Promise<void>
  stallTimer?: ReturnType<typeof setTimeout>
  handoffTimer?: ReturnType<typeof setTimeout>
  controller?: AbortController
  hostStarted: boolean
  workflow?: TranslationMaterialWorkflow
  queryingFile?: boolean
}
export interface MaterialSubmissionStatus {
  readonly busy: boolean
  readonly blocked: string | undefined
  readonly message: string | undefined
  readonly unknown: boolean
}
export interface LongDraftSource { readonly name: string; readonly bytes: number; readonly totalCodePoints: number }
export interface FileUnitView {
  readonly unitId: string; readonly materialId: string; readonly name: string; readonly createdAt: string
  readonly status: 'freezing' | 'frozen' | 'failed' | 'unknown' | 'accepted'
  readonly message: string | undefined; readonly busy: boolean; readonly unknown: boolean; readonly sourceFrozen: boolean
  readonly querying: boolean
  readonly sourceId: string | undefined; readonly documentUnitId: string | undefined
  readonly storage: 'saved' | 'runtime_only'; readonly storageError: string | undefined
  readonly storagePending: boolean
}
export interface FileUnitSource {
  readonly scope: TranslationSourceScope
  readonly sourceRef?: TranslationSourceAsset
  readonly librarySource?: Pick<import('../shared/library-sources.js').LibrarySourceRequest, 'stored' | 'namespaceId' | 'prepareToken'>
  readonly savedSource?: TranslationSourceStoredRead
  readonly file?: File
}
function fileCarrier(carrier: SourceCarrier | undefined): boolean { return carrier?.kind === 'selected_file' || carrier?.kind === 'frozen_file' }
const SEAM_MISSING = '普通模式暂不可用：当前 DSH 缺少同步发送材料接口。'
const FILE_AND_TEXT = '待译原文与文件请选择一种；请移除文件或清空待译原文，翻译要求仍在主输入区发送。'
const BYTE_BLOCKED = `材料超过传输上限（${MAX_TOPIC_BRIDGE_REPLY_BYTES} 字节）。请缩短待译稿；内容未截断。`
function id(): string { return crypto.randomUUID() }
function sameScope(a: TranslationMaterialScope, b: TranslationMaterialScope): boolean {
  return a.mainSessionId === b.mainSessionId && a.requestId === b.requestId && a.operationId === b.operationId
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
  private readonly fileIntakes: FileIntakeStore
  private readonly fileActions = new Set<string>()
  private readonly fileNotices = new Map<string, string>()
  private documentRemovalGuard: ((sessionId: string, unitId: string) => string | undefined) | undefined
  private readonly stopStore: () => void
  private readonly stopTopics: () => void
  private unregister: (() => void) | undefined
  private registry: MaterialSubmissionRegistry | undefined
  private composerReason: string | undefined
  private capability: TranslationMaterialCapability | undefined
  private sourceCapability: TranslationSourceCapability | undefined
  private sourceReason: string | undefined
  private serviceReason: string | undefined
  /** Submission-start failures that produced no row to show; informational only, never blocking. */
  private readonly notices = new Map<string, string>()
  private loading: Promise<void> | undefined
  private generation = 0
  private disposed = false
  private rememberHistory: boolean
  constructor(private readonly options: Options) {
    this.rememberHistory = options.store.getSettings().rememberHistory
    this.fileIntakes = new FileIntakeStore(options.store.createFileIntakeStoreOptions(), () => this.emitListeners())
    this.restoreFileSubmissions()
    this.stopStore = options.store.subscribe(() => {
      const enabled = options.store.getSettings().rememberHistory, becameEnabled = enabled && !this.rememberHistory
      this.rememberHistory = enabled
      this.fileIntakes.reconcile(); this.reconcile(); this.emit()
      if (becameEnabled) for (const record of this.fileIntakes.all()) void this.fileIntakes.saveSource(record.unitId, options.sourceStorage)
    })
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
  private emitListeners(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private emit(): void { if (!this.disposed) { this.syncFileRecords(); this.emitListeners() } }
  private restoreFileSubmissions(): void {
    for (const record of this.fileIntakes.all()) {
      if (record.stage === 'accepted' || record.stage === 'removed') continue
      const session = this.options.store.getSession(record.scope.translationSessionId)
      if (!session) continue
      const draft: FrozenDraft = { session: { ...session, ...record.config, input: '' }, materialId: record.materialId,
        draftVersion: record.config.draftVersion, signature: '', carrier: { kind: 'frozen_file', unitId: record.unitId, name: record.name } }
      const item: Submission = { identity: record.submission, createdAt: record.createdAt, kind: 'material', draft, generation: this.generation,
        envelope: record.source ? this.boundedEnvelope({ ...record.submission, kind: 'material', material: { ...this.config(draft), sourceRef: { ...record.source, persistence: 'runtime_only' } } }) : undefined,
        sessionId: session.id, direct: true, stage: record.stage === 'unknown' ? 'unknown' : 'failed', reason: record.message,
        finished: true, started: record.hostStarted, settling: false, hostStarted: record.hostStarted }
      this.submissions.set(JSON.stringify([item.identity.mainSessionId, item.identity.requestId]), item)
    }
  }
  private syncFileRecords(): void {
    for (const item of this.submissions.values()) {
      const draft = item.draft, carrier = draft?.carrier
      if (!draft || !fileCarrier(carrier) || item.replacementId) continue
      const unitId = `unit:${draft.materialId}`, old = this.fileIntakes.get(unitId)
      if (old?.stage === 'removed') continue
      const session = draft.session
      if (!this.options.store.getSession(session.id) || this.options.store.isSessionDeleted(session.id)) continue
      const stage = item.consumed ? 'accepted' : item.stage === 'unknown' || item.workflow?.phase === 'unknown' ? 'unknown'
        : ['failed', 'released'].includes(item.stage) || item.workflow?.phase === 'failed' ? 'failed' : ['frozen', 'preparing', 'prepared'].includes(item.stage) ? 'freezing' : 'frozen'
      // The saved scope is part of the original source proof, independent of this submission's entry.
      const record: FileIntakeRecord = { schemaVersion: 1, scope: old?.scope ?? { namespaceId: this.options.store.getNamespaceId(), ownerId: item.identity.mainSessionId, mainSessionId: item.identity.mainSessionId, topicId: session.topicId, translationSessionId: session.id },
        unitId, materialId: draft.materialId, name: carrier!.kind === 'selected_file' ? carrier!.selected.file.name : carrier!.name, createdAt: item.createdAt,
        config: { targetLanguage: session.targetLanguage, instruction: session.instruction, model: session.model, maxInputChars: session.maxInputChars, draftVersion: draft.draftVersion },
        submission: item.identity, stage, hostStarted: item.hostStarted, ...(item.reason ? { message: item.reason } : {}),
        ...(old?.source ? { source: old.source } : {}), ...(old?.historyCommit ? { historyCommit: old.historyCommit } : {}),
        ...(item.consumed ? { documentUnitId: unitId } : old?.documentUnitId ? { documentUnitId: old.documentUnitId } : {}) }
      this.fileIntakes.put(record)
    }
  }
  private draftVersion(session: LocalSession): number {
    const current = signature(session, this.fileVersions.get(session.id) ?? 0), old = this.versions.get(session.id)
    if (old?.signature === current) return old.version
    const version = (old?.version ?? 0) + 1
    this.versions.set(session.id, { signature: current, version })
    return version
  }
  private live(session: LocalSession): boolean {
    return session.archivedAt === null && !this.options.store.isSessionDeleted(session.id) &&
      this.options.store.getTopics().some(topic => topic.id === session.topicId)
  }
  private reconcile(): void {
    if (this.disposed) return
    const needed = new Set<string>()
    for (const owner of this.options.store.getOwnerIds()) for (const session of this.options.store.getAvailableSessions(owner)) {
      this.draftVersion(session)
      if (session.mode === 'normal' && this.live(session) && (session.input.trim() || this.files.has(session.id))) needed.add(owner)
    }
    for (const sessionId of this.files.keys()) if (!this.options.store.getSession(sessionId)) this.files.delete(sessionId)
    for (const file of this.fileIntakes.all()) {
      const session = this.options.store.getSession(file.scope.translationSessionId)
      const accepted = this.options.store.getTranslationHistory(file.scope.translationSessionId)?.units.some(unit => unit.id === file.unitId && isDocumentUnit(unit))
      if (file.stage !== 'accepted' && !accepted && session?.mode === 'normal' && this.live(session)) needed.add(file.scope.ownerId)
    }
    for (const item of this.submissions.values()) if (item.textAction || item.settling || ['frozen', 'preparing', 'prepared', 'unknown'].includes(item.stage) ||
      (!item.consumed && item.kind === 'material' && ['submitted', 'attached'].includes(item.stage))) needed.add(item.identity.mainSessionId)
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
  getSentTexts(sessionId: string): readonly { readonly materialId: string; readonly createdAt: string; readonly text: string; readonly status: string;
    readonly busy: boolean; readonly withdrawn: boolean; readonly unknown: boolean; readonly message: string | undefined }[] {
    return [...this.submissions.values()].flatMap(item => item.sessionId === sessionId && (item.sent || item.preserveDraft) && !item.consumed && !item.replacementId &&
      item.draft && !fileCarrier(item.draft.carrier)
      ? [{ materialId: item.draft.materialId, createdAt: item.createdAt, text: item.draft.session.input,
        status: item.textAction === 'withdraw' ? '正在撤回文本…' : item.textAction === 'retry' ? '正在重新发送文本…'
          : item.withdrawn ? '已撤回文本' : ['frozen', 'preparing', 'prepared'].includes(item.stage) ? '正在发送文本…'
            : item.stage === 'unknown' ? '文本提交结果待确认' : item.stage === 'failed' ? '文本发送失败' : '待处理文本 · 已发送',
        busy: !!item.textAction || item.settling || ['frozen', 'preparing', 'prepared'].includes(item.stage),
        withdrawn: !!item.withdrawn, unknown: item.stage === 'unknown', message: item.reason }] : [])
  }
  /** Revoke the old authority before retrying; a delayed main-agent tool call must not admit it. */
  async recoverText(sessionId: string, materialId: string, action: 'withdraw' | 'retry'): Promise<void> {
    const item = [...this.submissions.values()].find(value => value.sessionId === sessionId && value.draft?.materialId === materialId)
    const session = this.options.store.getSession(sessionId)
    if (this.disposed || !item?.draft || (!item.sent && !item.preserveDraft) || item.consumed || item.replacementId || item.textAction ||
      ['frozen', 'preparing', 'prepared'].includes(item.stage) || fileCarrier(item.draft.carrier) ||
      !session || session.mode !== 'normal' || !this.live(session) || action === 'withdraw' && item.withdrawn) return
    const generation = this.generation
    const current = (): void => {
      const liveSession = this.options.store.getSession(sessionId)
      if (this.disposed || generation !== this.generation || item.consumed || !liveSession || liveSession.mode !== 'normal' ||
        !this.options.store.isSessionOpen(item.identity.mainSessionId, liveSession.id) || liveSession.topicId !== item.draft!.session.topicId ||
        !this.live(liveSession)) throw new Error('材料所属会话或连接已变化，请重新检查。')
    }
    item.textAction = action; item.reason = undefined; this.emit()
    try {
      if (action === 'retry') {
        const reason = this.readiness(item.identity.mainSessionId, !!item.draft.carrier)
        if (reason) throw new Error(reason)
      }
      await item.settlement
      current()
      if (!item.withdrawn && item.hostStarted) await this.call('release', item.identity, current)
      current()
      item.withdrawn = true; item.stage = 'released'
      if (action === 'retry') {
        // Use the current translation settings with the exact old source. Never replace a new draft.
        const latest = this.options.store.getSession(sessionId)!
        const next = this.record(latest, item.identity.mainSessionId, id(), 'material', true, item.draft.session.input)
        item.replacementId = next.draft!.materialId
        try { await this.prepare(next, new AbortController().signal, 'submit') }
        catch (error) { next.reason = detail(error) }
        finally { next.finished = true }
      }
    } catch (error) { item.reason = detail(error) }
    finally { delete item.textAction; this.reconcile(); this.emit() }
  }
  /** Sent files are immutable records, separate from the next editable draft. */
  getSentFiles(sessionId: string): readonly { readonly materialId: string; readonly name: string; readonly sourceId: string | undefined }[] {
    return this.getFileUnits(sessionId).filter(item => item.status === 'frozen' || item.status === 'accepted')
      .map(item => ({ materialId: item.materialId, name: item.name, sourceId: item.sourceId }))
  }
  getFileUnits(sessionId: string): readonly FileUnitView[] {
    return this.fileIntakes.all(sessionId).map(record => {
      const item = this.fileSubmission(sessionId, record.unitId), source = this.fileIntakes.runtimeSource(record.unitId), storage = this.fileIntakes.storageState(record.unitId)
      const document = this.options.store.getTranslationHistory(sessionId)?.units.find(unit => unit.id === record.unitId && isDocumentUnit(unit))
      return { unitId: record.unitId, materialId: record.materialId, name: record.name, createdAt: record.createdAt,
        status: document ? 'accepted' : record.stage === 'removed' ? 'failed' : record.stage,
        message: this.fileNotices.get(record.unitId) ?? item?.reason ?? item?.workflow?.message ?? record.message, busy: this.fileActions.has(record.unitId) || !!item && (!!item.fileAction || !!item.queryingFile || item.settling || ['frozen', 'preparing', 'prepared'].includes(item.stage) || !!item.workflow && ['frozen', 'preparing', 'running'].includes(item.workflow.phase)),
        querying: !!item?.queryingFile,
        unknown: !document && record.stage === 'unknown', sourceFrozen: !!source || !!record.historyCommit,
        sourceId: source?.sourceId ?? record.source?.sourceId, documentUnitId: document?.id ?? record.documentUnitId,
        storage: storage.storage, storagePending: storage.storagePending, storageError: storage.storageError }
    })
  }
  private fileSubmission(sessionId: string, unitId: string): Submission | undefined {
    return [...this.submissions.values()].filter(item => item.sessionId === sessionId && `unit:${item.draft?.materialId}` === unitId && !item.replacementId).at(-1)
  }
  isFileRemoved(sessionId: string, unitId: string): boolean {
    const record = this.fileIntakes.get(unitId)
    return record?.scope.translationSessionId === sessionId && record.stage === 'removed'
  }
  fileAccessBlockedReason(sessionId: string, unitId: string): string | undefined {
    if (this.fileActions.has(unitId)) return '正在移除此文件单元，请等待撤销确认。'
    const record = this.fileIntakes.get(unitId)
    return record?.scope.translationSessionId === sessionId ? this.fileIntakes.accessBlockedReason(unitId) : undefined
  }
  setDocumentRemovalGuard(guard: (sessionId: string, unitId: string) => string | undefined): void { this.documentRemovalGuard = guard }
  getFileRecoveryMessage(sessionId: string, unitId: string): string | undefined {
    return this.options.store.getSession(sessionId) ? this.fileNotices.get(unitId) : undefined
  }
  getFileHistoryCommit(sessionId: string, unitId: string): TranslationSourceHistoryCommit | undefined {
    const record = this.fileIntakes.get(unitId)
    return record?.scope.translationSessionId === sessionId ? this.fileIntakes.historyCommit(unitId) : undefined
  }
  getFileCreatedAt(sessionId: string, unitId: string): string | undefined {
    const record = this.fileIntakes.get(unitId)
    return record?.scope.translationSessionId === sessionId ? record.createdAt : undefined
  }
  async resolveFileSource(sessionId: string, unitId: string): Promise<FileUnitSource | undefined> {
    const record = this.fileIntakes.get(unitId)
    if (!record || record.scope.translationSessionId !== sessionId || record.stage === 'removed' || this.disposed) return undefined
    const source = await this.fileIntakes.resolveSource(unitId, this.options.sourceStoragePort)
    const carrier = this.fileSubmission(sessionId, unitId)?.draft?.carrier
    const commit = this.fileIntakes.historyCommit(unitId)
    return source ? { ...source, ...(source.savedSource && commit ? { librarySource: { stored: source.savedSource, namespaceId: this.options.store.getNamespaceId(), prepareToken: commit.reference.prepareToken } } : {}), ...(carrier?.kind === 'selected_file' ? { file: carrier.selected.file } : {}) } : undefined
  }
  async queryFile(sessionId: string, unitId: string): Promise<void> {
    const record = this.fileIntakes.get(unitId), item = this.fileSubmission(sessionId, unitId)
    if (record?.scope.translationSessionId !== sessionId || record.stage === 'removed' || item?.queryingFile) return
    if (item) item.queryingFile = true
    this.emit()
    try {
      await this.query(sessionId, record.materialId)
      // An old exact commit may be reconciled even while new-history saving is disabled.
      if (!this.fileIntakes.runtimeSource(unitId) && record.historyCommit) await this.fileIntakes.resolveSource(unitId, this.options.sourceStoragePort)
      await this.fileIntakes.saveSource(unitId, this.options.sourceStorage)
    } catch (error) { this.fileNotices.set(unitId, detail(error)) }
    finally { if (item) delete item.queryingFile; this.emit() }
  }
  /** Revoke the old submission before a retry or removal can change this stable file row. */
  async recoverFile(sessionId: string, unitId: string, action: 'retry' | 'remove'): Promise<void> {
    const session = this.options.store.getSession(sessionId), item = this.fileSubmission(sessionId, unitId)
    if (this.disposed || !session || !this.live(session) || this.fileAccessBlockedReason(sessionId, unitId)) return
    const document = this.options.store.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)
    if (document && isDocumentUnit(document)) {
      if (action === 'retry') return // Actual document recovery uses its existing task controls.
      const removalBlocked = this.documentRemovalGuard?.(sessionId, unitId)
      if (removalBlocked) { this.fileNotices.set(unitId, removalBlocked); this.emit(); return }
      const last = document.tasks.at(-1)
      if (document.final || !last || !['failed', 'cancelled', 'interrupted'].includes(last.status) || document.tasks.some(task => ['running', 'unknown', 'waiting_user', 'waiting_context', 'paused'].includes(task.status) || task.executionFacts?.blocks.some(block => block.phase !== 'settled')) || this.options.store.hasDocumentLease(sessionId)) {
        this.fileNotices.set(unitId, '请先取消并确认任务终态；已有完成结果的单元不能在失败恢复中移除。'); this.emit()
        return
      }
      if (item?.fileAction) return
      this.fileActions.add(unitId); this.fileNotices.delete(unitId); this.emit()
      if (item) item.fileAction = action
      try {
        if (item && !item.withdrawn && item.hostStarted) await this.releaseFileAuthority(item)
        const first = document.sourceVersions[0], old = this.fileIntakes.get(unitId)
        const record: FileIntakeRecord = old ?? { schemaVersion: 1, scope: { namespaceId: this.options.store.getNamespaceId(), ownerId: item?.identity.mainSessionId ?? this.options.store.getNamespaceId(), mainSessionId: item?.identity.mainSessionId ?? this.options.store.getNamespaceId(), topicId: session.topicId, translationSessionId: sessionId },
          unitId, materialId: unitId.startsWith('unit:') ? unitId.slice(5) : unitId, name: first?.body.kind === 'asset' ? first.body.reference.name : '原稿.txt', createdAt: document.createdAt,
          config: { targetLanguage: document.targetLanguage, instruction: document.instruction, model: session.model, maxInputChars: session.maxInputChars, draftVersion: 1 },
          submission: item?.identity ?? {  mainSessionId: item?.identity.mainSessionId ?? this.options.store.getNamespaceId(), requestId: id(), operationId: id() }, stage: 'accepted', hostStarted: false,
          ...(first?.body.kind === 'asset' ? { source: first.body.reference, ...(first.historyCommit ? { historyCommit: first.historyCommit } : {}) } : {}) }
        // When history is entirely runtime-only, the barrier must stay runtime-only too.
        if (this.options.store.hasPersistedSession(sessionId) || this.fileIntakes.hasPersisted(unitId)) await this.fileIntakes.markRemoved(record)
        else this.fileIntakes.put({ ...record, stage: 'removed', documentUnitId: unitId })
      } catch (error) { this.fileNotices.set(unitId, detail(error)); if (item) item.reason = detail(error) }
      finally { this.fileActions.delete(unitId); if (item) delete item.fileAction; this.reconcile(); this.emit() }
      return
    }
    if (!item?.draft || item.consumed || item.fileAction || item.settling || ['frozen', 'preparing', 'prepared'].includes(item.stage)) return
    if (item.stage === 'unknown' || item.workflow?.phase === 'unknown') { item.reason = '提交或原分析结果尚不确定，请先查询；确认前不能重新发送或移除。'; this.emit(); return }
    if (item.workflow && ['frozen', 'preparing', 'running'].includes(item.workflow.phase)) { item.reason = item.workflow.message; this.emit(); return }
    item.fileAction = action; item.reason = undefined; this.emit()
    try {
      if (action === 'retry') { const blocked = this.readiness(item.identity.mainSessionId, true); if (blocked) throw new Error(blocked) }
      await item.settlement
      if (!item.withdrawn && item.hostStarted) await this.releaseFileAuthority(item)
      if (this.disposed || !this.live(session) || this.options.store.isSessionDeleted(sessionId)) return
      item.withdrawn = true; item.stage = 'released'
      if (action === 'remove') {
        await this.fileIntakes.remove(unitId)
        item.replacementId = 'removed'
      } else {
        const source = await this.resolveFileSource(sessionId, unitId)
        const carrier = item.draft.carrier
        if (!source?.sourceRef && carrier?.kind !== 'selected_file') throw new Error('本次运行期没有原文件，且保存原稿未能恢复；请重新选择文件。')
        const identity = {  mainSessionId: item.identity.mainSessionId, requestId: id(), operationId: id() }
        const next: Submission = { identity, createdAt: item.createdAt, kind: 'material', draft: item.draft, generation: this.generation,
          envelope: source?.sourceRef ? this.boundedEnvelope({ ...identity, kind: 'material', material: { ...this.config(item.draft), sourceRef: source.sourceRef } }) : undefined,
          sessionId, direct: true, stage: 'frozen', reason: undefined, finished: false, started: false, settling: false, hostStarted: false }
        item.replacementId = item.draft.materialId
        this.submissions.set(JSON.stringify([identity.mainSessionId, identity.requestId]), next)
        this.reconcile(); this.emit()
        try { await this.prepare(next, new AbortController().signal, 'submit') } catch (error) { next.reason = detail(error) }
        finally { next.finished = true }
      }
    } catch (error) { item.reason = detail(error) }
    finally { delete item.fileAction; this.reconcile(); this.emit() }
  }
  private async releaseFileAuthority(item: Submission): Promise<void> {
    // A lost release ACK is an unknown authority outcome, never permission to resend.
    try {
      const result = await this.call<{ readonly released: boolean }>('release', item.identity)
      if (!result.released) throw new Error('旧材料授权未确认撤销。')
      item.withdrawn = true
    } catch (error) {
      if (error instanceof MaterialRejected && (error.code === 'analysis_running' || error.code === 'analysis_unknown')) {
        item.workflow = { phase: error.code === 'analysis_unknown' ? 'unknown' : 'running', message: error.message }
      } else item.stage = 'unknown'
      throw error
    }
  }
  private confirmSent(item: Submission): void {
    if (item.sent || !item.draft) return
    item.sent = true
    const carrier = item.draft.carrier, sessionId = item.draft.session.id
    if (carrier?.kind === 'selected_file' && this.files.get(sessionId)?.version === carrier.selected.version) {
      this.files.delete(sessionId)
      this.fileVersions.set(sessionId, (this.fileVersions.get(sessionId) ?? 0) + 1)
    } else if (!fileCarrier(carrier) && !item.preserveDraft) {
      const session = this.options.store.getSession(sessionId)
      if (session && this.draftVersion(session) === item.draft.draftVersion &&
        signature(session, this.fileVersions.get(sessionId) ?? 0) === item.draft.signature)
        this.options.store.updateSession(sessionId, { input: '' })
    }
  }
  clearSelectedFiles(ownerId: string): void {
    for (const sessionId of [...this.files.keys()]) if (this.options.store.isSessionOpen(ownerId, sessionId)) this.setFileSelected(sessionId, undefined)
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
    // A hot-reloaded or newly mounted panel can wait forever for the Host remote; bound it so the
    // send button never stays disabled without an actionable message.
    const pending = typeof this.options.remote === 'function' ? this.options.remote() : Promise.resolve(this.options.remote)
    const remote = await this.withTimeout(pending, 20_000, '材料服务连接尚未就绪；请重新打开翻译面板，或重启 DSH 后再发送。')
    if (!remote) throw new Error('材料提交服务尚未就绪。')
    return remote
  }
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([promise,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  private async call<T>(method: keyof TranslationMaterialsPort, request?: TranslationMaterialEnvelope | TranslationMaterialScope | Parameters<TranslationMaterialsPort['finish']>[0], guard?: () => void): Promise<T> {
    const timeoutMs = method === 'submit' || method === 'prepare' ? 60_000 : 20_000
    const response = await this.withTimeout((async () => {
      const port = await this.port()
      guard?.()
      return method === 'capabilities' ? port.capabilities() : (port[method] as (request: unknown) => Promise<unknown>).call(port, request)
    })(), timeoutMs, '材料服务在限定时间内未返回；提交结果尚不确定。')
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
      if (!file.size) return '文件为空，请选择有内容的文件。'
      if (file.size > MAX_TRANSLATION_SOURCE_BYTES) return '文件超过 2 MiB 上限；所选文件保留。'
      return undefined
    }
    if (!session.input.trim()) return this.getSentFiles(session.id).length
      ? '文件已发送；可在主会话继续说明处理要求，或添加新的待译材料。' : '请输入待译材料。'
    try { pastedTextSize(session.input) } catch (error) { return detail(error) }
    return undefined
  }
  private readiness(ownerId: string, file = false): string | undefined {
    if (!ownerId || ownerId === this.options.store.getNamespaceId()) return '请选择本次任务使用的主会话。'
    if (!this.unregister) return composerReasonLabel(this.composerReason)
    if (!this.capability?.ready || !this.capability.directSubmit) return this.serviceReason ?? '正在检查材料提交服务…'
    const topic = this.options.topics.getStatus(ownerId)
    if (!topic.ready) return topic.reason ?? '正在连接此主会话的材料通道…'
    if (file && (!this.options.upload || !this.sourceCapability?.ready)) return this.sourceReason ?? '文件上传或导入服务尚未就绪。'
    return undefined
  }
  private boundedEnvelope(value: unknown): TranslationMaterialEnvelope {
    // The submitting Client stays the only source of the interface locale: stamping it here keeps
    // Host admission one-directional instead of querying this Client back while it admits material.
    const locale = this.options.uiLocale?.()?.trim()
    const envelope = parseTranslationMaterialEnvelope({ ...(value as Record<string, unknown>), ...(locale ? { uiLocale: locale.slice(0, 64) } : {}) })
    // Shared bounded bridge margin leaves room for Gateway's RPC wrapper (256 KiB uplink).
    if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) throw new Error(BYTE_BLOCKED)
    return envelope
  }
  private config(draft: FrozenDraft) {
    const session = draft.session, termCount = this.options.topics.termCount?.(this.options.store.getTopicStorageScope(session.topicId)!, session.topicId)
    return { materialId: draft.materialId, sourceVersion: 1, topicId: session.topicId, translationSessionId: session.id,
      draftVersion: draft.draftVersion, targetLanguage: session.targetLanguage, instruction: session.instruction,
      model: session.model, maxInputChars: session.maxInputChars, ...(termCount === undefined ? {} : { termCount }) }
  }
  getStatus(sessionId: string, executionOwner?: string): MaterialSubmissionStatus {
    const session = this.options.store.getSession(sessionId)
    const latest = [...this.submissions.values()].filter(item => item.sessionId === sessionId).at(-1)
    const busy = !!latest && !latest.finished && ['frozen', 'preparing', 'prepared'].includes(latest.stage)
    const unknown = latest?.stage === 'unknown'
    let blocked = session ? this.inputReason(session) : '翻译会话不存在。'
    if (!blocked && session) {
      try { blocked = this.readiness(executionOwner && executionOwner !== this.options.store.getNamespaceId() ? executionOwner : '', this.files.has(session.id) || !!this.previewPastedCarrier(session)) }
      catch (error) { blocked = detail(error) }
    }
    if (busy && latest) blocked = `正在提交材料…（当前阶段：${this.phaseOf(latest)}）`
    if (unknown) blocked = '提交结果尚不确定，请先检查提交状态。'
    let message = latest?.reason ?? (session ? this.notices.get(session.id) : undefined)
    if (latest?.withdrawn) message = latest.reason ?? '文本已撤回；原文保留在会话记录中，可重新发送。'
    else if (this.getSentFiles(sessionId).length && !session?.input.trim() && !this.files.has(sessionId)) message = '文件已发送并冻结；待处理文件见会话记录。'
    else if (latest?.sent && latest.draft?.carrier?.kind !== 'selected_file' && !session?.input.trim() && !this.files.has(sessionId))
      message = latest.consumed ? '翻译业务已受理；原提交文本已记录。' : '文本已发送并冻结；待处理文本见会话记录。'
    else if (latest?.consumed) message = session && latest.draft && this.draftVersion(session) !== latest.draft.draftVersion
      ? '翻译业务已受理；当前草稿的后续修改保留。' : '翻译业务已受理；原提交材料已记录。'
    else if (latest?.draft && ['submitted', 'attached'].includes(latest.stage)) {
      const sent = latest.draft.draftVersion, current = session ? this.draftVersion(session) : sent
      message = current === sent ? `已向主会话提交草稿版本 ${sent}；待译草稿保留。`
        : `已提交的是草稿版本 ${sent}；当前草稿为版本 ${current}。`
    }
    return { busy, blocked, message, unknown }
  }
  private phaseOf(item: Submission): string {
    if (item.stage === 'prepared') return '材料已准备，等待主会话接收'
    if (item.stage === 'frozen') return '尚未开始提交'
    return item.reason ?? '材料准备中'
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
      {  mainSessionId: this.options.store.getNamespaceId(), requestId: previewId, operationId: previewId })
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
  private record(session: LocalSession | undefined, ownerId: string, requestId: string, kind: TranslationMaterialEnvelope['kind'], direct: boolean, sourceText?: string): Submission {
    const identity = {  mainSessionId: ownerId, requestId, operationId: id() }
    const selected = sourceText === undefined && session ? this.files.get(session.id) : undefined
    const captured: FrozenDraft | undefined = kind === 'material' && session ? { session: { ...structuredClone(session), ...(sourceText === undefined ? {} : { input: sourceText }) }, draftVersion: this.draftVersion(session),
      materialId: id(), signature: signature(session, this.fileVersions.get(session.id) ?? 0) } : undefined
    const carrier = captured ? selected ? { kind: 'selected_file' as const, selected } : this.pastedCarrier(captured, identity) : undefined
    const draft = captured && carrier ? { ...captured, carrier } : captured
    const envelope = draft ? carrier ? undefined : this.boundedEnvelope({ ...identity, kind: 'material', material: { ...this.config(draft), sourceText: draft.session.input } })
      : this.boundedEnvelope({ ...identity, kind })
    const item: Submission = { identity, createdAt: new Date().toISOString(), kind, draft, generation: this.generation, envelope, sessionId: session?.id, direct,
      stage: 'frozen', reason: undefined, started: false, finished: false, settling: false, hostStarted: false, preserveDraft: sourceText !== undefined }
    this.submissions.set(JSON.stringify([ownerId, requestId]), item); this.reconcile(); this.emit()
    if (carrier?.kind === 'selected_file' && session && this.files.get(session.id)?.version === carrier.selected.version) {
      // The captured File remains owned by this immutable row; the picker now belongs to the next draft.
      this.files.delete(session.id); this.fileVersions.set(session.id, (this.fileVersions.get(session.id) ?? 0) + 1)
      this.reconcile(); this.emit()
    }
    return item
  }
  private checkReceipt(item: Submission, receipt: TranslationMaterialReceipt): void {
    if (!sameScope(item.identity, receipt) || item.kind !== receipt.kind) throw new Error('材料服务回执身份不匹配；提交结果尚不确定。')
    item.stage = receipt.stage
    if (receipt.stage === 'prepared') this.armHandoff(item)
    if (receipt.stage === 'submitted' || receipt.stage === 'attached') { this.clearHandoff(item); this.confirmSent(item) }
  }
  /** Prepared is not delivered: the main turn must still accept it, so bound that handoff. */
  private armHandoff(item: Submission): void {
    if (item.handoffTimer) return
    const handoffMs = this.options.handoffMs ?? 30_000
    item.handoffTimer = setTimeout(() => {
      delete item.handoffTimer
      if (this.disposed || item.stage !== 'prepared' || item.sent || item.settling || item.consumed) return
      item.stage = 'unknown'
      item.reason = `材料已准备，但主会话在 ${Math.round(handoffMs / 1000)} 秒内没有接收；正在撤销本次提交。`
      this.reconcile(); this.emit()
      // A never-delivered record keeps the session busy; release it so the retained source can be resent.
      void this.call<{ readonly released: boolean }>('release', item.identity).then(result => {
        if (!result.released || item.stage !== 'unknown' || item.sent || this.disposed) return
        item.stage = 'failed'
        item.reason = '主会话未接收该材料，本次提交已撤销；可使用保留的原稿重新发送。'
        this.reconcile(); this.emit()
      }, () => {})
    }, handoffMs)
  }
  private clearHandoff(item: Submission): void {
    if (item.handoffTimer) { clearTimeout(item.handoffTimer); delete item.handoffTimer }
  }
  /** The bridge may only admit the exact browser snapshot that was prepared for this main submission. */
  resolveSubmittedMaterial(envelope: TranslationMaterialEnvelope & { readonly kind: 'material' }): TranslationMaterialEnvelope & { readonly kind: 'material' } | undefined {
    const item = this.submissions.get(JSON.stringify([envelope.mainSessionId, envelope.requestId]))
    if (this.disposed || !item || item.withdrawn || item.textAction || item.fileAction || item.replacementId || item.envelope?.kind !== 'material' ||
      this.fileAccessBlockedReason(envelope.material.translationSessionId, `unit:${envelope.material.materialId}`) ||
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
    const item = this.submissions.get(JSON.stringify([envelope.mainSessionId, envelope.requestId]))
    if (!item || !this.resolveSubmittedMaterial(envelope) || item.consumed) return
    item.consumed = true
    const session = this.options.store.getSession(envelope.material.translationSessionId)
    const carrier = item.draft?.carrier
    if (carrier?.kind === 'selected_file' && this.files.get(envelope.material.translationSessionId)?.version === carrier.selected.version)
      this.setFileSelected(envelope.material.translationSessionId, undefined)
    if (session && session.topicId === envelope.material.topicId &&
      !fileCarrier(carrier) && !item.preserveDraft && this.draftVersion(session) === envelope.material.draftVersion && signature(session, this.fileVersions.get(session.id) ?? 0) === item.draft?.signature)
      this.options.store.updateSession(session.id, { input: '' })
    this.reconcile(); this.emit()
  }
  private active(item: Submission, signal: AbortSignal): void {
    if (signal.aborted || item.finished || item.withdrawn || item.replacementId || this.disposed || item.generation !== this.generation ||
      item.sessionId && (!this.options.store.getSession(item.sessionId) || this.options.store.isSessionDeleted(item.sessionId) || this.fileAccessBlockedReason(item.sessionId, `unit:${item.draft?.materialId}`))) throw new Error('材料准备已取消。')
  }
  private async materialEnvelope(item: Submission, signal: AbortSignal): Promise<TranslationMaterialEnvelope> {
    this.active(item, signal)
    if (item.envelope) return item.envelope
    const draft = item.draft, carrier = draft?.carrier, sources = this.options.sources, upload = this.options.upload
    if (!draft || !carrier || !sources || !upload) throw new Error('文件上传或导入服务尚未就绪。')
    // Generated text is a carrier for this frozen body, never a second user-selected material.
    if (carrier.kind === 'frozen_file') throw new Error('已保存原稿尚未恢复，不能重新上传空材料。')
    const file = carrier.kind === 'selected_file' ? carrier.selected.file
      : new File([new TextEncoder().encode(carrier.text)], carrier.name, { type: 'text/plain;charset=utf-8' })
    item.reason = '正在上传原稿…'; this.emit()
    const receipt = await upload.upload(item.identity.mainSessionId, file, file.name, signal, () => {})
    this.active(item, signal)
    if (!receipt || typeof receipt !== 'object' || (receipt as { ok?: unknown }).ok !== true) throw new Error('文件上传未完成；草稿与文件保留。')
    const value = (receipt as { value?: { receiptId?: unknown } }).value
    if (!value || typeof value.receiptId !== 'string' || !value.receiptId) throw new Error('文件上传收据无效。')
    item.reason = '正在导入并校验原稿…'; this.emit()
    const source = await sources.importReceipt({ scope: { namespaceId: this.options.store.getNamespaceId(), ownerId: item.identity.mainSessionId, mainSessionId: item.identity.mainSessionId,
      topicId: draft.session.topicId, translationSessionId: draft.session.id }, receiptId: value.receiptId, idempotencyKey: draft.materialId }, signal)
    this.active(item, signal)
    if (!source.ok) throw new MaterialRejected(source.error.message, source.error.code)
    item.envelope = this.boundedEnvelope({ ...item.identity, kind: 'material', material: { ...this.config(draft), sourceRef: source.value } })
    if (fileCarrier(carrier)) {
      this.fileIntakes.setSource(`unit:${draft.materialId}`, source.value)
      this.emit()
      item.reason = '正在缓存原稿…'; this.emit()
      // Save the frozen source before document preparation or acceptance can fail. The managed
      // cache is independent of chat history; a host without storage keeps the runtime original.
      await this.fileIntakes.saveSource(`unit:${draft.materialId}`, this.options.sourceStorage)
      this.active(item, signal)
    }
    return item.envelope
  }
  private prepare(item: Submission, signal: AbortSignal, method: 'prepare' | 'submit'): Promise<void> {
    if (item.preparation) return item.preparation
    try { this.active(item, signal) }
    catch (error) {
      // A rejected early check must end in a terminal stage; otherwise a frozen row blocks sending forever.
      item.stage = 'failed'; item.reason = detail(error); this.reconcile(); this.emit(); return Promise.reject(error)
    }
    const reason = this.readiness(item.identity.mainSessionId, !!item.draft?.carrier)
    if (reason) { item.stage = 'failed'; item.reason = reason; this.reconcile(); this.emit(); return Promise.reject(new Error(reason)) }
    const controller = new AbortController(), cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true }); item.controller = controller
    item.started = true; item.stage = 'preparing'; item.reason = item.draft?.carrier ? '正在上传并冻结原稿…' : '正在准备材料…'; this.emit()
    const stallMs = this.options.stallMs ?? 60_000
    item.stallTimer = setTimeout(() => {
      if (!item.preparation || item.finished || item.stage !== 'preparing') return
      const phase = item.reason ?? '未知阶段'
      item.reason = `提交超过 ${Math.round(stallMs / 1000)} 秒未返回（${phase}）；请检查提交状态后重试。`
      item.stage = 'unknown'; this.reconcile(); this.emit()
    }, stallMs)
    item.preparation = (async () => {
      try {
        const envelope = await this.withTimeout(this.materialEnvelope(item, controller.signal), 120_000,
          '原稿上传或冻结未在限定时间内完成；材料尚未提交，请重试。')
        item.reason = '正在请求主会话接收材料…'; this.emit()
        const receipt = await this.call<TranslationMaterialReceipt>(method, envelope, () => { this.active(item, controller.signal); item.hostStarted = true })
        this.active(item, controller.signal)
        if (!sameScope(item.identity, receipt) || item.kind !== receipt.kind || !(method === 'prepare' ? receipt.stage === 'prepared' : ['submitted', 'attached'].includes(receipt.stage))) throw new Error('材料准备回执身份或阶段无效。')
        this.checkReceipt(item, receipt)
        item.reason = undefined
      } catch (error) {
        item.reason = detail(error)
        item.stage = !item.hostStarted || error instanceof MaterialRejected ? 'failed' : 'unknown'
        throw error
      } finally {
        if (item.stallTimer) { clearTimeout(item.stallTimer); delete item.stallTimer }
        signal.removeEventListener('abort', cancel); delete item.controller; this.reconcile(); this.emit()
      }
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
          const status = this.getStatus(session.id, gesture.sessionId)
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
        this.clearHandoff(frozen)
        if (outcome !== 'accepted') frozen.controller?.abort()
        if (omit && outcome !== 'accepted' && this.omitted.get(gesture.sessionId)?.revision === omit) this.omitted.set(gesture.sessionId, { revision: omit, selected: true })
        const result = outcome === 'accepted' ? 'submitted' : outcome === 'handled' || outcome === 'cancelled' ? 'no_prompt' : outcome
        if (!frozen.started) { frozen.stage = result === 'unknown' ? 'unknown' : 'released'; this.reconcile(); this.emit(); return }
        frozen.stage = result === 'submitted' ? 'submitted' : result === 'unknown' ? 'unknown' : 'released'
        if (result === 'submitted') this.confirmSent(frozen)
        frozen.settling = true
        // A disposal can finish while prepare is in flight. Cleanup must follow its ACK.
        frozen.settlement = Promise.resolve(frozen.preparation).catch(() => {}).then(() => frozen.hostStarted
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
  async send(sessionId: string, executionOwner?: string): Promise<void> {
    const status = this.getStatus(sessionId, executionOwner), session = this.options.store.getSession(sessionId)
    if (this.disposed || !session || session.mode !== 'normal' || status.blocked) return
    const owner = executionOwner
    if (!owner) return
    if (!this.options.store.isSessionOpen(owner, sessionId)) return
    this.notices.delete(sessionId)
    let item: Submission
    try { item = this.record(session, owner, id(), 'material', true) }
    catch (error) {
      // A row that fails before preparation must never stay frozen and silently block sending.
      for (const existing of this.submissions.values()) if (existing.sessionId === sessionId && ['frozen', 'preparing'].includes(existing.stage)) {
        existing.stage = 'failed'; existing.reason = detail(error)
      }
      this.notices.set(sessionId, `材料未能开始提交：${detail(error)}`)
      this.reconcile(); this.emit(); return
    }
    try { await this.prepare(item, new AbortController().signal, 'submit') }    catch (error) { item.reason = detail(error) }
    finally { item.finished = true; this.reconcile(); this.emit() }
  }
  async query(sessionId: string, materialId?: string): Promise<void> {
    const item = [...this.submissions.values()].filter(value => value.sessionId === sessionId && !value.replacementId && (value.stage === 'unknown' || materialId !== undefined && fileCarrier(value.draft?.carrier)) &&
      (materialId === undefined || value.draft?.materialId === materialId)).at(-1)
    if (!item || this.disposed || item.textAction || item.fileAction || item.withdrawn) return
    try {
      const result = await this.call<TranslationMaterialQuery | null>('query', item.identity)
      if (item.textAction || item.fileAction || item.withdrawn || this.disposed) return
      if (result && result.receipt.stage === 'prepared') item.reason = '材料已准备，主会话接收状态仍未确认。'
      else if (result) { this.checkReceipt(item, result.receipt); if (result.workflow) item.workflow = result.workflow; else delete item.workflow; item.reason = result.workflow?.message }
      else if (fileCarrier(item.draft?.carrier)) {
        // The owner's exact release ACK confirms old tool authority is absent, even after a Host restart.
        await this.releaseFileAuthority(item)
        item.stage = 'failed'; item.reason = '旧文件提交授权已确认撤销；可使用保留的原稿重新发送。'
      } else {
        item.reason = '服务中尚无此提交记录；可重新发送材料。'
        // A hang before the Host call never created a record; retry is safe and does not require confirmation.
        if (!item.hostStarted) item.stage = 'failed'
      }
    } catch (error) { item.reason = detail(error) }
    this.reconcile(); this.emit()
  }
  reset(): void {
    this.generation++; this.loading = undefined; this.capability = undefined; this.sourceCapability = undefined
    for (const item of this.submissions.values()) if (['frozen', 'preparing', 'prepared', 'submitted'].includes(item.stage)) {
      this.clearHandoff(item)
      item.controller?.abort(); item.stage = item.hostStarted ? 'unknown' : 'failed'
      item.reason = item.hostStarted ? '连接已重置，请检查原提交状态。' : '连接已重置，材料尚未发送；草稿保留。'
    }
    this.reconcile(); this.emit(); void this.load()
  }
  dispose(): void {
    if (this.disposed) return
    this.unregister?.(); this.stopStore(); this.stopTopics()
    this.disposed = true; this.generation++
    for (const item of this.submissions.values()) { this.clearHandoff(item); if (item.stallTimer) clearTimeout(item.stallTimer); item.controller?.abort() }
    for (const release of this.retained.values()) release()
    this.notices.clear(); this.retained.clear(); this.listeners.clear(); this.files.clear(); this.fileVersions.clear(); this.omitted.clear(); this.submissions.clear(); this.versions.clear(); this.fileIntakes.dispose(); this.fileActions.clear(); this.fileNotices.clear()
  }
}
class MaterialRejected extends Error { constructor(message: string, readonly code: string) { super(message) } }
