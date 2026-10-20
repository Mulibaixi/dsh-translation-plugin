import { VIEW_FILES_REMOTE, parseViewFileRequest, type ViewFileClear, type ViewFileErrorCode, type ViewFileOpen, type ViewFileResult } from '../shared/view-files.js'
import type { QuickHostContext } from './quick-translation.js'
import { sourceSha256 } from './source-storage.js'

interface Controller { canOpenWorkspacePath(): boolean; openWorkspacePath(request: { path: string }, signal: AbortSignal): Promise<{ opened: true }> }
export interface ViewFileStorage {
  write(request: ViewFileOpen, content: string): Promise<string>
  clear(sessionIds: readonly string[]): Promise<number>
}
export interface ViewFilesHostOptions { readonly storage?: ViewFileStorage; readonly loadStorage?: () => Promise<ViewFileStorage> }
function ok<T>(value: T): ViewFileResult<T> { return { ok: true, value: structuredClone(value) } }
function bad<T>(code: ViewFileErrorCode, message: string): ViewFileResult<T> { return { ok: false, error: { code, message } } }
function escapeHtml(value: string): string { return value.replace(/[&<>]/gu, character => character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;') }
function absent(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT' }
/** Accept only names generated here, including the earlier HTML-only layout. */
export function isViewFileStorageName(name: string): boolean {
  return /^[a-f0-9]{64}-[a-f0-9]{64}\.html$/u.test(name) || /^[a-f0-9]{64}-[a-f0-9]{64}--[^\\/<>:"|?*\u0000-\u001f\u007f]{1,64}\.txt$/u.test(name)
}
function txtStem(name: string): string {
  const safe = name.replace(/\.txt$/iu, '').replace(/[\\/<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '')
  // Bound the UTF-16 component length even when the stem contains supplementary characters.
  return [...safe].slice(0, 32).join('') || 'document'
}
/** The only page the Host renders: escaped text, no scripts, no network. */
export function renderViewPage(title: string, text: string): string {
  return ['<!doctype html>', '<html lang="zh-CN">', '<head>', '<meta charset="utf-8">', `<title>${escapeHtml(title)}</title>`,
    '<style>html{color-scheme:light}body{margin:0;padding:24px;background:#fff;color:#1f2329;font:14px/1.7 ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}</style>',
    '</head>', '<body>', '<!-- dsh-translation-plugin 打开页面：可安全删除，重新打开会覆盖重建。 -->', `<pre>${escapeHtml(text)}</pre>`, '</body>', '</html>', ''].join('\n')
}
/** Views live beside the plugin's other private data so a profile-wide data clear reaches them too. */
export async function loadViewFileStorage(ctx: QuickHostContext): Promise<ViewFileStorage> {
  const loader = ctx.get?.('loader') as QuickHostContext['loader']
  if (!ctx.baseUrl || !loader?.internal) throw new Error('Host package loader unavailable')
  const [home, atomic] = await Promise.all([
    loader.internal.import('@deepseek-ai/dsh-home-paths', ctx.baseUrl, {}) as Promise<{ dshHomePath(...parts: string[]): string }>,
    loader.internal.import('@deepseek-ai/dsh-atomic-write', ctx.baseUrl, {}) as Promise<{ writeFileAtomic(path: string, content: string, options: { mode: number; dirMode: number }): Promise<void> }>,
  ])
  const fsName = 'node:fs/promises', pathName = 'node:path'
  const fs = await import(fsName) as { readdir(path: string, options: { withFileTypes: true }): Promise<readonly { readonly name: string; isFile(): boolean }[]>; unlink(path: string): Promise<void> }
  const path = await import(pathName) as { join(...parts: string[]): string }
  const root = home.dshHomePath('translation-plugin', 'views', 'v1')
  const digest = async (parts: readonly (string | null)[]): Promise<string> => await sourceSha256(new TextEncoder().encode(JSON.stringify(parts)))
  const sessionPrefix = async (sessionId: string): Promise<string> => `${await digest(['view-session', sessionId])}-`
  // Serialize with the profile-wide data clear; the writer generation must be current at call time.
  const gate = <T>(action: () => Promise<T>): Promise<T> => {
    const data = ctx.get?.('translationLocalData') as { storageWriter?: () => <U>(action: () => Promise<U>) => Promise<U> } | undefined
    const writer = typeof data?.storageWriter === 'function' ? data.storageWriter() : undefined
    return writer ? writer(action) : action()
  }
  return {
    async write(request, content) {
      const format = request.format ?? 'html'
      const contentHash = await sourceSha256(new TextEncoder().encode(content))
      const identity = format === 'html' && request.revisionId === undefined ? await digest(['view-slot', request.unitId, request.kind])
        : await digest(['view-artifact', request.namespaceId, request.unitId, request.kind, request.revisionId ?? null, format, contentHash])
      const name = `${await sessionPrefix(request.sessionId)}${identity}${format === 'txt' ? `--${txtStem(request.fileName ?? request.title)}.txt` : '.html'}`
      const destination = path.join(root, name)
      await gate(() => atomic.writeFileAtomic(destination, content, { mode: 0o600, dirMode: 0o700 }))
      return destination
    },
    async clear(sessionIds) {
      const prefixes = await Promise.all(sessionIds.map(sessionPrefix))
      let entries: readonly { readonly name: string; isFile(): boolean }[]
      try { entries = await fs.readdir(root, { withFileTypes: true }) } catch (error) { if (absent(error)) return 0; throw error }
      let removed = 0
      for (const entry of entries) {
        if (!entry.isFile() || !isViewFileStorageName(entry.name) || !prefixes.some(prefix => entry.name.startsWith(prefix))) continue
        try { await fs.unlink(path.join(root, entry.name)); removed += 1 } catch (error) { if (!absent(error)) throw error }
      }
      return removed
    },
  }
}

/** Host-owned temporary artifacts. These files do not prove that source/history storage was saved. */
export class ViewFilesService {
  readonly typertRemote: { readonly service: ViewFilesService; readonly serviceKey: 'translationViews'; readonly namespace: 'translationViews' }
  private storage: Promise<ViewFileStorage> | undefined
  private readonly writes = new Map<Promise<string>, { readonly namespaceId: string; readonly sessionId: string }>()
  private readonly clearedSessions = new Set<string>()
  private disposed = false
  constructor(readonly ctx: QuickHostContext, private readonly options: ViewFilesHostOptions = {}) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationViews', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationViews', namespace: 'translationViews' })
  }
  private owns(namespaceId: string): boolean {
    const peer = this.ctx.invocation?.peer.id
    const topics = this.ctx.get?.('translationTopics') as { ownsLibrary(namespaceId: string, peerId: string): boolean } | undefined
    return !this.disposed && !!peer && !!topics?.ownsLibrary(namespaceId, peer)
  }
  private disk(): Promise<ViewFileStorage> {
    if (!this.storage) this.storage = (this.options.storage ? Promise.resolve(this.options.storage) : (this.options.loadStorage ?? (() => loadViewFileStorage(this.ctx)))()).catch(error => { this.storage = undefined; throw error })
    return this.storage
  }
  private cleared(namespaceId: string, sessionId: string): boolean { return this.clearedSessions.has(JSON.stringify([namespaceId, sessionId])) }
  async open(input: ViewFileOpen, signal: AbortSignal): Promise<ViewFileResult<{ readonly opened: true }>> {
    let request: ViewFileOpen
    try { request = parseViewFileRequest('open', input) as ViewFileOpen } catch { return bad('invalid_input', '打开文件参数无效或正文超过 16 MiB。') }
    if (!this.owns(request.namespaceId)) return bad('scope_mismatch', '打开文件不属于此主会话连接。')
    if (this.cleared(request.namespaceId, request.sessionId)) return bad('scope_mismatch', '此会话的打开文件已经清理。')
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    if (typeof controller?.canOpenWorkspacePath !== 'function' || !controller.canOpenWorkspacePath() || typeof controller.openWorkspacePath !== 'function') return bad('unavailable', '当前宿主不支持打开本地文件。')
    signal.throwIfAborted()
    let destination: string
    const writing = (async () => (await this.disk()).write(request, request.format === 'txt' ? request.text : renderViewPage(request.title, request.text)))()
    this.writes.set(writing, { namespaceId: request.namespaceId, sessionId: request.sessionId })
    try { destination = await writing }
    catch (error) {
      signal.throwIfAborted()
      return (error as { code?: string } | undefined)?.code === 'local_data_blocked' ? bad('local_data_stale', '本地数据已清理，打开文件已停止写入。') : bad('storage_failed', '打开文件写入失败，请重试。')
    } finally { this.writes.delete(writing) }
    signal.throwIfAborted()
    if (!this.owns(request.namespaceId) || this.cleared(request.namespaceId, request.sessionId)) return bad('scope_mismatch', '打开文件时所属连接或会话已失效。')
    try { await controller.openWorkspacePath({ path: destination }, signal) }
    catch { signal.throwIfAborted(); return bad('open_failed', '文件未能在系统默认应用中打开，请重试。') }
    signal.throwIfAborted()
    return ok({ opened: true })
  }
  async clear(input: ViewFileClear, signal: AbortSignal): Promise<ViewFileResult<{ readonly removed: number }>> {
    let request: ViewFileClear
    try { request = parseViewFileRequest('clear', input) as ViewFileClear } catch { return bad('invalid_input', '清理打开页面参数无效。') }
    if (!this.owns(request.namespaceId)) return bad('scope_mismatch', '清理打开页面不属于此主会话连接。')
    signal.throwIfAborted()
    for (const sessionId of request.sessionIds) this.clearedSessions.add(JSON.stringify([request.namespaceId, sessionId]))
    await Promise.allSettled([...this.writes].filter(([, scope]) => scope.namespaceId === request.namespaceId && request.sessionIds.includes(scope.sessionId)).map(([writing]) => writing))
    signal.throwIfAborted()
    try { return ok({ removed: await (await this.disk()).clear(request.sessionIds) }) }
    catch { signal.throwIfAborted(); return bad('storage_failed', '打开页面清理失败。') }
  }
  dispose(): void { this.disposed = true; this.storage = undefined }
}
export function installViewFiles(ctx: QuickHostContext, options: ViewFilesHostOptions = {}, registerRemote = true): ViewFilesService {
  if (ctx.root && !Object.hasOwn(ctx.root.reflect.props, 'invocation')) ctx.root.accessor('invocation', { get: () => undefined })
  const service = new ViewFilesService(ctx, options)
  ctx.provide('translationViews', service)
  const register = (scope: QuickHostContext): void => {
    const registry = (scope.get?.('typert') ?? scope.typert) as QuickHostContext['typert']
    registry?.register({ package: VIEW_FILES_REMOTE.package, face: 'host', schemas: [], invocations: VIEW_FILES_REMOTE.descriptors,
      model: { package: VIEW_FILES_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
  }
  if (registerRemote) { if (ctx.inject) ctx.inject(['typert'], register); else register(ctx) }
  ctx.effect?.(() => () => service.dispose(), 'translation view files lifetime')
  return service
}
