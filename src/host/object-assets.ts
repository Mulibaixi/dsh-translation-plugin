import { OBJECT_ASSET_REMOTE, parseObjectAssetRequest, parseObjectAssetVersion, type ObjectAssetCapability, type ObjectAssetErrorCode,
  type ObjectAssetOpen, type ObjectAssetRegister, type ObjectAssetRegistration, type ObjectAssetResult, type ObjectAssetVersion } from '../shared/object-assets.js'
import type { QuickHostContext } from './quick-translation.js'
import { uploadedFile, type NativeUpload } from './native-upload.js'

interface FileRef { readonly attachmentId: string; readonly name: string; readonly bytes: number }
interface Agent { readonly id: string; readonly session: { readonly id: string }; readonly ctx: unknown }
interface Attachments { readFileStream(ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array>; fileHostPath(ref: FileRef): string | undefined }
interface Controller { resolveAgent(id: string): Promise<Agent>; canOpenWorkspacePath(): boolean; openWorkspacePath(request: { path: string }, signal: AbortSignal): Promise<{ opened: true }> }
export interface StoredObjectAsset { readonly schemaVersion: 1 | 2; readonly ownerId?: string; readonly namespaceId?: string; readonly topicId: string; readonly asset: ObjectAssetVersion; readonly file: FileRef }
export interface ObjectAssetStorage { read(assetId: string): Promise<StoredObjectAsset | undefined>; write(record: StoredObjectAsset): Promise<void> }
export interface ObjectHostOptions { readonly storage?: ObjectAssetStorage; readonly loadStorage?: () => Promise<ObjectAssetStorage> }
function ok<T>(value: T): ObjectAssetResult<T> { return { ok: true, value: structuredClone(value) } }
function bad<T>(code: ObjectAssetErrorCode, message: string): ObjectAssetResult<T> { return { ok: false, error: { code, message } } }
function stored(value: unknown): StoredObjectAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid object mapping')
  const entry = value as Record<string, unknown>, file = entry.file as Record<string, unknown>
  if (![1, 2].includes(entry.schemaVersion as number) || (entry.schemaVersion === 1 ? typeof entry.ownerId !== 'string' : typeof entry.namespaceId !== 'string') || typeof entry.topicId !== 'string' || !file || typeof file !== 'object'
    || Object.keys(entry).some(key => !['schemaVersion', 'ownerId', 'namespaceId', 'topicId', 'asset', 'file'].includes(key))
    || Object.keys(file).some(key => !['attachmentId', 'name', 'bytes'].includes(key)) || typeof file.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(file.attachmentId)) throw new TypeError('Invalid object mapping')
  const asset = parseObjectAssetVersion(entry.asset)
  if (file.name !== asset.name || file.bytes !== asset.bytes) throw new TypeError('Invalid object mapping')
  return { schemaVersion: entry.schemaVersion as 1 | 2, ...(entry.schemaVersion === 1 ? { ownerId: entry.ownerId as string } : { namespaceId: entry.namespaceId as string }), topicId: entry.topicId, asset, file: { attachmentId: file.attachmentId, name: asset.name, bytes: asset.bytes } }
}
/** Resolve the public DSH data root and atomic writer from the Host composition, never Client paths. */
export async function loadObjectAssetStorage(ctx: QuickHostContext): Promise<ObjectAssetStorage> {
  const loader = ctx.get?.('loader') as QuickHostContext['loader']
  if (!ctx.baseUrl || !loader?.internal) throw new Error('Host package loader unavailable')
  const [home, atomic] = await Promise.all([
    loader.internal.import('@deepseek-ai/dsh-home-paths', ctx.baseUrl, {}) as Promise<{ dshHomePath(...parts: string[]): string }>,
    loader.internal.import('@deepseek-ai/dsh-atomic-write', ctx.baseUrl, {}) as Promise<{ writeFileAtomic(path: string, text: string, options: { mode: number }): Promise<void> }>,
  ])
  const fsName = 'node:fs/promises', pathName = 'node:path'
  const fs = await import(fsName) as { readFile(path: string, encoding: 'utf8'): Promise<string> }
  const path = await import(pathName) as { join(...parts: string[]): string }
  const root = home.dshHomePath('translation-plugin', 'objects', 'v1')
  const locate = (assetId: string): string => {
    if (!/^asset-[0-9a-f-]{36}$/u.test(assetId)) throw new TypeError('Invalid asset identity')
    return path.join(root, `${assetId}.json`)
  }
  // Serialize with the profile-wide data clear; the writer generation must be current at call time.
  const gate = <T>(action: () => Promise<T>): Promise<T> => {
    const data = ctx.get?.('translationLocalData') as { storageWriter?: () => <U>(action: () => Promise<U>) => Promise<U> } | undefined
    const writer = typeof data?.storageWriter === 'function' ? data.storageWriter() : undefined
    return writer ? writer(action) : action()
  }
  return {
    async read(assetId) {
      let text: string
      try { text = await fs.readFile(locate(assetId), 'utf8') } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }
      const record = stored(JSON.parse(text))
      if (record.asset.assetId !== assetId) throw new TypeError('Asset identity mismatch')
      return record
    },
    async write(record) { await gate(() => atomic.writeFileAtomic(locate(record.asset.assetId), JSON.stringify(stored(record)), { mode: 0o600 })) },
  }
}

/** File-only mapping. Canonical body positions and object reference authority remain in Client SessionStore. */
export class ObjectAssetsService {
  readonly typertRemote: { readonly service: ObjectAssetsService; readonly serviceKey: 'translationObjects'; readonly namespace: 'translationObjects' }
  private readonly records = new Map<string, StoredObjectAsset>()
  private readonly saved = new Set<string>()
  private readonly receipts = new Map<string, StoredObjectAsset>()
  private storage: Promise<ObjectAssetStorage> | undefined
  private disposed = false
  constructor(readonly ctx: QuickHostContext, private readonly options: ObjectHostOptions = {}) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationObjects', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationObjects', namespace: 'translationObjects' })
  }
  private owns(namespaceId: string): boolean {
    const peer = this.ctx.invocation?.peer.id
    const topics = this.ctx.get?.('translationTopics') as { ownsLibrary(namespaceId: string, peerId: string): boolean } | undefined
    return !this.disposed && !!peer && !!topics?.ownsLibrary(namespaceId, peer)
  }
  private disk(): Promise<ObjectAssetStorage> {
    if (!this.storage) this.storage = (this.options.storage ? Promise.resolve(this.options.storage) : (this.options.loadStorage ?? (() => loadObjectAssetStorage(this.ctx)))()).catch(error => { this.storage = undefined; throw error })
    return this.storage
  }
  private async read(assetId: string): Promise<StoredObjectAsset | undefined> {
    const resident = this.records.get(assetId)
    if (resident) return resident
    const value = await (await this.disk()).read(assetId)
    if (!value) return undefined
    const record = stored(value)
    if (record.asset.assetId !== assetId) throw new TypeError('Asset identity mismatch')
    this.records.set(assetId, record); this.saved.add(assetId)
    return record
  }
  /** Drop cached registrations after a topic purge; files are removed by the local-data service. */
  forgetTopic(ownerId: string, topicId: string): void {
    for (const [assetId, record] of this.records) if (record.topicId === topicId) { this.records.delete(assetId); this.saved.delete(assetId) }
  }
  async capabilities(): Promise<ObjectAssetResult<ObjectAssetCapability>> {
    const attachments = this.ctx.get?.('attachments') as Attachments | undefined, uploads = this.ctx.get?.('fileUploads') as { resolve?: unknown } | undefined
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    const ready = !this.disposed && typeof attachments?.readFileStream === 'function' && typeof attachments?.fileHostPath === 'function' && typeof uploads?.resolve === 'function' && !!controller
    return ok({ ready, nativeOpen: ready && controller!.canOpenWorkspacePath(), ...(ready ? {} : { reason: '宿主受管原件服务尚未就绪。' }) })
  }
  async register(input: ObjectAssetRegister, signal: AbortSignal): Promise<ObjectAssetResult<ObjectAssetRegistration>> {
    let request: ObjectAssetRegister
    try { request = parseObjectAssetRequest('register', input) as ObjectAssetRegister } catch { return bad('invalid_input', '原件关联参数无效。') }
    if (!this.owns(request.namespaceId)) return bad('scope_mismatch', '原件关联不属于此主会话连接。')
    const attachments = this.ctx.get?.('attachments') as Attachments | undefined
    const uploads = this.ctx.get?.('fileUploads') as { resolve(agent: Agent, receiptId: string): NativeUpload | undefined } | undefined
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    if (!attachments || typeof uploads?.resolve !== 'function' || !controller) return bad('unavailable', '宿主受管原件服务尚未就绪。')
    signal.throwIfAborted()
    let agent = (this.ctx.get?.('agents') as { get(id: string): Agent | undefined } | undefined)?.get(request.mainSessionId)
    try { agent ??= await controller.resolveAgent(request.mainSessionId) } catch { return bad('unavailable', '无法恢复所属主会话的上传服务。') }
    if (!this.owns(request.namespaceId) || agent.id !== request.mainSessionId || agent.session.id !== request.mainSessionId) return bad('scope_mismatch', '上传主会话身份不一致。')
    const file = uploadedFile(uploads.resolve(agent, request.receiptId))
    if (!file) return bad('receipt_not_found', '原件上传收据已失效或属于其他主会话，请重新选择原件。')
    const receiptKey = JSON.stringify([request.mainSessionId, request.topicId, request.receiptId, request.kind, request.existingObjectId ?? null])
    let record = this.receipts.get(receiptKey), original: StoredObjectAsset | undefined
    try {
      if (request.existingObjectId) {
        original = await this.read(request.existingObjectId.replace(/^object-/u, 'asset-'))
        if (!original || (original.namespaceId !== undefined && original.namespaceId !== request.namespaceId) || original.topicId !== request.topicId || original.asset.objectId !== request.existingObjectId || original.asset.kind !== request.kind) return bad('not_found', '所属主题的原始对象不存在或类型不一致。')
      }
    } catch { return bad('storage_failed', '无法读取已登记的对象映射。') }
    record ??= this.receipts.get(receiptKey)
    if (!record) {
      const identity = crypto.randomUUID()
      try { record = stored({ schemaVersion: 2, namespaceId: request.namespaceId, topicId: request.topicId,
        asset: { objectId: request.existingObjectId ?? `object-${identity}`, assetId: `asset-${identity}`, version: 1, kind: request.kind, name: file.name, bytes: file.bytes }, file })
      } catch { return bad('invalid_input', '宿主返回了无效的原件身份。') }
      this.receipts.set(receiptKey, record)
    }
    signal.throwIfAborted()
    if (!this.owns(request.namespaceId)) return bad('scope_mismatch', '原件关联连接已断开。')
    try {
      const disk = await this.disk()
      if (!this.saved.has(record.asset.assetId)) { await disk.write(record); this.saved.add(record.asset.assetId) }
    } catch { return bad('storage_failed', '原件已上传，但关联映射保存失败，请重试关联。') }
    this.records.set(record.asset.assetId, record)
    return ok({ ...record.asset, persistence: 'saved' })
  }
  async open(input: ObjectAssetOpen, signal: AbortSignal): Promise<ObjectAssetResult<{ readonly opened: true }>> {
    let request: ObjectAssetOpen
    try { request = parseObjectAssetRequest('open', input) as ObjectAssetOpen } catch { return bad('invalid_input', '原件打开参数无效。') }
    if (!this.owns(request.namespaceId)) return bad('scope_mismatch', '原件打开不属于此主会话连接。')
    let record: StoredObjectAsset | undefined
    try { record = await this.read(request.assetId) } catch { return bad('storage_failed', '无法读取原件映射。') }
    if (!record || (record.namespaceId !== undefined && record.namespaceId !== request.namespaceId) || record.topicId !== request.topicId || record.asset.objectId !== request.objectId || record.asset.version !== request.version) return bad('not_found', '此主题的固定原件版本不可用。')
    const attachments = this.ctx.get?.('attachments') as Attachments | undefined, controller = this.ctx.get?.('sessionController') as Controller | undefined
    if (!attachments || !controller?.canOpenWorkspacePath()) return bad('unavailable', '当前宿主不支持原件在系统应用中打开。')
    try { for await (const _chunk of attachments.readFileStream(record.file, signal)) { signal.throwIfAborted() } }
    catch { signal.throwIfAborted(); return bad('integrity_failed', '原件不存在或校验失败，无法打开此固定版本。') }
    signal.throwIfAborted()
    if (!this.owns(request.namespaceId)) return bad('scope_mismatch', '原件打开连接已断开。')
    const path = attachments.fileHostPath(record.file)
    if (!path) return bad('unavailable', '此附件存储未提供可打开的原件。')
    try { await controller.openWorkspacePath({ path }, signal); return ok({ opened: true }) }
    catch { signal.throwIfAborted(); return bad('open_failed', '原件未能在系统应用中打开，请检查文件关联后重试。') }
  }
  dispose(): void { this.disposed = true; this.records.clear(); this.receipts.clear(); this.saved.clear() }
}
export function installObjectAssets(ctx: QuickHostContext, options: ObjectHostOptions = {}, registerRemote = true): ObjectAssetsService {
  if (ctx.root && !Object.hasOwn(ctx.root.reflect.props, 'invocation')) ctx.root.accessor('invocation', { get: () => undefined })
  const service = new ObjectAssetsService(ctx, options)
  ctx.provide('translationObjects', service)
  const register = (scope: QuickHostContext): void => {
    const registry = (scope.get?.('typert') ?? scope.typert) as QuickHostContext['typert']
    registry?.register({ package: OBJECT_ASSET_REMOTE.package, face: 'host', schemas: [], invocations: OBJECT_ASSET_REMOTE.descriptors,
      model: { package: OBJECT_ASSET_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
  }
  if (registerRemote) { if (ctx.inject) ctx.inject(['typert'], register); else register(ctx) }
  ctx.effect?.(() => () => service.dispose(), 'translation managed objects lifetime')
  return service
}
