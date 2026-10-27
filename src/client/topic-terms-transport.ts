import { decodeTopicTermSnapshot, type TopicTermSnapshot } from '../memory/topic-terms.js'
import { TERM_TRANSFER_POINTS, type TermsRemotePort, type TermRemoteScope, type TermStorageStatus } from '../shared/topic-terms-remote.js'

export type TopicTermsRemotePort = { [K in keyof TermsRemotePort]: (...args: Parameters<TermsRemotePort[K]>) => Promise<unknown> }
export function termReply<T>(reply: unknown): T {
  const result = reply as { readonly ok?: boolean; readonly value?: T; readonly error?: { readonly code?: string; readonly message?: string } } | null
  if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message ?? '主题术语服务未返回有效回执。'), { code: result?.error?.code ?? 'terms_unavailable' })
  return result.value as T
}
export function termScopeMatches(snapshot: TopicTermSnapshot, scope: TermRemoteScope): boolean { return snapshot.ownerId === scope.ownerId && snapshot.topicId === scope.topicId }

/** JSON transfers are bounded on the wire; only Host stores complete authoritative snapshots. */
export async function readTermSnapshot(remote: TopicTermsRemotePort, scope: TermRemoteScope, status: TermStorageStatus,
  layer: 'current' | 'saved', current: () => boolean): Promise<TopicTermSnapshot | null> {
  const head = status[layer]
  if (!head) return null
  if (!status.switched || !status.token) throw new Error('主题术语尚未完成存储切换。')
  const parts: string[] = []
  let offset = 0
  while (true) {
    if (!current()) throw new Error('主题术语范围或连接已变化。')
    const page = termReply<{ readonly text: string; readonly nextOffset: number | null }>(await remote.read({ ...scope, token: status.token, layer, offset }))
    if (!current()) throw new Error('主题术语范围或连接已变化。')
    if (typeof page.text !== 'string') throw new Error('主题术语分段回执不可读。')
    const count = Array.from(page.text).length
    if (count > TERM_TRANSFER_POINTS || page.nextOffset !== null && (!count || page.nextOffset !== offset + count)) throw new Error('主题术语分段位置不匹配。')
    parts.push(page.text)
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  let snapshot: TopicTermSnapshot | undefined
  try { snapshot = decodeTopicTermSnapshot(JSON.parse(parts.join(''))) } catch { throw new Error('主题术语正文格式不可读。') }
  if (!snapshot || !termScopeMatches(snapshot, scope) || snapshot.version !== head.version || snapshot.activeVersion !== head.activeVersion || snapshot.entries.length !== head.count) throw new Error('主题术语正文与读取版本不匹配。')
  return snapshot
}

export async function transferTermMigration(remote: TopicTermsRemotePort, scope: TermRemoteScope,
  snapshot: TopicTermSnapshot, saved: TopicTermSnapshot | null, current: () => boolean): Promise<TermStorageStatus> {
  const layers = { current: Array.from(JSON.stringify(snapshot)), saved: saved ? Array.from(JSON.stringify(saved)) : null }
  const started = termReply<{ readonly transferId: string }>(await remote.migrateBegin({ ...scope, currentPoints: layers.current.length, storedPoints: layers.saved?.length ?? null }))
  let committed = false
  try {
    for (const layer of ['current', 'saved'] as const) {
      const points = layers[layer]
      if (!points) continue
      for (let offset = 0; offset < points.length; offset += TERM_TRANSFER_POINTS) {
        if (!current()) throw new Error('主题术语迁移范围或连接已变化。')
        const text = points.slice(offset, offset + TERM_TRANSFER_POINTS).join('')
        const receipt = termReply<{ readonly nextOffset: number }>(await remote.migratePart({ ...scope, transferId: started.transferId, layer, offset, text }))
        if (receipt.nextOffset !== offset + Array.from(text).length) throw new Error('主题术语迁移分段未确认。')
      }
    }
    if (!current()) throw new Error('主题术语迁移范围或连接已变化。')
    const result = termReply<TermStorageStatus>(await remote.migrateCommit({ ...scope, transferId: started.transferId }))
    committed = true
    return result
  } finally {
    if (!committed) { try { await remote.migrateCancel({ ...scope, transferId: started.transferId }) } catch { /* A failed transfer is never a readable archive. */ } }
  }
}
