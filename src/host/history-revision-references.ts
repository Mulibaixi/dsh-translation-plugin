import type { TopicHostContext } from './topic-tools.js'

interface SessionEvent { readonly type: string; readonly data?: { readonly message?: { readonly content?: readonly { readonly type: string; readonly text?: string }[] } } }
interface LiveSessions { list(): readonly { readonly id: string; snapshotEvents(): readonly SessionEvent[] }[] }
interface SessionPersistence {
  list(): Promise<readonly { readonly header: { readonly id: string }; readonly revision: string }[]>
  open(id: string, access: 'read'): Promise<{ read(): Promise<{ readonly events: readonly SessionEvent[] }>; close(): Promise<void> }>
}

function collect(events: readonly SessionEvent[]): ReadonlySet<string> {
  const references = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const text = event.data?.message?.content?.find(part => part.type === 'text')?.text
    if (!text?.includes('translation_result_history')) continue
    try {
      const result = JSON.parse(text)
      const target = result?.read?.arguments
      if (result?.kind === 'translation_result_history' && result.read.tool === 'translation_read_history' &&
        target?.side === 'translation' && typeof target.translationSessionId === 'string' &&
        typeof target.unitId === 'string' && typeof target.revisionId === 'string') {
        references.add(JSON.stringify([target.translationSessionId, target.unitId, target.revisionId]))
      }
    } catch { /* A non-JSON tool result does not carry a generated reference. */ }
  }
  return references
}

export class HistoryRevisionReferences {
  private readonly saved = new Map<string, { readonly revision: string; readonly references: ReadonlySet<string> }>()
  constructor(private readonly context: TopicHostContext) {}

  async read(sessionId: string, candidates: readonly { readonly unitId: string; readonly revisionId: string }[]): Promise<ReadonlySet<string>> {
    if (!candidates.length) return new Set()
    const protectAll = () => new Set(candidates.map(candidate => candidate.revisionId))
    const sessions = this.context.get?.('sessions') as LiveSessions | undefined
    const persistence = this.context.get?.('sessionPersistence') as SessionPersistence | undefined
    // Compacted references before this feature already live in the host's chat logs.
    if (!sessions?.list || !persistence?.list || !persistence.open) return protectAll()
    try {
      const live = new Set(sessions.list().map(session => session.id)), stored = await persistence.list()
      const references: ReadonlySet<string>[] = []
      for (const row of stored) {
        const id = row.header.id
        if (live.has(id)) continue
        let cached = this.saved.get(id)
        if (!cached || !row.revision || cached.revision !== row.revision) {
          const handle = await persistence.open(id, 'read')
          try { cached = { revision: row.revision, references: collect((await handle.read()).events) } }
          finally { await handle.close() }
          this.saved.set(id, cached)
        }
        references.push(cached.references)
      }
      const liveNow = sessions.list()
      // A detached session must have been read from persistence; retry after its close settles.
      if ([...live].some(id => !liveNow.some(session => session.id === id))) return protectAll()
      for (const session of liveNow) references.push(collect(session.snapshotEvents()))
      return new Set(candidates.filter(({ unitId, revisionId }) => {
        const key = JSON.stringify([sessionId, unitId, revisionId])
        return references.some(log => log.has(key))
      }).map(candidate => candidate.revisionId))
    } catch { return protectAll() }
  }
}
