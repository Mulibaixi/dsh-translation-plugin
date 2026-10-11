import { parseObjectAssetResult, type ObjectAssetPort, type ObjectAssetResult, type ObjectAssetVersion, type ObjectAssetKind } from '../shared/object-assets.js'
import type { RecordObjectReferenceInput, RecordObjectTarget } from '../shared/record-objects.js'
import type { SessionStore } from './session-store.js'
import type { RecordObjectStore } from './record-object-store.js'
import { canEditTextRevision, isTextUnit } from './translation-history.js'

export type ObjectAssetsRemotePort = { [K in keyof ObjectAssetPort]: (...args: Parameters<ObjectAssetPort[K]>) => Promise<unknown> }
export interface NativeFileUploadPort {
  upload(ownerId: string, file: Blob, name: string, signal: AbortSignal, onProgress: (progress: unknown) => void): Promise<unknown>
}
function data(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function adaptObjectAssetsRemote(remote: ObjectAssetsRemotePort | undefined | (() => Promise<ObjectAssetsRemotePort | undefined>)): ObjectAssetPort {
  async function invoke<T>(method: keyof ObjectAssetPort, args: readonly unknown[]): Promise<ObjectAssetResult<T>> {
    const port = typeof remote === 'function' ? await remote() : remote
    if (!port) throw new Error('原件服务未就绪，请重试。')
    const result = await (port[method] as (...args: readonly unknown[]) => Promise<unknown>)(...args)
    if (!data(result) || result.ok !== true || !data(result.value)) throw new Error('未取得原件服务回执，请重试。')
    return parseObjectAssetResult(method, result.value) as ObjectAssetResult<T>
  }
  return { capabilities: () => invoke('capabilities', []), register: (request, signal) => invoke('register', [request, signal]), open: (request, signal) => invoke('open', [request, signal]) }
}
/** Uploads use the native Client service; only a receipt crosses the plugin RPC. */
export class ObjectAssetsClient {
  private readonly operations = new Set<AbortController>()
  private disposed = false
  constructor(private readonly port: ObjectAssetPort, private readonly upload: NativeFileUploadPort,
    private readonly sessions: SessionStore, private readonly references: RecordObjectStore, private readonly scopeStatus: (ownerId: string) => { readonly ready: boolean; readonly reason: string | undefined }) {}
  dispose(): void { this.disposed = true; for (const operation of this.operations) operation.abort(); this.operations.clear() }
  private validate(target: RecordObjectTarget, offset: number): void {
    const session = this.sessions.getSession(target.sessionId)
    const unit = this.sessions.getTranslationHistory(target.sessionId)?.units.find(unit => unit.id === target.unitId)
    if (unit && !isTextUnit(unit)) throw new Error('文档的原件位置关联尚未接通。')
    const revision = unit?.revisions.find(revision => revision.id === target.revisionId)
    const text = target.side === 'source' && target.revisionId === null ? unit?.source : target.side === 'revision' && revision && canEditTextRevision(revision) ? revision.text : undefined
    if (this.disposed || !session || this.sessions.isSessionDeleted(session.id) || session.ownerId !== target.ownerId || session.topicId !== target.topicId || session.archivedAt !== null || text === undefined || !Number.isSafeInteger(offset) || offset < 0 || offset > Array.from(text).length) throw new Error('记录或关联位置已不可用，请重新选择。')
  }
  async attachFile(target: RecordObjectTarget, offset: number, kind: ObjectAssetKind, file: File, existingObjectId?: string, formulaSource?: string) {
    this.validate(target, offset)
    if (existingObjectId && this.references.getReferences(target).some(ref => ref.offset === offset && ref.asset.objectId === existingObjectId)) throw new Error('此位置已有该对象，请选择另一位置或译文版本。')
    const status = this.scopeStatus(target.ownerId)
    if (!status.ready) throw new Error(status.reason ?? '主题连接未就绪，请重试。')
    const expectedVersion = this.references.getSnapshot(target.ownerId, target.topicId, target.sessionId).version
    const operation = new AbortController(); this.operations.add(operation)
    try {
      const capability = await this.port.capabilities()
      if (!capability.ok || !capability.value.ready || !capability.value.nativeOpen) throw new Error(capability.ok ? capability.value.reason ?? '原件服务暂不可用。' : capability.error.message)
      const receipt = await this.upload.upload(target.ownerId, file, file.name, operation.signal, () => {})
      if (!data(receipt) || receipt.ok !== true || !data(receipt.value) || typeof receipt.value.receiptId !== 'string' || !receipt.value.receiptId) throw new Error('上传未完成，请重试。')
      this.validate(target, offset)
      const registered = await this.port.register({ ownerId: target.ownerId, topicId: target.topicId, translationSessionId: target.sessionId,
        unitId: target.unitId, side: target.side, revisionId: target.revisionId, offset, kind, receiptId: receipt.value.receiptId,
        ...(existingObjectId ? { existingObjectId } : {}) }, operation.signal)
      if (!registered.ok) throw new Error(registered.error.message)
      const { objectId, assetId, version, name, bytes } = registered.value
      const input: RecordObjectReferenceInput = { ...target, offset, asset: { objectId, assetId, version, kind: registered.value.kind, name, bytes }, ...(kind === 'formula' && formulaSource?.trim() ? { formulaSource } : {}) }
      this.validate(target, offset)
      return { input, result: await this.references.addReference(input, expectedVersion) }
    } finally { this.operations.delete(operation) }
  }
  async bind(input: RecordObjectReferenceInput) {
    this.validate(input, input.offset)
    return this.references.addReference(input, this.references.getSnapshot(input.ownerId, input.topicId, input.sessionId).version)
  }
  async open(ownerId: string, topicId: string, asset: ObjectAssetVersion): Promise<void> {
    if (this.disposed) throw new Error('原件服务已关闭。')
    const operation = new AbortController(); this.operations.add(operation)
    try {
      const result = await this.port.open({ ownerId, topicId, objectId: asset.objectId, assetId: asset.assetId, version: asset.version }, operation.signal)
      if (!result.ok) throw new Error(result.error.message)
    } finally { this.operations.delete(operation) }
  }
}
