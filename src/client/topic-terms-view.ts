import { h, react } from './react.js'
import { resolveTermEvidence, type TopicTermSnapshot, type TopicTerm, type TermMutationResult, type TermEvidenceRef, type TermEvidenceFact } from '../memory/topic-terms.js'
import type { SessionStore, HistoryStatus } from './session-store.js'
import { buildTopicTermsJsonExport, buildTopicTermsMarkdownExport, type TopicTermsExport, type TopicTermsExportSnapshot } from './topic-terms-export.js'

/** UI actions are distinct from model commands: adoption records a real browser event. */
export interface TopicTermsViewPort {
  getSnapshot(ownerId: string, topicId: string): TopicTermSnapshot
  subscribe(listener: () => void): () => void
  readEvidence(sessionId: string, unitId: string): TermEvidenceFact | undefined
  getNotice(): string | undefined
  getStatus(ownerId: string, topicId: string): HistoryStatus
  reload(ownerId: string, topicId: string): boolean
  apply(ownerId: string, topicId: string, expectedVersion: number,
    command: { readonly kind: 'adopt' | 'disable'; readonly id: string; readonly expectedEntryVersion: number }): Promise<TermMutationResult>
}
const labels = { proposal: '待确认', active: '生效', conflict: '有冲突', review_required: '待复核', disabled: '已停用' } as const
const origins = { inferred: '模型提案', source_checked: '原文依据', user_explicit: '用户采用' } as const

function evidenceBody(terms: TopicTermsViewPort, snapshot: TopicTermSnapshot, ref: TermEvidenceRef): string | undefined {
  return resolveTermEvidence(snapshot, ref, (sessionId, unitId) => terms.readEvidence(sessionId, unitId))
}

function TermEvidence({ sessions, terms, snapshot, reference }: { readonly sessions: SessionStore; readonly terms: TopicTermsViewPort; readonly snapshot: TopicTermSnapshot; readonly reference: TermEvidenceRef }): unknown {
  const [open, setOpen] = react.useState(false)
  const session = sessions.getSession(reference.sessionId)
  const unit = sessions.getTranslationHistory(reference.sessionId)?.units.find(unit => unit.id === reference.unitId)
  const revision = reference.revisionId && unit?.revisions.find(revision => revision.id === reference.revisionId)
  const body = evidenceBody(terms, snapshot, reference)
  const title = `${session?.name ?? '已删除会话'} · ${unit ? `文本 ${unit.order}` : '来源不可用'}${revision ? ` · 版本 ${revision.order}` : ''} · ${reference.kind === 'source' ? '原文' : '最终译文'}${reference.role === 'example' ? '（示例）' : ''}`
  return h('div', { className: 'dsh-tp-term-evidence' },
    h('span', { className: 'dsh-tp-muted' }, title),
    h('button', { type: 'button', disabled: body === undefined, 'aria-expanded': open, onClick: () => setOpen(value => !value) }, body === undefined ? '依据已变化或不可用' : open ? '收起来源' : '查看来源'),
    open && body !== undefined ? h('div', { className: 'dsh-tp-translation-text' }, body) : null,
  )
}

function TermRow({ entry, snapshot, sessions, terms, pending, onAction, onDelete }: {
  readonly entry: TopicTerm; readonly snapshot: TopicTermSnapshot; readonly sessions: SessionStore; readonly terms: TopicTermsViewPort; readonly pending: boolean
  readonly onAction: (kind: 'adopt' | 'disable', entry: TopicTerm) => void
  readonly onDelete: (entry: TopicTerm) => void
}): unknown {
  const [expanded, setExpanded] = react.useState(false)
  return h('article', { className: 'dsh-tp-term', 'aria-label': `术语 ${entry.sourceForms.join('、')}` },
    h('div', { className: 'dsh-tp-unit-header' },
      h('span', null, `${entry.sourceForms.join('、')} → ${entry.preferred}`),
      h('span', { className: 'dsh-tp-muted', role: 'status' }, labels[entry.status]),
    ),
    h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
      entry.status !== 'active' ? h('button', { type: 'button', disabled: pending, onClick: () => onAction('adopt', entry) }, entry.status === 'disabled' ? '重新采用' : '采用') : null,
      entry.status === 'active' ? h('button', { type: 'button', disabled: pending, onClick: () => onAction('disable', entry) }, '停用') : null,
      h('button', { type: 'button', disabled: pending, onClick: () => onDelete(entry) }, '删除'),
      h('button', { type: 'button', 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) }, '详情'),
    ),
    expanded ? h('div', { className: 'dsh-tp-term-details' },
      h('div', { className: 'dsh-tp-muted' }, `${entry.sourceLanguage ?? '未指定源语言'} → ${entry.targetLanguage} · ${origins[entry.origin]} · 条目版本 ${entry.version}`),
      entry.sense ? h('div', null, `义项：${entry.sense}`) : null,
      entry.aliases.length ? h('div', null, `别名：${entry.aliases.join('、')}`) : null,
      entry.forbidden.length ? h('div', null, `避免：${entry.forbidden.join('、')}`) : null,
      ...entry.evidence.map((reference, index) => h(TermEvidence, { key: `${entry.version}:${index}`, sessions, terms, snapshot, reference })),
    ) : null,
  )
}

export function TopicTermsView({ sessions, terms, ownerId, topicId, topicName, onClose, onDelete, onExport, bridgeReason, onReconnect }: {
  readonly sessions: SessionStore; readonly terms: TopicTermsViewPort; readonly ownerId: string; readonly topicId: string; readonly topicName: string
  readonly onClose: () => void; readonly onDelete: (snapshot: TopicTermSnapshot, entry: TopicTerm) => Promise<boolean>
  readonly onExport: (result: TopicTermsExport) => void
  readonly bridgeReason?: string | undefined
  readonly onReconnect?: (() => void) | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  react.useEffect(() => terms.subscribe(() => refresh(value => value + 1)), [terms])
  react.useEffect(() => sessions.subscribe(() => refresh(value => value + 1)), [sessions])
  const [pending, setPending] = react.useState(false)
  const [failure, setFailure] = react.useState<string | undefined>(undefined)
  const [deletion, setDeletion] = react.useState<{ readonly snapshot: TopicTermSnapshot; readonly entry: TopicTerm } | undefined>(undefined)
  const alive = react.useRef(true)
  const busy = react.useRef(false)
  react.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const snapshot = terms.getSnapshot(ownerId, topicId)
  function exportTerms(format: 'json' | 'markdown'): void {
    setFailure(undefined)
    try {
      const frozen = structuredClone(terms.getSnapshot(ownerId, topicId))
      const input: TopicTermsExportSnapshot = {
        topicName: sessions.getTopics(ownerId).find(topic => topic.id === topicId)?.name ?? topicName,
        snapshot: frozen, exportedAt: new Date().toISOString(),
        rememberHistory: sessions.getSettings().rememberHistory, storageStatus: terms.getStatus(ownerId, topicId),
        evidenceAvailability: frozen.entries.flatMap(entry => entry.evidence.map((ref, evidenceIndex) => {
          const candidate = sessions.getSession(ref.sessionId)
          const session = candidate?.ownerId === ownerId && candidate.topicId === topicId && !sessions.isSessionDeleted(candidate.id) ? candidate : undefined
          const unit = session ? sessions.getTranslationHistory(session.id)?.units.find(unit => unit.id === ref.unitId) : undefined
          const revision = unit?.revisions.find(revision => revision.id === ref.revisionId)
          return { entryId: entry.id, evidenceIndex, sessionName: session?.name ?? null, unitOrder: unit?.order ?? null,
            revisionOrder: revision?.order ?? null, readable: evidenceBody(terms, frozen, ref) !== undefined }
        })),
      }
      onExport(format === 'json' ? buildTopicTermsJsonExport(input) : buildTopicTermsMarkdownExport(input))
    } catch { setFailure('导出失败，当前档案仍保留。') }
  }
  async function run(action: () => Promise<boolean | string>): Promise<void> {
    if (busy.current) return
    busy.current = true; setPending(true); setFailure(undefined)
    try {
      const result = await action()
      if (result !== true && alive.current) setFailure(typeof result === 'string' ? result : '操作未完成；术语可能已变化，请核对后重试。')
    }
    catch { if (alive.current) setFailure('操作未完成，请重试。') }
    finally { busy.current = false; if (alive.current) setPending(false) }
  }
  return h('section', { className: 'dsh-tp-terms', 'aria-label': `主题术语：${topicName}` },
    h('div', { className: 'dsh-tp-unit-header' }, h('span', null, `${topicName} · 主题术语`),
      h('button', { type: 'button', onClick: onClose, 'aria-label': '关闭主题术语' }, '×')),
    h('small', { className: 'dsh-tp-muted' }, '同主题会话共用；快译不使用这些术语。'),
    h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
      h('button', { type: 'button', onClick: () => exportTerms('json') }, '导出 JSON'),
      h('button', { type: 'button', onClick: () => exportTerms('markdown') }, '导出 Markdown'),
    ),
    h('small', { className: 'dsh-tp-muted' }, '仅现有术语快照；不提炼或整理，不含来源正文和主聊天。'),
    bridgeReason ? h('p', { role: 'status', className: 'dsh-tp-muted' }, bridgeReason) : null,
    bridgeReason && onReconnect ? h('button', { type: 'button', onClick: onReconnect }, '重新连接主会话') : null,
    h('small', { className: 'dsh-tp-muted' }, sessions.getSettings().rememberHistory ? '已开启历史保存；主题术语保存在此设备。' : '已保存的术语保留；后续修改仅保留在本次运行。'),
    snapshot.version > 0 ? h('div', { className: 'dsh-tp-muted' }, h('time', { dateTime: snapshot.updatedAt }, `档案更新于 ${new Date(snapshot.updatedAt).toLocaleString()}`)) : null,
    snapshot.entries.length === 0 ? h('p', { className: 'dsh-tp-muted' }, '暂无术语。') : null,
    ...snapshot.entries.map(entry => h(TermRow, { key: entry.id, entry, snapshot, sessions, terms, pending,
      onAction: (kind: 'adopt' | 'disable', entry: TopicTerm) => { void run(async () => {
        const result = await terms.apply(ownerId, topicId, snapshot.version, { kind, id: entry.id, expectedEntryVersion: entry.version })
        if (result.status === 'conflict') return '请先停用或处理同范围的冲突条目，再采用此术语。'
        if (result.status === 'stale') return '术语已变化，请核对最新条目后重试。'
        if (result.status === 'invalid') return '术语内容或来源无效，未修改此条目。'
        return result.status === 'updated' || result.status === 'unchanged'
      }) },
      onDelete: (entry: TopicTerm) => setDeletion(structuredClone({ snapshot, entry })),
    })),
    deletion ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '删除主题术语确认' },
      h('p', null, `删除“${deletion.entry.sourceForms.join('、')} → ${deletion.entry.preferred}”？同主题全部会话共用此条目。`),
      h('div', { className: 'dsh-tp-actions' },
        h('button', { type: 'button', disabled: pending, onClick: () => { void run(async () => {
          const removed = await onDelete(deletion.snapshot, deletion.entry)
          if (removed && alive.current) setDeletion(current => current === deletion ? undefined : current)
          return removed
        }) } }, pending ? '正在删除…' : '确认删除术语'),
        h('button', { type: 'button', disabled: pending, onClick: () => setDeletion(undefined) }, '取消'),
      ),
    ) : null,
    terms.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, terms.getNotice()) : null,
    terms.getStatus(ownerId, topicId) === 'conflict' ? h('button', { type: 'button', disabled: pending,
      onClick: () => { if (!terms.reload(ownerId, topicId)) setFailure('最新主题术语无法读取，当前内容保留。') } }, '读取最新术语') : null,
    failure ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, failure) : null,
  )
}
