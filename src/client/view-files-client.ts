import { MAX_VIEW_FILE_BYTES, parseViewFileResult, type ViewFileClear, type ViewFileOpen, type ViewFilePort, type ViewFileResult } from '../shared/view-files.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS } from '../shared/translation-source-read.js'
import { parseTranslationSourceStorageRequest, type TranslationSourceStoredRead, type TranslationSourceStoragePort } from '../shared/translation-source-storage.js'
import { parseTranslationSourceAsset, parseTranslationSourceResult, parseTranslationSourceScope, toSourceIdentity,
  type TranslationSourceAsset, type TranslationSourceAssetPage, type TranslationSourceResult, type TranslationSourceScope, type TranslationSourcesPort } from '../shared/translation-sources.js'
import type { SessionStore } from './session-store.js'

export type ViewFilesRemotePort = { [K in keyof ViewFilePort]: (...args: Parameters<ViewFilePort[K]>) => Promise<unknown> }
function data(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
/** Unwrap the native Gateway RemoteResult before parsing the independent view-file protocol. */
export function adaptViewFilesRemote(remote: ViewFilesRemotePort | undefined | (() => Promise<ViewFilesRemotePort | undefined>)): ViewFilePort {
  async function invoke<T>(method: keyof ViewFilePort, args: readonly unknown[]): Promise<ViewFileResult<T>> {
    const port = typeof remote === 'function' ? await remote() : remote
    if (!port) throw new Error('打开服务未就绪，请重试。')
    const response = await (port[method] as (...args: readonly unknown[]) => Promise<unknown>)(...args)
    if (!data(response) || response.ok !== true || !data(response.value)) throw new Error('未取得打开服务传输回执。')
    return parseViewFileResult(method, response.value) as ViewFileResult<T>
  }
  return { open: (request, signal) => invoke('open', [request, signal]), clear: (request, signal) => invoke('clear', [request, signal]) }
}

export interface ViewOpenOutcome { readonly ok: boolean; readonly message?: string }
export type ViewSourceOpenRequest = Omit<ViewFileOpen, 'text' | 'format'>
export interface ViewSourceSnapshot {
  readonly scope: TranslationSourceScope
  readonly sourceRef?: TranslationSourceAsset
  readonly librarySource?: Pick<import('../shared/library-sources.js').LibrarySourceRequest, 'stored' | 'namespaceId' | 'prepareToken'>
  readonly savedSource?: TranslationSourceStoredRead
  readonly file?: Blob
}
export interface ViewFilesSourceOptions { readonly library?: import('../shared/library-sources.js').LibrarySourcesPort; readonly sources?: TranslationSourcesPort; readonly sourceStorage?: TranslationSourceStoragePort }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function textFileFormat(name?: string): 'txt' | 'md' { return name && /\.md$/iu.test(name) ? 'md' : 'txt' }
/** Host opening files mirror the Client session lifetime: capture the scope before a deletion, clear after it. */
export class ViewFilesClient {
  private readonly operations = new Set<AbortController>()
  private readonly openingScopes = new Map<AbortController, { readonly namespaceId: string; readonly sessionId: string }>()
  private readonly listeners = new Set<() => void>()
  private notice: string | undefined
  private disposed = false
  constructor(private readonly port: ViewFilePort, private readonly sessions: SessionStore, private readonly sourceOptions: ViewFilesSourceOptions = {}) {}
  getNamespaceId(): string { return this.sessions.getNamespaceId() }
  dispose(): void { this.disposed = true; for (const operation of this.operations) operation.abort(); this.operations.clear(); this.openingScopes.clear(); this.listeners.clear() }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getNotice(): string | undefined { return this.notice }
  /** Capture the owner scope while the sessions still exist; deletion then clears exactly these scopes. */
  captureCleanup(ids: readonly string[]): readonly ViewFileClear[] {
    const groups = new Map<string, string[]>()
    for (const id of [...new Set(ids)]) {
      const session = this.sessions.getSession(id)
      if (!session) continue
      const list = groups.get(this.sessions.getNamespaceId())
      if (list) list.push(id)
      else groups.set(this.sessions.getNamespaceId(), [id])
    }
    return [...groups].map(([namespaceId, sessionIds]) => ({ namespaceId, sessionIds }))
  }
  async open(request: ViewFileOpen, signal?: AbortSignal): Promise<ViewOpenOutcome> {
    request = { ...request, namespaceId: this.sessions.getNamespaceId() }
    return await this.operation(signal => this.openRequest(request, signal), request, signal)
  }
  /** Read the captured UTF-8 file without touching it; decoding retains its BOM and all newline characters. */
  async openCapturedTxt(request: ViewSourceOpenRequest, file: Blob, signal?: AbortSignal): Promise<ViewOpenOutcome> {
    return await this.operation(async signal => this.openRequest({ ...request, text: await this.capturedText(file, signal, request.fileName), format: textFileFormat(request.fileName ?? (file as File).name) }, signal), request, signal)
  }
  async readImageOriginal(snapshot: ViewSourceSnapshot, original: import('../shared/translation-sources.js').SourceIdentity): Promise<Uint8Array<ArrayBuffer>> {
    let bytes: Uint8Array<ArrayBuffer>
    if (snapshot.librarySource && this.sourceOptions.library) {
      if (snapshot.librarySource.namespaceId !== this.sessions.getNamespaceId() || !same(snapshot.librarySource.stored.source, original)) throw new Error('原图保存引用与当前单元不一致。')
      const result = await this.sourceOptions.library.readLibrarySource({ ...snapshot.librarySource, action: 'image' })
      if (!result.ok) throw new Error(result.error.message)
      if (result.value.kind !== 'image') throw new Error('原图读取回执无效。')
      const binary = atob(result.value.base64)
      bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    } else if (snapshot.file) {
      bytes = new Uint8Array(await snapshot.file.arrayBuffer())
    } else throw new Error('原图暂不可读取。')
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (bytes.byteLength !== original.bytes || hash !== original.sha256) throw new Error('原图与已登记的文件不一致。')
    return bytes
  }

  /** Saved non-Markdown opens the original; Markdown uses verified text to resolve images in an opening copy. */
  async openSource(request: ViewSourceOpenRequest, snapshot: ViewSourceSnapshot, signal?: AbortSignal): Promise<ViewOpenOutcome> {
    return await this.operation(async signal => {
      const scope = parseTranslationSourceScope(snapshot.scope)
      if (request.kind !== 'source' || request.sessionId !== scope.translationSessionId) throw new Error('原稿打开范围与文件单元不一致。')
      const savedIdentity = snapshot.savedSource?.source ?? snapshot.librarySource?.stored.source
      let source = snapshot.sourceRef ? parseTranslationSourceAsset(snapshot.sourceRef)
        : savedIdentity ? parseTranslationSourceAsset({ ...savedIdentity, persistence: 'runtime_only' }) : undefined
      const markdown = textFileFormat(request.fileName ?? source?.name ?? snapshot.savedSource?.source.name) === 'md'
      if (snapshot.librarySource) {
        if (!this.sourceOptions.library) throw new Error('资料库原稿打开服务尚未就绪。')
        if (snapshot.librarySource.namespaceId !== this.sessions.getNamespaceId() || snapshot.librarySource.stored.scope.translationSessionId !== request.sessionId) throw new Error('共享原稿范围不一致。')
        if (!markdown) {
          const result = await this.sourceOptions.library.readLibrarySource({ ...snapshot.librarySource, action: 'open' }, signal)
          return result.ok ? { ok: true } : { ok: false, message: result.error.message }
        }
      }
      if (snapshot.savedSource && !snapshot.librarySource) {
        const stored = parseTranslationSourceStorageRequest('openOriginal', snapshot.savedSource) as TranslationSourceStoredRead
        if (!same(stored.scope, scope) || source && !same(stored.source, toSourceIdentity(source))) throw new Error('已保存原稿与此源版本不一致。')
        if (!this.sourceOptions.sourceStorage) throw new Error('原稿存储打开服务未就绪，请重试。')
        if (!markdown) {
          const result = await this.sourceOptions.sourceStorage.openOriginal(stored, signal)
          signal.throwIfAborted()
          return result.ok ? { ok: true } : { ok: false, message: result.error.message }
        }
        if (!snapshot.librarySource) {
          const restored = await this.sourceOptions.sourceStorage.restore(stored)
          if (!restored.ok) throw new Error(restored.error.message)
          source = parseTranslationSourceAsset(restored.value.source)
        }
      }
      if (source) {
        if (!snapshot.librarySource && !this.sourceOptions.sources) throw new Error('原稿读取服务未就绪，请重试。')
        if (source.bytes > MAX_VIEW_FILE_BYTES) throw new Error('原稿超过 16 MiB 打开上限。')
        const pieces: string[] = []
        for (let start = 0; start < source.totalCodePoints; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
          signal.throwIfAborted()
          const range = { start, end: Math.min(start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, source.totalCodePoints) }
          if (snapshot.librarySource) {
            const result = await this.sourceOptions.library!.readLibrarySource({ ...snapshot.librarySource, action: 'page', range }, signal)
            if (!result.ok) throw new Error(result.error.message)
            if (result.value.kind !== 'page' || Array.from(result.value.text).length !== range.end - range.start) throw new Error('原稿分页与指定范围不一致。')
            pieces.push(result.value.text); continue
          }
          const raw = await this.sourceOptions.sources!.readRange({ scope, sourceId: source.sourceId, version: source.version, range })
          signal.throwIfAborted()
          const result = parseTranslationSourceResult('readRange', raw) as TranslationSourceResult<TranslationSourceAssetPage>
          if (!result.ok) throw new Error(result.error.message)
          if (!same(parseTranslationSourceScope(result.value.scope), scope) || !same(parseTranslationSourceAsset(result.value.source), source) || result.value.range.start !== range.start || result.value.range.end !== range.end) throw new Error('原稿读取结果与固定源版本不一致。')
          pieces.push(result.value.text)
        }
        const text = pieces.join(''), bytes = new TextEncoder().encode(text)
        if (bytes.byteLength !== source.bytes || text.startsWith('\uFEFF') !== source.bom) throw new Error('原稿字节长度或 BOM 与固定源版本不一致。')
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
        signal.throwIfAborted()
        if (hash !== source.sha256) throw new Error('原稿内容与固定源版本校验不一致。')
        return await this.openRequest({ ...request, revisionId: request.revisionId ?? `source:${source.sourceId}:${source.version}`,
          fileName: request.fileName ?? source.name, text, format: textFileFormat(request.fileName ?? source.name),
          ...(source.originalFilePath ? { originalFilePath: source.originalFilePath } : {}) }, signal)
      }
      if (!snapshot.file) throw new Error('本次原稿文件不可用，请重新选择文件。')
      return await this.openRequest({ ...request, text: await this.capturedText(snapshot.file, signal, request.fileName), format: textFileFormat(request.fileName ?? (snapshot.file as File).name) }, signal)
    }, request, signal)
  }
  private async capturedText(file: Blob, signal: AbortSignal, fileName?: string): Promise<string> {
    const originalName = fileName ?? (file as Blob & { readonly name?: string }).name
    if (!originalName || !/\.(?:txt|md)$/iu.test(originalName)) throw new Error('当前仅支持打开 UTF-8 TXT／Markdown 原稿。')
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_VIEW_FILE_BYTES) throw new Error('文本原稿超过 16 MiB 打开上限。')
    const bytes = await file.arrayBuffer()
    signal.throwIfAborted()
    if (bytes.byteLength !== file.size || bytes.byteLength > MAX_VIEW_FILE_BYTES) throw new Error('文本原稿字节长度发生变化，未打开。')
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw new Error('原稿不是有效 UTF-8 文本，未替换或猜测编码。') }
  }
  private async openRequest(request: ViewFileOpen, signal: AbortSignal): Promise<ViewOpenOutcome> {
    request = { ...request, namespaceId: this.sessions.getNamespaceId() }
    signal.throwIfAborted()
    const result = await this.port.open(request, signal)
    signal.throwIfAborted()
    return result.ok ? { ok: true } : { ok: false, message: result.error.message }
  }
  private async operation(action: (signal: AbortSignal) => Promise<ViewOpenOutcome>, scope?: { readonly namespaceId: string; readonly sessionId: string }, signal?: AbortSignal): Promise<ViewOpenOutcome> {
    if (this.disposed) return { ok: false, message: '打开服务已关闭。' }
    const operation = new AbortController(); this.operations.add(operation)
    if (scope) this.openingScopes.set(operation, scope)
    const abort = (): void => operation.abort()
    if (signal?.aborted) operation.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    try {
      operation.signal.throwIfAborted()
      return await action(operation.signal)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '打开服务未就绪，请重试。' }
    } finally { signal?.removeEventListener('abort', abort); this.operations.delete(operation); this.openingScopes.delete(operation) }
  }
  async clear(scopes: readonly ViewFileClear[]): Promise<boolean> {
    if (this.disposed || !scopes.length) return true
    let failed = false
    for (const scope of scopes) {
      for (const [operation, opening] of this.openingScopes) if (opening.namespaceId === scope.namespaceId && scope.sessionIds.includes(opening.sessionId)) operation.abort()
      const operation = new AbortController(); this.operations.add(operation)
      try {
        const result = await this.port.clear(scope, operation.signal)
        if (!result.ok) failed = true
      } catch { failed = true }
      finally { this.operations.delete(operation) }
    }
    const notice = failed ? '会话已删除，但打开文件工件未全部清理。' : undefined
    if (notice !== this.notice) { this.notice = notice; this.notify() }
    return !failed
  }
  private notify(): void { for (const listener of [...this.listeners]) listener() }
}
