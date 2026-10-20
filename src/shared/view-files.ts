/** Browser-safe identities for Host-owned opening artifacts. Paths stay on Host. */
export type ViewFileKind = 'source' | 'result'
export type ViewFileFormat = 'html' | 'txt'
export const MAX_VIEW_FILE_BYTES = 16 * 1024 * 1024
export interface ViewFileOpen {
  readonly namespaceId: string
  readonly sessionId: string
  readonly unitId: string
  readonly kind: ViewFileKind
  /** Human-readable page title; rendered into the Host page, never used as a file name. */
  readonly title: string
  readonly text: string
  /** Fixed source/manifest identity; independent revisions never share an opening artifact. */
  readonly revisionId?: string
  /** Display-name hint only. The Host sanitizes it and derives the complete destination. */
  readonly fileName?: string
  /** Omission preserves the existing escaped HTML page behavior. */
  readonly format?: ViewFileFormat
}
export interface ViewFileClear {
  readonly namespaceId: string
  readonly sessionIds: readonly string[]
}
export type ViewFileErrorCode = 'invalid_input' | 'scope_mismatch' | 'unavailable' | 'storage_failed' | 'open_failed' | 'local_data_stale'
export type ViewFileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: ViewFileErrorCode; readonly message: string } }
export interface ViewFilePort {
  open(request: ViewFileOpen, signal: AbortSignal): Promise<ViewFileResult<{ readonly opened: true }>>
  clear(request: ViewFileClear, signal: AbortSignal): Promise<ViewFileResult<{ readonly removed: number }>>
}

type Data = Record<string, unknown>
export const VIEW_FILE_KINDS: readonly ViewFileKind[] = ['source', 'result']
function record(value: unknown): asserts value is Data { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected object') }
function exact(value: Data, fields: readonly string[]): void { if (Object.keys(value).some(key => !fields.includes(key))) throw new TypeError('Unexpected field') }
function text(value: unknown, limit = 2048): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f]/u.test(value)) throw new TypeError('Invalid text') }
function kind(value: unknown): asserts value is ViewFileKind { if (!VIEW_FILE_KINDS.includes(value as ViewFileKind)) throw new TypeError('Invalid view kind') }
export function parseViewFileRequest(method: 'open' | 'clear', value: unknown): ViewFileOpen | ViewFileClear {
  record(value); text(value.namespaceId)
  if (method === 'open') {
    exact(value, ['namespaceId', 'sessionId', 'unitId', 'kind', 'title', 'text', 'revisionId', 'fileName', 'format'])
    text(value.sessionId); text(value.unitId); kind(value.kind); text(value.title, 300)
    if (value.revisionId !== undefined) text(value.revisionId)
    if (value.fileName !== undefined) text(value.fileName, 255)
    if (value.format !== undefined && value.format !== 'txt' && value.format !== 'html') throw new TypeError('Invalid view format')
    // TXT is encoded exactly as supplied; HTML is escaped by the Host. Neither path normalizes newlines or BOM.
    if (typeof value.text !== 'string' || value.text.length > MAX_VIEW_FILE_BYTES || new TextEncoder().encode(value.text).byteLength > MAX_VIEW_FILE_BYTES) throw new TypeError('Invalid view text')
  } else {
    exact(value, ['namespaceId', 'sessionIds'])
    if (!Array.isArray(value.sessionIds) || value.sessionIds.length < 1 || value.sessionIds.length > 256) throw new TypeError('Invalid session list')
    for (const id of value.sessionIds) text(id)
  }
  return structuredClone(value) as unknown as ViewFileOpen | ViewFileClear
}
const methods = ['open', 'clear'] as const
export function parseViewFileResult(method: typeof methods[number], value: unknown): unknown {
  record(value)
  if (value.ok === false) {
    exact(value, ['ok', 'error']); record(value.error); exact(value.error, ['code', 'message']); text(value.error.message, 1000)
    if (!['invalid_input', 'scope_mismatch', 'unavailable', 'storage_failed', 'open_failed', 'local_data_stale'].includes(value.error.code as string)) throw new TypeError('Invalid error')
  } else {
    if (value.ok !== true) throw new TypeError('Invalid result')
    exact(value, ['ok', 'value']); record(value.value)
    if (method === 'open') { exact(value.value, ['opened']); if (value.value.opened !== true) throw new TypeError('Invalid opening') }
    else { exact(value.value, ['removed']); if (!Number.isSafeInteger(value.value.removed) || (value.value.removed as number) < 0) throw new TypeError('Invalid removal') }
  }
  return structuredClone(value)
}
export const VIEW_FILES_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: methods.map(method => ({
    id: `dsh-translation-plugin#translationViews/${method}`, service: 'translationViews', namespace: 'translationViews', method,
    invocation: { kind: 'direct' as const },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#view-${method}-request`, create: () => ({ parse: (value: unknown) => parseViewFileRequest(method, value) }) } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#view-${method}-result`, create: () => ({ parse: (value: unknown) => parseViewFileResult(method, value) }) },
  })),
}
