import type { LocalDataService } from './local-data.js'
import { parseSourceIdentity, parseTranslationSourceScope, type SourceIdentity, type TranslationSourceScope } from '../shared/translation-sources.js'
import { parseTranslationSourceReference, type TranslationSourceReference } from '../shared/translation-source-storage.js'
import type { QuickHostContext } from './quick-translation.js'

export interface StoredSourceOperation {
  readonly method: 'confirmReference' | 'releaseReference'
  readonly operationId: string
  readonly signature: string
  readonly result: TranslationSourceReference
}
export interface StoredSourceReference {
  readonly schemaVersion: 1
  readonly reference: TranslationSourceReference
  readonly prepareOperationId: string
  readonly prepareSignature: string
  readonly operations: readonly StoredSourceOperation[]
}
export interface TranslationSourceStorage {
  readReference(scope: TranslationSourceScope, referenceKey: string): Promise<StoredSourceReference | undefined>
  writeReference(record: StoredSourceReference): Promise<void>
  readContent(source: SourceIdentity): Promise<Uint8Array | undefined>
  writeContent(source: SourceIdentity, bytes: Uint8Array): Promise<void>
  originalPath(source: SourceIdentity): string
}
export interface TranslationSourceHostOptions {
  readonly storage?: TranslationSourceStorage
  readonly loadStorage?: () => Promise<TranslationSourceStorage>
}
function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || fields.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !fields.includes(key))) throw new TypeError('Invalid stored source reference')
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
export function parseStoredSourceReference(value: unknown): StoredSourceReference {
  exact(value, ['schemaVersion', 'reference', 'prepareOperationId', 'prepareSignature', 'operations'])
  const reference = parseTranslationSourceReference(value.reference)
  if (value.schemaVersion !== 1 || typeof value.prepareOperationId !== 'string' || !value.prepareOperationId.trim() ||
    typeof value.prepareSignature !== 'string' || !Array.isArray(value.operations)) throw new TypeError('Invalid stored source transaction')
  const prepareSignature = JSON.stringify({ scope: reference.scope, sourceRef: { ...reference.source, persistence: 'runtime_only' }, referenceKey: reference.referenceKey, operationId: value.prepareOperationId })
  if (value.prepareSignature !== prepareSignature) throw new TypeError('Stored source prepare signature mismatch')
  const ids = new Set<string>([value.prepareOperationId])
  const operations = value.operations.map(item => {
    exact(item, ['method', 'operationId', 'signature', 'result'])
    const result = parseTranslationSourceReference(item.result)
    if ((item.method !== 'confirmReference' && item.method !== 'releaseReference') || typeof item.operationId !== 'string' ||
      !item.operationId.trim() || ids.has(item.operationId) || typeof item.signature !== 'string' ||
      !same(result.scope, reference.scope) || !same(result.source, reference.source) || result.referenceKey !== reference.referenceKey ||
      result.prepareToken !== reference.prepareToken || (item.method === 'confirmReference' ? result.state !== 'confirmed' : result.state !== 'released')) throw new TypeError('Invalid stored source operation')
    const signature = item.method === 'confirmReference' ? JSON.stringify({ scope: reference.scope, referenceKey: reference.referenceKey,
      prepareToken: reference.prepareToken, historyToken: result.historyToken, operationId: item.operationId })
      : JSON.stringify({ scope: reference.scope, referenceKey: reference.referenceKey, expectedVersion: 1, operationId: item.operationId })
    if (item.signature !== signature) throw new TypeError('Stored source operation signature mismatch')
    ids.add(item.operationId)
    return { method: item.method, operationId: item.operationId, signature, result } as StoredSourceOperation
  })
  // A mapping cannot acquire a confirmed/released state without its matching transaction facts.
  let state: TranslationSourceReference = { ...reference, state: 'prepared', referenceVersion: 1, historyToken: null }
  for (const operation of operations) {
    if (state.state === 'released' || operation.method === 'confirmReference' && state.state === 'confirmed' && state.historyToken !== operation.result.historyToken) throw new TypeError('Invalid stored source transaction order')
    state = operation.result
  }
  if (!same(state, reference)) throw new TypeError('Stored source state mismatch')
  return { schemaVersion: 1, reference, prepareOperationId: value.prepareOperationId, prepareSignature: value.prepareSignature, operations }
}
export async function sourceSha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
/** Private plugin byte copies and independent scoped mappings. No attachment paths, TTL or GC. */
export async function loadTranslationSourceStorage(ctx: QuickHostContext): Promise<TranslationSourceStorage> {
  const loader = ctx.get?.('loader') as QuickHostContext['loader']
  if (!ctx.baseUrl || !loader?.internal) throw new Error('Host package loader unavailable')
  const [home, atomic] = await Promise.all([
    loader.internal.import('@deepseek-ai/dsh-home-paths', ctx.baseUrl, {}) as Promise<{ dshHomePath(...parts: string[]): string }>,
    loader.internal.import('@deepseek-ai/dsh-atomic-write', ctx.baseUrl, {}) as Promise<{ writeFileAtomic(path: string, content: string | Uint8Array, options: { mode: number; dirMode: number }): Promise<void> }>,
  ])
  const fsName = 'node:fs/promises', pathName = 'node:path'
  const fs = await import(fsName) as { readFile(path: string): Promise<Uint8Array>; readFile(path: string, encoding: 'utf8'): Promise<string> }
  const path = await import(pathName) as { join(...parts: string[]): string }
  const root = home.dshHomePath('translation-plugin', 'sources', 'v1')
  const contentPath = (source: SourceIdentity): string => path.join(root, 'content', `${parseSourceIdentity(source).sha256}.txt`)
  const mappingPath = async (scope: TranslationSourceScope, referenceKey: string): Promise<string> => {
    parseTranslationSourceScope(scope)
    return path.join(root, 'references', `${await sourceSha256(new TextEncoder().encode(JSON.stringify([scope, referenceKey])))}.json`)
  }
  const absent = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
  const write = (ctx.get?.('translationLocalData') as LocalDataService | undefined)?.storageWriter() ?? (async <T>(action: () => Promise<T>): Promise<T> => action())
  return {
    async readReference(scope, referenceKey) {
      let text: string
      try { text = await fs.readFile(await mappingPath(scope, referenceKey), 'utf8') } catch (error) { if (absent(error)) return undefined; throw error }
      const record = parseStoredSourceReference(JSON.parse(text))
      if (!same(record.reference.scope, scope) || record.reference.referenceKey !== referenceKey) throw new TypeError('Stored source mapping identity mismatch')
      return record
    },
    async writeReference(input) {
      const record = parseStoredSourceReference(input)
      const destination = await mappingPath(record.reference.scope, record.reference.referenceKey)
      await write(() => atomic.writeFileAtomic(destination, JSON.stringify(record), { mode: 0o600, dirMode: 0o700 }))
    },
    async readContent(source) {
      try { return new Uint8Array(await fs.readFile(contentPath(source))) } catch (error) { if (absent(error)) return undefined; throw error }
    },
    async writeContent(source, bytes) {
      if (bytes.byteLength !== source.bytes || await sourceSha256(bytes) !== source.sha256) throw new TypeError('Source content mismatch')
      let prior: Uint8Array | undefined
      try { prior = await fs.readFile(contentPath(source)) } catch (error) { if (!absent(error)) throw error }
      if (prior) {
        if (prior.byteLength !== source.bytes || await sourceSha256(prior) !== source.sha256) throw new TypeError('Saved source content corrupt')
        return
      }
      await write(() => atomic.writeFileAtomic(contentPath(source), bytes, { mode: 0o600, dirMode: 0o700 }))
    },
    originalPath: contentPath,
  }
}
