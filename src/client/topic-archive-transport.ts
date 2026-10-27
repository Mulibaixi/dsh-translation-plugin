import { decodeTopicArchiveSnapshot, type TopicArchiveSnapshot } from '../memory/topic-archive.js'
import { ARCHIVE_TRANSFER_POINTS, type ArchiveRemotePort, type ArchiveRemoteScope, type ArchiveStorageStatus } from '../shared/topic-archive-remote.js'

export type TopicArchiveRemotePort = { [K in keyof ArchiveRemotePort]: (...args: Parameters<ArchiveRemotePort[K]>) => Promise<unknown> }
export function archiveReply<T>(reply: unknown): T {
  const result = reply as { readonly ok?: boolean; readonly value?: T; readonly error?: { readonly code?: string; readonly message?: string } } | null
  if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message ?? '主题档案服务未返回有效回执。'), { code: result?.error?.code ?? 'archive_unavailable' })
  return result.value as T
}
export function archiveScopeMatches(snapshot: TopicArchiveSnapshot, scope: ArchiveRemoteScope): boolean { return snapshot.ownerId === scope.ownerId && snapshot.topicId === scope.topicId }

/** JSON transfers are bounded on the wire; only Host stores complete authoritative snapshots. */
export async function readArchiveSnapshot(remote: TopicArchiveRemotePort, scope: ArchiveRemoteScope, status: ArchiveStorageStatus,
  layer: 'current' | 'saved', current: () => boolean): Promise<TopicArchiveSnapshot | null> {
  const head = status[layer]
  if (!head) return null
  if (!status.switched || !status.token) throw new Error('主题档案尚未完成存储切换。')
  const parts: string[] = []
  let offset = 0
  while (true) {
    if (!current()) throw new Error('主题档案范围或连接已变化。')
    const page = archiveReply<{ readonly text: string; readonly nextOffset: number | null }>(await remote.read({ ...scope, token: status.token, layer, offset }))
    if (!current()) throw new Error('主题档案范围或连接已变化。')
    if (typeof page.text !== 'string') throw new Error('主题档案分段回执不可读。')
    const count = Array.from(page.text).length
    if (count > ARCHIVE_TRANSFER_POINTS || page.nextOffset !== null && (!count || page.nextOffset !== offset + count)) throw new Error('主题档案分段位置不匹配。')
    parts.push(page.text)
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  let snapshot: TopicArchiveSnapshot | undefined
  try { snapshot = decodeTopicArchiveSnapshot(JSON.parse(parts.join(''))) } catch { throw new Error('主题档案正文格式不可读。') }
  if (!snapshot || !archiveScopeMatches(snapshot, scope) || snapshot.version !== head.version || snapshot.activeVersion !== head.activeVersion || snapshot.entries.length !== head.count) throw new Error('主题档案正文与读取版本不匹配。')
  return snapshot
}

export async function transferArchiveMigration(remote: TopicArchiveRemotePort, scope: ArchiveRemoteScope,
  snapshot: TopicArchiveSnapshot, saved: TopicArchiveSnapshot | null, current: () => boolean): Promise<ArchiveStorageStatus> {
  const layers = { current: Array.from(JSON.stringify(snapshot)), saved: saved ? Array.from(JSON.stringify(saved)) : null }
  const started = archiveReply<{ readonly transferId: string }>(await remote.migrateBegin({ ...scope, currentPoints: layers.current.length, storedPoints: layers.saved?.length ?? null }))
  let committed = false
  try {
    for (const layer of ['current', 'saved'] as const) {
      const points = layers[layer]
      if (!points) continue
      for (let offset = 0; offset < points.length; offset += ARCHIVE_TRANSFER_POINTS) {
        if (!current()) throw new Error('主题档案迁移范围或连接已变化。')
        const text = points.slice(offset, offset + ARCHIVE_TRANSFER_POINTS).join('')
        const receipt = archiveReply<{ readonly nextOffset: number }>(await remote.migratePart({ ...scope, transferId: started.transferId, layer, offset, text }))
        if (receipt.nextOffset !== offset + Array.from(text).length) throw new Error('主题档案迁移分段未确认。')
      }
    }
    if (!current()) throw new Error('主题档案迁移范围或连接已变化。')
    const result = archiveReply<ArchiveStorageStatus>(await remote.migrateCommit({ ...scope, transferId: started.transferId }))
    committed = true
    return result
  } finally {
    if (!committed) { try { await remote.migrateCancel({ ...scope, transferId: started.transferId }) } catch { /* A failed transfer is never a readable archive. */ } }
  }
}
