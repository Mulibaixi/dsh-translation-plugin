import { toSourceIdentity } from '../shared/translation-sources.js'
import { parseTranslationSourceReference, parseTranslationSourceStorageRequest, parseTranslationSourceStorageResult,
  type TranslationSourceConfirmReference, type TranslationSourcePrepareSave, type TranslationSourceQueryReference,
  type TranslationSourceReference, type TranslationSourceStorageMethod, type TranslationSourceStoragePort,
  type TranslationSourceStorageResult } from '../shared/translation-source-storage.js'

export type TranslationSourceStorageRemotePort = {
  [K in keyof TranslationSourceStoragePort]: (...args: Parameters<TranslationSourceStoragePort[K]>) => Promise<unknown>
}

/** Unwrap the native Gateway RemoteResult before parsing the independent storage protocol. */
export function adaptTranslationSourceStorageRemote(remote: TranslationSourceStorageRemotePort | undefined |
  (() => Promise<TranslationSourceStorageRemotePort | undefined>)): TranslationSourceStoragePort {
  async function invoke<T>(method: TranslationSourceStorageMethod, request?: unknown, signal?: AbortSignal): Promise<TranslationSourceStorageResult<T>> {
    signal?.throwIfAborted()
    const fixed = method === 'storageCapabilities' ? undefined : parseTranslationSourceStorageRequest(method, request)
    const port = typeof remote === 'function' ? await remote() : remote
    // Mount resolution may finish after the caller has cancelled the open operation.
    signal?.throwIfAborted()
    if (!port) throw new Error('原稿保存服务尚未就绪。')
    const args = method === 'storageCapabilities' ? [] : signal ? [fixed, signal] : [fixed]
    const response = await (port[method] as (...args: readonly unknown[]) => Promise<unknown>)(...args)
    if (!response || typeof response !== 'object' || Array.isArray(response) || (response as { ok?: unknown }).ok !== true) {
      throw new Error('未取得原稿保存服务传输回执。')
    }
    return parseTranslationSourceStorageResult(method, (response as { value?: unknown }).value) as TranslationSourceStorageResult<T>
  }
  return {
    storageCapabilities: () => invoke('storageCapabilities'),
    prepareSave: request => invoke('prepareSave', request),
    confirmReference: request => invoke('confirmReference', request),
    queryReference: request => invoke('queryReference', request),
    restore: request => invoke('restore', request),
    openOriginal: (request, signal) => invoke('openOriginal', request, signal),
    releaseReference: request => invoke('releaseReference', request),
  }
}

/** The actual history writer must retain this exact prepared identity and confirmation operation. */
export interface TranslationSourceHistoryCommit {
  readonly reference: TranslationSourceReference
  readonly historyToken: string
  readonly confirmOperationId: string
}
export interface TranslationSourceHistoryCallbacks {
  isHistoryEnabled(): boolean
  persistPreparedReference(reference: TranslationSourceReference, confirmOperationId: string): Promise<TranslationSourceHistoryCommit>
  readPersistedReference(request: TranslationSourceQueryReference): Promise<TranslationSourceHistoryCommit | null>
}
export interface TranslationSourceSaveTransaction {
  readonly prepare: TranslationSourcePrepareSave
  readonly confirmOperationId: string
}
type TransactionStage = 'prepare' | 'history_read' | 'confirm' | 'query'
export type TranslationSourceSaveOutcome =
  | { readonly state: 'history_disabled' }
  | { readonly state: 'confirmed' | 'released'; readonly reference: TranslationSourceReference }
  | { readonly state: 'prepared'; readonly reference: TranslationSourceReference;
      readonly reason: 'history_disabled' | 'history_write_failed' | 'history_ack_invalid' | 'confirmation_unresolved';
      readonly commit?: TranslationSourceHistoryCommit }
  | { readonly state: 'unknown' | 'failed'; readonly stage: TransactionStage; readonly message: string;
      readonly reference?: TranslationSourceReference; readonly commit?: TranslationSourceHistoryCommit }

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
function queryOf(reference: TranslationSourceReference): TranslationSourceQueryReference {
  return { scope: reference.scope, referenceKey: reference.referenceKey }
}
function sameReferenceIdentity(left: TranslationSourceReference, right: TranslationSourceReference): boolean {
  return same(left.scope, right.scope) && same(left.source, right.source) && left.referenceKey === right.referenceKey &&
    left.prepareToken === right.prepareToken
}
function parseCommit(value: unknown): TranslationSourceHistoryCommit {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== 3 || !Object.hasOwn(value, 'reference') || !Object.hasOwn(value, 'historyToken') ||
    !Object.hasOwn(value, 'confirmOperationId')) throw new TypeError('Invalid source history acknowledgment')
  const data = value as Record<string, unknown>, reference = parseTranslationSourceReference(data.reference)
  if (reference.state !== 'prepared') throw new TypeError('History must retain the exact prepared reference')
  const confirm = parseTranslationSourceStorageRequest('confirmReference', { ...queryOf(reference), prepareToken: reference.prepareToken,
    historyToken: data.historyToken, operationId: data.confirmOperationId }) as TranslationSourceConfirmReference
  return { reference, historyToken: confirm.historyToken, confirmOperationId: confirm.operationId }
}

/** No history storage is owned here; a future SessionStore caller supplies its authoritative callbacks. */
export class TranslationSourceStorageClient {
  private readonly inFlight = new Map<string, { readonly signature: string; readonly promise: Promise<TranslationSourceSaveOutcome> }>()
  constructor(private readonly port: TranslationSourceStoragePort) {}

  save(transaction: TranslationSourceSaveTransaction, history: TranslationSourceHistoryCallbacks): Promise<TranslationSourceSaveOutcome> {
    if (!history.isHistoryEnabled()) return Promise.resolve({ state: 'history_disabled' })
    const prepare = parseTranslationSourceStorageRequest('prepareSave', transaction.prepare) as TranslationSourcePrepareSave
    // Validate the caller's fixed confirmation ID without fabricating a prepare token.
    const confirmOperationId = (parseTranslationSourceStorageRequest('prepareSave', { ...prepare,
      operationId: transaction.confirmOperationId }) as TranslationSourcePrepareSave).operationId
    const fixed = { prepare, confirmOperationId }, signature = JSON.stringify(fixed)
    const key = JSON.stringify([prepare.scope, prepare.referenceKey, prepare.operationId]), current = this.inFlight.get(key)
    if (current) return current.signature === signature ? current.promise : Promise.resolve({ state: 'failed', stage: 'prepare',
      message: '同一原稿保存操作的内容已改变。' })
    const promise = this.prepareAndPersist(fixed, history).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, { signature, promise })
    return promise
  }

  /** Reconcile an exact commit read from real history; this never writes new history or prepares a new source. */
  async confirmPersistedReference(value: TranslationSourceHistoryCommit, history: TranslationSourceHistoryCallbacks): Promise<TranslationSourceSaveOutcome> {
    const commit = parseCommit(value), loaded = await this.readCommit(commit.reference, history)
    if ('state' in loaded) return loaded
    if (!same(loaded, commit)) return { state: 'failed', stage: 'history_read', reference: commit.reference,
      message: '已保存历史与待确认的原稿提交不一致。' }
    const queried = await this.queryCommit(commit)
    if (queried.state !== 'prepared') return queried
    return this.confirmCommit(commit)
  }
  /** Read only: a retained prepared history commit alone does not prove confirmation. */
  queryPersistedReference(value: TranslationSourceHistoryCommit): Promise<TranslationSourceSaveOutcome> { return this.queryCommit(parseCommit(value)) }

  private async prepareAndPersist(transaction: TranslationSourceSaveTransaction, history: TranslationSourceHistoryCallbacks): Promise<TranslationSourceSaveOutcome> {
    let result: TranslationSourceStorageResult<TranslationSourceReference>
    try { result = await this.port.prepareSave(transaction.prepare) }
    catch { return { state: 'unknown', stage: 'prepare', message: '原稿保存准备回执不明，请查询原引用；不要重新上传或新建事务。' } }
    if (!result.ok) return { state: 'failed', stage: 'prepare', message: result.error.message }
    const reference = parseTranslationSourceReference(result.value)
    if (!same(reference.scope, transaction.prepare.scope) || reference.referenceKey !== transaction.prepare.referenceKey ||
      !same(reference.source, toSourceIdentity(transaction.prepare.sourceRef))) {
      return { state: 'failed', stage: 'prepare', message: '保存准备回执与固定原稿或所属范围不一致。' }
    }
    if (reference.state === 'released') return { state: 'released', reference }
    if (reference.state === 'confirmed') {
      const loaded = await this.readCommit(reference, history)
      if ('state' in loaded) return loaded
      return this.settlement(reference, loaded, 'prepare')
    }
    if (!history.isHistoryEnabled()) return { state: 'prepared', reference, reason: 'history_disabled' }
    // A previous write may have succeeded before its confirmation receipt was lost.
    let retained: TranslationSourceHistoryCommit | null
    try { retained = await history.readPersistedReference(structuredClone(queryOf(reference))) }
    catch { return { state: 'unknown', stage: 'history_read', reference, message: '未取得准确的已保存原稿历史提交。' } }
    if (retained !== null) {
      let commit: TranslationSourceHistoryCommit
      try { commit = parseCommit(retained) }
      catch { return { state: 'prepared', reference, reason: 'history_ack_invalid' } }
      if (!same(commit.reference, reference) || commit.confirmOperationId !== transaction.confirmOperationId) {
        return { state: 'prepared', reference, reason: 'history_ack_invalid' }
      }
      return this.queryCommit(commit)
    }
    if (!history.isHistoryEnabled()) return { state: 'prepared', reference, reason: 'history_disabled' }
    let acknowledgment: TranslationSourceHistoryCommit
    try { acknowledgment = await history.persistPreparedReference(structuredClone(reference), transaction.confirmOperationId) }
    catch { return { state: 'prepared', reference, reason: 'history_write_failed' } }
    let commit: TranslationSourceHistoryCommit
    try { commit = parseCommit(acknowledgment) }
    catch { return { state: 'prepared', reference, reason: 'history_ack_invalid' } }
    if (!same(commit.reference, reference) || commit.confirmOperationId !== transaction.confirmOperationId) {
      return { state: 'prepared', reference, reason: 'history_ack_invalid' }
    }
    // An already committed history transaction may finish even if history was disabled during its write.
    return this.confirmCommit(commit)
  }

  private async readCommit(reference: TranslationSourceReference, history: TranslationSourceHistoryCallbacks): Promise<TranslationSourceHistoryCommit | TranslationSourceSaveOutcome> {
    let value: TranslationSourceHistoryCommit | null
    try { value = await history.readPersistedReference(structuredClone(queryOf(reference))) }
    catch { return { state: 'unknown', stage: 'history_read', reference, message: '未取得准确的已保存原稿历史提交。' } }
    if (value === null) return { state: 'failed', stage: 'history_read', reference, message: '历史中没有该原稿的准确保存提交。' }
    try {
      const commit = parseCommit(value)
      if (!sameReferenceIdentity(reference, commit.reference)) throw new TypeError('History source reference mismatch')
      return commit
    } catch { return { state: 'failed', stage: 'history_read', reference, message: '已保存历史的原稿、范围或准备凭据不一致。' } }
  }

  private async confirmCommit(commit: TranslationSourceHistoryCommit): Promise<TranslationSourceSaveOutcome> {
    let result: TranslationSourceStorageResult<TranslationSourceReference>
    try { result = await this.port.confirmReference({ ...queryOf(commit.reference), prepareToken: commit.reference.prepareToken,
      historyToken: commit.historyToken, operationId: commit.confirmOperationId }) }
    catch { return this.queryCommit(commit) }
    if (!result.ok) return { state: 'failed', stage: 'confirm', reference: commit.reference, commit, message: result.error.message }
    return this.settlement(parseTranslationSourceReference(result.value), commit, 'confirm')
  }

  private async queryCommit(commit: TranslationSourceHistoryCommit): Promise<TranslationSourceSaveOutcome> {
    let result: TranslationSourceStorageResult<TranslationSourceReference>
    try { result = await this.port.queryReference(queryOf(commit.reference)) }
    catch { return { state: 'unknown', stage: 'query', reference: commit.reference, commit,
      message: '原稿引用确认仍不明确，请继续查询同一引用。' } }
    if (!result.ok) return { state: 'unknown', stage: 'query', reference: commit.reference, commit, message: result.error.message }
    return this.settlement(parseTranslationSourceReference(result.value), commit, 'query')
  }

  private settlement(reference: TranslationSourceReference, commit: TranslationSourceHistoryCommit, stage: TransactionStage): TranslationSourceSaveOutcome {
    if (!sameReferenceIdentity(reference, commit.reference) || reference.state !== 'released' &&
      reference.referenceVersion !== commit.reference.referenceVersion || reference.state === 'confirmed' && reference.historyToken !== commit.historyToken) {
      return { state: 'failed', stage, reference: commit.reference, commit, message: '原稿引用回执与准确历史提交不一致。' }
    }
    if (reference.state === 'confirmed' || reference.state === 'released') return { state: reference.state, reference }
    return { state: 'prepared', reference, commit, reason: 'confirmation_unresolved' }
  }
}
