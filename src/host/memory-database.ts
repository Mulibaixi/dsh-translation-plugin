import type { HistoryCleanup } from '../shared/history-cleanup.js'
import { historySessionMetadata } from '../shared/history-patch.js'
import type { LocalSession } from '../shared/sessions.js'
import { parseOtherMemoryEntry, type OtherMemoryEntry } from '../shared/other-memory.js'
import type { TopicHostContext } from './topic-tools.js'
import { decodeTopicArchiveSnapshot, type TopicArchiveSnapshot } from '../memory/topic-archive.js'
import { decodeTopicTermSnapshot, type TopicTermSnapshot } from '../memory/topic-terms.js'
import { splitHistoryBundle, joinHistoryBundle, type HistoryBundle, type HistoryPart } from '../shared/history-bundle.js'

interface Statement { all(...args: unknown[]): readonly Record<string, unknown>[]; get(...args: unknown[]): Record<string, unknown> | undefined; run(...args: unknown[]): unknown }
interface SqliteConnection { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
export interface MemoryVectorRow { readonly topicId: string; readonly sourceId: string; readonly hash: string; readonly start: number; readonly end: number; readonly vector: readonly number[] }
export interface MemoryDatabase {
  all(namespaceId?: string): readonly OtherMemoryEntry[]
  entry(id: string): OtherMemoryEntry | undefined
  retired(namespaceId: string, topicId: string): boolean
  transaction<T>(action: () => T): T
  save(entry: OtherMemoryEntry): void
  remove(id: string): void
  retire(namespaceId: string, topicId: string): void
  archiveState(namespaceId: string, topicId: string): { readonly ownerId: string; readonly snapshot: TopicArchiveSnapshot | null } | undefined
  archiveSave(namespaceId: string, ownerId: string, topicId: string, snapshot: TopicArchiveSnapshot | null): void
  archiveRemove(namespaceId: string, topicId: string): void
  archiveScopes(namespaceId: string): readonly { readonly topicId: string; readonly ownerId: string }[]
  indexNamespaces(): readonly string[]
  indexEnable(namespaceId: string): void
  indexRows(namespaceId: string, config: string): readonly MemoryVectorRow[]
  indexPut(namespaceId: string, config: string, row: MemoryVectorRow): void
  indexClear(namespaceId: string, topicId?: string): void
  indexRemoveSource(namespaceId: string, topicId: string, sourceId: string): void
  indexPrune(namespaceId: string, config: string, rows: readonly Omit<MemoryVectorRow, 'vector'>[]): void
  termsState(namespaceId: string, topicId: string): { readonly ownerId: string; readonly snapshot: TopicTermSnapshot | null } | undefined
  termsSave(namespaceId: string, ownerId: string, topicId: string, snapshot: TopicTermSnapshot | null): void
  termsRemove(namespaceId: string, topicId: string): void
  historyState(namespaceId: string, sessionId: string): { readonly topicId: string; readonly token: string; readonly bundle: HistoryBundle | null } | undefined
  historySave(namespaceId: string, topicId: string, sessionId: string, token: string, bundle: HistoryBundle | null): void
  historySessions(namespaceId: string, topicId: string): readonly string[]
  historyScopes(namespaceId: string): readonly { readonly sessionId: string; readonly topicId: string; readonly token: string; readonly retired: boolean; readonly session?: LocalSession }[]
  historyAllScopes(): readonly { readonly namespaceId: string; readonly sessionId: string; readonly topicId: string }[]
  historyCleanups(): readonly HistoryCleanup[]
  historyCleanupSave(task: HistoryCleanup): void
  historyCleanupRemove(namespaceId: string, sessionId: string, unitId: string): void
  close(): void
}
function unavailable(message: string): Error { return Object.assign(new Error(message), { code: 'other_memory_storage_unavailable' }) }
function row(value: Record<string, unknown>): OtherMemoryEntry {
  if (typeof value.payload !== 'string') throw unavailable('其他记忆数据库记录损坏，原副本已保留。')
  const entry = parseOtherMemoryEntry(JSON.parse(value.payload))
  if (entry.persistence !== 'saved' || entry.id !== value.id || entry.namespaceId !== value.namespace_id || entry.topicId !== value.topic_id || entry.kind !== value.kind)
    throw unavailable('其他记忆数据库身份不一致，原副本已保留。')
  return entry
}
/** One business database. Opening an absent store for a runtime-only read never creates it. */
export async function loadMemoryDatabase(ctx: TopicHostContext, create: boolean): Promise<MemoryDatabase | undefined> {
  const loader = ctx.get?.('loader') as { internal?: { import(name: string, anchor: string, options: object): Promise<unknown> } } | undefined
  if (!ctx.baseUrl || !loader?.internal) throw unavailable('宿主其他记忆存储尚未就绪。')
  const home = await loader.internal.import('@deepseek-ai/dsh-home-paths', ctx.baseUrl, {}) as { dshHomePath(...parts: string[]): string }
  const fsName = 'node:fs/promises', pathName = 'node:path'
  const fs = await import(fsName) as { stat(path: string): Promise<unknown>; mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown> }
  const path = await import(pathName) as { join(...parts: string[]): string }
  const root = home.dshHomePath('translation-plugin', 'memory', 'v1'), file = path.join(root, 'assets.sqlite')
  let exists = true
  try { await fs.stat(file) } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; exists = false }
  if (!exists && !create) return undefined
  const sqlite = await loader.internal.import('node:sqlite', ctx.baseUrl, {}) as { DatabaseSync?: new (file: string) => SqliteConnection }
  if (typeof sqlite.DatabaseSync !== 'function') throw unavailable('当前宿主未提供所需的 node:sqlite 能力。')
  if (!exists) await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const db = new sqlite.DatabaseSync(file)
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (!exists) db.exec('BEGIN IMMEDIATE; CREATE TABLE other_memory (id TEXT PRIMARY KEY, namespace_id TEXT NOT NULL, topic_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX other_memory_scope ON other_memory(namespace_id, topic_id); CREATE TABLE retired_topics (namespace_id TEXT NOT NULL, topic_id TEXT NOT NULL, PRIMARY KEY(namespace_id, topic_id)); PRAGMA user_version = 1; COMMIT;')
    if (!exists || version === 1) db.exec('BEGIN IMMEDIATE; CREATE TABLE archive_topics (namespace_id TEXT NOT NULL, topic_id TEXT NOT NULL, owner_id TEXT NOT NULL, header TEXT, PRIMARY KEY(namespace_id, topic_id)); CREATE TABLE archive_entries (namespace_id TEXT NOT NULL, topic_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace_id, topic_id, id)); PRAGMA user_version = 2; COMMIT;')
    if (!exists || version === 1 || version === 2) db.exec('BEGIN IMMEDIATE; CREATE TABLE term_topics (namespace_id TEXT NOT NULL, topic_id TEXT NOT NULL, owner_id TEXT NOT NULL, header TEXT, PRIMARY KEY(namespace_id, topic_id)); CREATE TABLE term_entries (namespace_id TEXT NOT NULL, topic_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace_id, topic_id, id)); PRAGMA user_version = 3; COMMIT;')
    if (!exists || version === 1 || version === 2 || version === 3) db.exec('BEGIN IMMEDIATE; CREATE TABLE memory_index_enabled (namespace_id TEXT PRIMARY KEY); CREATE TABLE memory_vectors (namespace_id TEXT NOT NULL, config TEXT NOT NULL, topic_id TEXT NOT NULL, source_id TEXT NOT NULL, hash TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(namespace_id, config, topic_id, source_id, hash, start, end)); PRAGMA user_version = 4; COMMIT;')
    if (!exists || version === 1 || version === 2 || version === 3 || version === 4) db.exec('BEGIN IMMEDIATE; CREATE TABLE history_sessions (namespace_id TEXT NOT NULL, session_id TEXT NOT NULL, topic_id TEXT NOT NULL, token TEXT NOT NULL, header TEXT, PRIMARY KEY(namespace_id, session_id)); CREATE INDEX history_topic ON history_sessions(namespace_id, topic_id); CREATE TABLE history_parts (namespace_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, parent TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace_id, session_id, kind, parent, id)); PRAGMA user_version = 5; COMMIT;')
    if (!exists || typeof version === 'number' && version >= 1 && version <= 5) db.exec('BEGIN IMMEDIATE; CREATE TABLE history_cleanup (namespace_id TEXT NOT NULL, session_id TEXT NOT NULL, unit_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace_id, session_id, unit_id)); PRAGMA user_version = 6; COMMIT;')
    else if (version !== 6) throw unavailable('其他记忆数据库格式不受当前版本支持，原副本已保留。')
  } catch (error) { try { db.close() } catch { /* Preserve the original failure. */ } throw error }
  return {
    all(namespaceId) { return (namespaceId === undefined ? db.prepare('SELECT * FROM other_memory').all() : db.prepare('SELECT * FROM other_memory WHERE namespace_id = ?').all(namespaceId)).map(row) },
    entry(id) { const value = db.prepare('SELECT * FROM other_memory WHERE id = ?').get(id); return value ? row(value) : undefined },
    retired(namespaceId, topicId) { return !!db.prepare('SELECT 1 FROM retired_topics WHERE namespace_id = ? AND topic_id = ?').get(namespaceId, topicId) },
    transaction(action) { db.exec('BEGIN IMMEDIATE'); try { const result = action(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } },
    save(entry) { const saved = parseOtherMemoryEntry(entry); if (saved.persistence !== 'saved') throw new TypeError('Cannot persist a runtime memory row'); db.prepare('INSERT INTO other_memory (id, namespace_id, topic_id, kind, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET namespace_id = excluded.namespace_id, topic_id = excluded.topic_id, kind = excluded.kind, payload = excluded.payload').run(saved.id, saved.namespaceId, saved.topicId, saved.kind, JSON.stringify(saved)) },
    remove(id) { db.prepare('DELETE FROM other_memory WHERE id = ?').run(id) },
    retire(namespaceId, topicId) { db.prepare('INSERT OR IGNORE INTO retired_topics VALUES (?, ?)').run(namespaceId, topicId) },
    archiveState(namespaceId, topicId) {
      const head = db.prepare('SELECT owner_id, header FROM archive_topics WHERE namespace_id = ? AND topic_id = ?').get(namespaceId, topicId)
      if (!head) return undefined
      if (typeof head.owner_id !== 'string') throw unavailable('主题档案存储身份无效，原副本已保留。')
      if (head.header === null) return { ownerId: head.owner_id, snapshot: null }
      const entries = db.prepare('SELECT payload FROM archive_entries WHERE namespace_id = ? AND topic_id = ? ORDER BY position').all(namespaceId, topicId).map(item => JSON.parse(String(item.payload)))
      const snapshot = decodeTopicArchiveSnapshot({ ...JSON.parse(String(head.header)), entries })
      if (!snapshot || snapshot.ownerId !== head.owner_id || snapshot.topicId !== topicId) throw unavailable('主题档案记录无效，原副本已保留。')
      return { ownerId: head.owner_id, snapshot }
    },
    archiveSave(namespaceId, ownerId, topicId, snapshot) {
      if (snapshot && (!decodeTopicArchiveSnapshot(snapshot) || snapshot.ownerId !== ownerId || snapshot.topicId !== topicId)) throw new TypeError('Invalid archive storage scope')
      const { entries = [], ...header } = snapshot ?? {}
      db.prepare('INSERT INTO archive_topics VALUES (?, ?, ?, ?) ON CONFLICT(namespace_id, topic_id) DO UPDATE SET owner_id = excluded.owner_id, header = excluded.header').run(namespaceId, topicId, ownerId, snapshot ? JSON.stringify(header) : null)
      const existing = db.prepare('SELECT id, position, payload FROM archive_entries WHERE namespace_id = ? AND topic_id = ?').all(namespaceId, topicId)
      const wanted = new Set(entries.map(entry => entry.id))
      for (const item of existing) if (!wanted.has(String(item.id))) db.prepare('DELETE FROM archive_entries WHERE namespace_id = ? AND topic_id = ? AND id = ?').run(namespaceId, topicId, item.id)
      entries.forEach((entry, position) => {
        const payload = JSON.stringify(entry), old = existing.find(item => item.id === entry.id)
        if (old?.payload !== payload || old.position !== position) db.prepare('INSERT INTO archive_entries VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace_id, topic_id, id) DO UPDATE SET position = excluded.position, payload = excluded.payload').run(namespaceId, topicId, entry.id, position, payload)
      })
    },
    archiveRemove(namespaceId, topicId) { db.prepare('DELETE FROM archive_entries WHERE namespace_id = ? AND topic_id = ?').run(namespaceId, topicId); db.prepare('DELETE FROM archive_topics WHERE namespace_id = ? AND topic_id = ?').run(namespaceId, topicId) },
    archiveScopes(namespaceId) { return db.prepare('SELECT topic_id, owner_id FROM archive_topics WHERE namespace_id = ?').all(namespaceId).map(row => ({ topicId: String(row.topic_id), ownerId: String(row.owner_id) })) },
    indexNamespaces() { return db.prepare('SELECT namespace_id FROM memory_index_enabled').all().map(row => String(row.namespace_id)) },
    indexEnable(namespaceId) { db.prepare('INSERT OR IGNORE INTO memory_index_enabled VALUES (?)').run(namespaceId) },
    indexRows(namespaceId, config) { return db.prepare('SELECT * FROM memory_vectors WHERE namespace_id = ? AND config = ?').all(namespaceId, config).map(row => ({ topicId: String(row.topic_id), sourceId: String(row.source_id), hash: String(row.hash), start: Number(row.start), end: Number(row.end), vector: JSON.parse(String(row.vector)) as number[] })) },
    indexPut(namespaceId, config, row) { db.prepare('INSERT OR REPLACE INTO memory_vectors VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(namespaceId, config, row.topicId, row.sourceId, row.hash, row.start, row.end, JSON.stringify(row.vector)) },
    indexClear(namespaceId, topicId) { if (topicId === undefined) db.prepare('DELETE FROM memory_vectors WHERE namespace_id = ?').run(namespaceId); else db.prepare('DELETE FROM memory_vectors WHERE namespace_id = ? AND topic_id = ?').run(namespaceId, topicId) },
    indexRemoveSource(namespaceId, topicId, sourceId) { db.prepare('DELETE FROM memory_vectors WHERE namespace_id = ? AND topic_id = ? AND source_id = ?').run(namespaceId, topicId, sourceId) },
    indexPrune(namespaceId, config, wanted) {
      const keys = new Set(wanted.map(row => JSON.stringify([row.topicId, row.sourceId, row.hash, row.start, row.end])))
      for (const row of db.prepare('SELECT config, topic_id, source_id, hash, start, end FROM memory_vectors WHERE namespace_id = ?').all(namespaceId))
        if (row.config !== config || !keys.has(JSON.stringify([row.topic_id, row.source_id, row.hash, row.start, row.end])))
          db.prepare('DELETE FROM memory_vectors WHERE namespace_id = ? AND config = ? AND topic_id = ? AND source_id = ? AND hash = ? AND start = ? AND end = ?').run(namespaceId, row.config, row.topic_id, row.source_id, row.hash, row.start, row.end)
    },
    termsState(namespaceId, topicId) {
      const head = db.prepare('SELECT owner_id, header FROM term_topics WHERE namespace_id = ? AND topic_id = ?').get(namespaceId, topicId)
      if (!head) return undefined
      if (typeof head.owner_id !== 'string') throw unavailable('主题术语存储身份无效，原副本已保留。')
      if (head.header === null) return { ownerId: head.owner_id, snapshot: null }
      const entries = db.prepare('SELECT payload FROM term_entries WHERE namespace_id = ? AND topic_id = ? ORDER BY position').all(namespaceId, topicId).map(item => JSON.parse(String(item.payload)))
      const snapshot = decodeTopicTermSnapshot({ ...JSON.parse(String(head.header)), entries })
      if (!snapshot || snapshot.ownerId !== head.owner_id || snapshot.topicId !== topicId) throw unavailable('主题术语记录无效，原副本已保留。')
      return { ownerId: head.owner_id, snapshot }
    },
    termsSave(namespaceId, ownerId, topicId, snapshot) {
      if (snapshot && (!decodeTopicTermSnapshot(snapshot) || snapshot.ownerId !== ownerId || snapshot.topicId !== topicId)) throw new TypeError('Invalid term storage scope')
      const { entries = [], ...header } = snapshot ?? {}
      db.prepare('INSERT INTO term_topics VALUES (?, ?, ?, ?) ON CONFLICT(namespace_id, topic_id) DO UPDATE SET owner_id = excluded.owner_id, header = excluded.header').run(namespaceId, topicId, ownerId, snapshot ? JSON.stringify(header) : null)
      const existing = db.prepare('SELECT id, position, payload FROM term_entries WHERE namespace_id = ? AND topic_id = ?').all(namespaceId, topicId)
      const wanted = new Set(entries.map(entry => entry.id))
      for (const item of existing) if (!wanted.has(String(item.id))) db.prepare('DELETE FROM term_entries WHERE namespace_id = ? AND topic_id = ? AND id = ?').run(namespaceId, topicId, item.id)
      entries.forEach((entry, position) => {
        const payload = JSON.stringify(entry), old = existing.find(item => item.id === entry.id)
        if (old?.payload !== payload || old.position !== position) db.prepare('INSERT INTO term_entries VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace_id, topic_id, id) DO UPDATE SET position = excluded.position, payload = excluded.payload').run(namespaceId, topicId, entry.id, position, payload)
      })
    },
    termsRemove(namespaceId, topicId) { db.prepare('DELETE FROM term_entries WHERE namespace_id = ? AND topic_id = ?').run(namespaceId, topicId); db.prepare('DELETE FROM term_topics WHERE namespace_id = ? AND topic_id = ?').run(namespaceId, topicId) },
    historyState(namespaceId, sessionId) {
      const row = db.prepare('SELECT * FROM history_sessions WHERE namespace_id = ? AND session_id = ?').get(namespaceId, sessionId)
      if (!row) return undefined
      if (typeof row.topic_id !== 'string' || typeof row.token !== 'string') throw unavailable('会话历史身份记录无效。')
      const parts = db.prepare('SELECT * FROM history_parts WHERE namespace_id = ? AND session_id = ?').all(namespaceId, sessionId).map(part => ({ kind: String(part.kind), parent: String(part.parent), id: String(part.id), position: Number(part.position), payload: String(part.payload) }))
      try { return { topicId: row.topic_id, token: row.token, bundle: row.header === null ? null : joinHistoryBundle(String(row.header), parts, { namespaceId, sessionId, topicId: row.topic_id }) } }
      catch { throw unavailable('会话历史数据库正文或所属关系无效，原副本已保留。') }
    },
    historySave(namespaceId, topicId, sessionId, token, bundle) {
      const split = bundle ? splitHistoryBundle(bundle) : { header: null, parts: [] }
      db.prepare('INSERT INTO history_sessions VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace_id, session_id) DO UPDATE SET topic_id = excluded.topic_id, token = excluded.token, header = excluded.header').run(namespaceId, sessionId, topicId, token, split.header)
      const id = (part: Pick<HistoryPart, 'kind' | 'parent' | 'id'>): string => JSON.stringify([part.kind, part.parent, part.id])
      const existing = db.prepare('SELECT * FROM history_parts WHERE namespace_id = ? AND session_id = ?').all(namespaceId, sessionId), wanted = new Set(split.parts.map(id))
      const before = new Map(existing.map(part => [id({ kind: String(part.kind), parent: String(part.parent), id: String(part.id) }), part]))
      for (const part of existing) if (!wanted.has(id({ kind: String(part.kind), parent: String(part.parent), id: String(part.id) }))) db.prepare('DELETE FROM history_parts WHERE namespace_id = ? AND session_id = ? AND kind = ? AND parent = ? AND id = ?').run(namespaceId, sessionId, part.kind, part.parent, part.id)
      for (const part of split.parts) { const old = before.get(id(part)); if (old?.payload !== part.payload || old.position !== part.position)
        db.prepare('INSERT OR REPLACE INTO history_parts VALUES (?, ?, ?, ?, ?, ?, ?)').run(namespaceId, sessionId, part.kind, part.parent, part.id, part.position, part.payload) }
    },
    historySessions(namespaceId, topicId) { return db.prepare('SELECT session_id FROM history_sessions WHERE namespace_id = ? AND topic_id = ?').all(namespaceId, topicId).map(row => String(row.session_id)) },
    historyScopes(namespaceId) { return db.prepare('SELECT session_id, topic_id, token, header FROM history_sessions WHERE namespace_id = ?').all(namespaceId).map(row => ({ sessionId: String(row.session_id), topicId: String(row.topic_id), token: String(row.token), retired: row.header === null, ...(row.header === null ? {} : { session: historySessionMetadata(JSON.parse(String(row.header)).session) }) })) },
    historyAllScopes() { return db.prepare('SELECT namespace_id, session_id, topic_id FROM history_sessions WHERE header IS NOT NULL').all().map(row => ({ namespaceId: String(row.namespace_id), sessionId: String(row.session_id), topicId: String(row.topic_id) })) },
    historyCleanups() { return db.prepare('SELECT payload FROM history_cleanup').all().map(row => JSON.parse(String(row.payload)) as HistoryCleanup) },
    historyCleanupSave(task) { db.prepare('INSERT OR REPLACE INTO history_cleanup VALUES (?, ?, ?, ?)').run(task.scope.namespaceId, task.scope.sessionId, task.unitId, JSON.stringify(task)) },
    historyCleanupRemove(namespaceId, sessionId, unitId) { db.prepare('DELETE FROM history_cleanup WHERE namespace_id = ? AND session_id = ? AND unit_id = ?').run(namespaceId, sessionId, unitId) },
    close() { db.close() },
  }
}
