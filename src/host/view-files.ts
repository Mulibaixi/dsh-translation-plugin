import { VIEW_FILES_REMOTE, parseViewFileRequest, type ViewFileClear, type ViewFileErrorCode, type ViewFileOpen, type ViewFileResult } from '../shared/view-files.js'
import type { QuickHostContext } from './quick-translation.js'
import { sourceSha256 } from './source-storage.js'
import { resolveMarkdownImages } from './markdown-files.js'

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
/** Scope keys also recognize earlier flat opening copies for resource cleanup. */
export function viewFileStorageName(file: string): string {
  const normalized = file.replace(/\\/gu, '/'), marker = '/views/v1/'
  const relative = normalized.includes(marker) ? normalized.slice(normalized.lastIndexOf(marker) + marker.length) : normalized
  return relative.replace(/^([a-f0-9]{64})-(?:([a-f0-9]{64})-)?/u, (_match, session: string, unit?: string) => `${session.slice(0, 16)}-${unit ? `${unit.slice(0, 16)}-` : ''}`)
}
/** The directory carries identity; the filename remains readable. */
export function isViewFileStorageDirectory(name: string): boolean { return /^[a-f0-9]{16}-[a-f0-9]{16}-[a-f0-9]{16}-(?:source|result)$/u.test(name) }
export function isViewFileStorageName(name: string): boolean {
  return /^[a-f0-9]{16}-[a-f0-9]{16}-[a-f0-9]{16}-(?:source|result)\/[^\\/<>:"|?*\u0000-\u001f\u007f]{1,64}\.(?:txt|md|html)$/u.test(name) ||
    /^[a-f0-9]{16}-[a-f0-9]{16}-[a-f0-9]{16}-(?:source|result)\/image-[a-f0-9]{32}\.(?:png|jpg|jpeg|gif|webp|svg|avif|bmp|ico|apng)$/u.test(name) ||
    /^(?:[a-f0-9]{16}|[a-f0-9]{64})-(?:(?:[a-f0-9]{16}|[a-f0-9]{64})-(?:[a-f0-9]{16}-)?)?(?:[a-f0-9]{16}|[a-f0-9]{64})\.html$/u.test(name) ||
    /^(?:[a-f0-9]{16}|[a-f0-9]{64})-(?:(?:[a-f0-9]{16}|[a-f0-9]{64})-(?:[a-f0-9]{16}-)?)?(?:[a-f0-9]{16}|[a-f0-9]{64})--[^\\/<>:"|?*\u0000-\u001f\u007f]{1,64}\.txt$/u.test(name)
}
export async function viewUnitStoragePrefix(namespaceId: string, sessionId: string, unitId: string): Promise<string> {
  const digest = (parts: readonly string[]): Promise<string> => sourceSha256(new TextEncoder().encode(JSON.stringify(parts)))
  return `${(await digest(['view-session', sessionId])).slice(0, 16)}-${(await digest(['view-unit', namespaceId, unitId])).slice(0, 16)}-`
}
export async function viewSessionStoragePrefix(sessionId: string): Promise<string> {
  return `${(await sourceSha256(new TextEncoder().encode(JSON.stringify(['view-session', sessionId])))).slice(0, 16)}-`
}
export async function viewVersionStoragePrefix(namespaceId: string, sessionId: string, unitId: string, revisionId: string | null): Promise<string> {
  const version = (await sourceSha256(new TextEncoder().encode(JSON.stringify(['view-version', revisionId])))).slice(0, 16)
  return `${await viewUnitStoragePrefix(namespaceId, sessionId, unitId)}${version}-`
}
function textStem(name: string): string {
  const safe = name.replace(/\.(?:txt|md)$/iu, '').replace(/[\\/<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '')
  // Bound the UTF-16 component length even when the stem contains supplementary characters.
  let stem = ''
  for (const character of safe) { if (stem.length + character.length > 32) break; stem += character }
  return stem || 'document'
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
    loader.internal.import('@deepseek-ai/dsh-atomic-write', ctx.baseUrl, {}) as Promise<{ writeFileAtomic(path: string, content: string | Uint8Array, options: { mode: number; dirMode: number }): Promise<void> }>,
  ])
  const fsName = 'node:fs/promises', pathName = 'node:path'
  const fs = await import(fsName) as { readdir(path: string, options: { withFileTypes: true }): Promise<readonly { readonly name: string; isFile(): boolean; isDirectory(): boolean }[]>; unlink(path: string): Promise<void>; rmdir(path: string): Promise<void> }
  const path = await import(pathName) as { join(...parts: string[]): string }
  const root = home.dshHomePath('translation-plugin', 'views', 'v1')
  const sessionPrefix = viewSessionStoragePrefix
  // Serialize with the profile-wide data clear; the writer generation must be current at call time.
  const gate = <T>(action: () => Promise<T>): Promise<T> => {
    const data = ctx.get?.('translationLocalData') as { storageWriter?: () => <U>(action: () => Promise<U>) => Promise<U> } | undefined
    const writer = typeof data?.storageWriter === 'function' ? data.storageWriter() : undefined
    return writer ? writer(action) : action()
  }
  return {
    async write(request, content) {
      return await gate(async () => {
        const format = request.format ?? 'html'
        const directory = `${await viewVersionStoragePrefix(request.namespaceId, request.sessionId, request.unitId, request.revisionId ?? null)}${request.kind}`
        const destination = path.join(root, directory, `${textStem(request.fileName ?? request.title)}.${format}`)
        if (format === 'md') content = await resolveMarkdownImages(content, request.originalFilePath, async (name, bytes) => {
          await atomic.writeFileAtomic(path.join(root, directory, name), bytes, { mode: 0o600, dirMode: 0o700 })
          return `./${name}`
        })
        await atomic.writeFileAtomic(destination, content, { mode: 0o600, dirMode: 0o700 })
        return destination
      })
    },
    async clear(sessionIds) {
      const prefixes = await Promise.all(sessionIds.map(sessionPrefix))
      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try { entries = await fs.readdir(root, { withFileTypes: true }) } catch (error) { if (absent(error)) return 0; throw error }
      let removed = 0
      for (const entry of entries) {
        const key = viewFileStorageName(entry.name)
        if (!prefixes.some(prefix => key.startsWith(prefix))) continue
        if (entry.isFile() && isViewFileStorageName(key)) {
          try { await fs.unlink(path.join(root, entry.name)); removed++ } catch (error) { if (!absent(error)) throw error }
        } else if (entry.isDirectory() && isViewFileStorageDirectory(entry.name)) {
          const directory = path.join(root, entry.name)
          for (const file of await fs.readdir(directory, { withFileTypes: true })) if (file.isFile() && isViewFileStorageName(`${entry.name}/${file.name}`)) {
            try { await fs.unlink(path.join(directory, file.name)); removed++ } catch (error) { if (!absent(error)) throw error }
          }
          try { await fs.rmdir(directory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as { code?: string }).code ?? '')) throw error }
        }
      }
      return removed
    },
  }
}

/** Host-owned temporary artifacts. These files do not prove that source/history storage was saved. */
export class ViewFilesService {
  readonly typertRemote: { readonly service: ViewFilesService; readonly serviceKey: 'translationViews'; readonly namespace: 'translationViews' }
  private storage: Promise<ViewFileStorage> | undefined
  private readonly writes = new Map<Promise<string>, { readonly namespaceId: string; readonly sessionId: string; readonly unitId: string; readonly revisionId: string | null }>()
  private readonly clearedSessions = new Set<string>()
  private readonly clearedUnits = new Set<string>()
  private readonly clearedVersions = new Set<string>()
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
  private cleared(namespaceId: string, sessionId: string, unitId?: string, revisionId?: string): boolean { return this.clearedSessions.has(JSON.stringify([namespaceId, sessionId])) || this.clearedUnits.has(JSON.stringify([namespaceId, sessionId, unitId])) || this.clearedVersions.has(JSON.stringify([namespaceId, sessionId, unitId, revisionId])) }
  invalidateHistoryResult(scope: { namespaceId: string; sessionId: string }, unitId: string, version: number): boolean {
    const revisionId = `result:${unitId}:${version}`
    return this.invalidateHistoryVersion(scope, unitId, revisionId)
  }
  invalidateHistoryVersion(scope: { namespaceId: string; sessionId: string }, unitId: string, revisionId: string): boolean {
    this.clearedVersions.add(JSON.stringify([scope.namespaceId, scope.sessionId, unitId, revisionId]))
    return ![...this.writes.values()].some(value => value.namespaceId === scope.namespaceId && value.sessionId === scope.sessionId && value.unitId === unitId && value.revisionId === revisionId)
  }
  invalidateHistoryUnit(scope: { namespaceId: string; sessionId: string }, unitId: string): boolean {
    this.clearedUnits.add(JSON.stringify([scope.namespaceId, scope.sessionId, unitId]))
    return ![...this.writes.values()].some(value => value.namespaceId === scope.namespaceId && value.sessionId === scope.sessionId && value.unitId === unitId)
  }
  invalidateHistorySession(scope: { namespaceId: string; sessionId: string }): boolean {
    this.clearedSessions.add(JSON.stringify([scope.namespaceId, scope.sessionId]))
    return ![...this.writes.values()].some(value => value.namespaceId === scope.namespaceId && value.sessionId === scope.sessionId)
  }
  async open(input: ViewFileOpen, signal: AbortSignal): Promise<ViewFileResult<{ readonly opened: true }>> {
    let request: ViewFileOpen
    try { request = parseViewFileRequest('open', input) as ViewFileOpen } catch { return bad('invalid_input', '打开文件参数无效或正文超过 16 MiB。') }
    if (!this.owns(request.namespaceId)) return bad('scope_mismatch', '打开文件不属于此主会话连接。')
    const history = this.ctx.get?.('translationHistory') as { isUnitDeleted(namespaceId: string, sessionId: string, unitId: string): Promise<boolean>; isFileResultDeleted?(namespaceId: string, sessionId: string, unitId: string, version: number): Promise<boolean>; isFileSourceDeleted?(namespaceId: string, sessionId: string, unitId: string, version: number): Promise<boolean>; isDocumentViewDeleted?(namespaceId: string, sessionId: string, unitId: string, revisionId: string): Promise<boolean> } | undefined
    if (request.revisionId && await history?.isDocumentViewDeleted?.(request.namespaceId, request.sessionId, request.unitId, request.revisionId)) return bad('scope_mismatch', '此文档版本已删除。')
    const prefix = `result:${request.unitId}:`, version = request.revisionId?.startsWith(prefix) ? Number(request.revisionId.slice(prefix.length)) : undefined
    const sourcePrefix = `source:${request.unitId}:`, sourceVersion = request.revisionId?.startsWith(sourcePrefix) ? Number(request.revisionId.slice(sourcePrefix.length)) : undefined
    if (sourceVersion !== undefined && Number.isSafeInteger(sourceVersion) && await history?.isFileSourceDeleted?.(request.namespaceId, request.sessionId, request.unitId, sourceVersion)) return bad('scope_mismatch', '此文件原稿已删除。')
    if (this.cleared(request.namespaceId, request.sessionId, request.unitId, request.revisionId) || await history?.isUnitDeleted(request.namespaceId, request.sessionId, request.unitId) || version !== undefined && Number.isSafeInteger(version) && await history?.isFileResultDeleted?.(request.namespaceId, request.sessionId, request.unitId, version)) return bad('scope_mismatch', '此单元或版本的打开文件已经清理。')
    const controller = this.ctx.get?.('sessionController') as Controller | undefined
    if (typeof controller?.canOpenWorkspacePath !== 'function' || !controller.canOpenWorkspacePath() || typeof controller.openWorkspacePath !== 'function') return bad('unavailable', '当前宿主不支持打开本地文件。')
    signal.throwIfAborted()
    let destination: string
    const writing = (async () => (await this.disk()).write(request, request.format === 'txt' || request.format === 'md'
      ? request.text : renderViewPage(request.title, request.text)))()
    this.writes.set(writing, { namespaceId: request.namespaceId, sessionId: request.sessionId, unitId: request.unitId, revisionId: request.revisionId ?? null })
    try { destination = await writing }
    catch (error) {
      signal.throwIfAborted()
      return (error as { code?: string } | undefined)?.code === 'local_data_blocked' ? bad('local_data_stale', '本地数据已清理，打开文件已停止写入。') : bad('storage_failed', '打开文件写入失败，请重试。')
    } finally { this.writes.delete(writing) }
    signal.throwIfAborted()
    if (!this.owns(request.namespaceId) || this.cleared(request.namespaceId, request.sessionId, request.unitId, request.revisionId)) return bad('scope_mismatch', '打开文件时所属连接或会话已失效。')
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
