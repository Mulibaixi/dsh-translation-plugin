import { h, react } from './react.js'
import { downloadExport } from './browser-download.js'
import type { SessionStore } from './session-store.js'
import type { QuickTranslationClient } from './quick-translation.js'
import type { TextRevision } from './translation-history.js'
import { type TopicTranslationExport, type TranslationExportSession, type TranslationExportTopic } from './translation-export.js'
import { buildRecordObjectExport, recordObjectPlainText } from './record-object-export.js'
import type { RecordObjectReference } from '../shared/record-objects.js'
import { RecordObjectEditor, RecordObjectText, type RecordObjectsProps } from './record-object-view.js'

interface EditDraft { readonly baseRevisionId: string; readonly original: string; readonly text: string }
type RecordsScope = 'session' | 'topic'
interface PendingRecordsExport {
  readonly topic: TranslationExportTopic; readonly entries: readonly TranslationExportSession[]; readonly scope: RecordsScope
  readonly format: 'txt' | 'json'; readonly exportedAt: string; readonly result: TopicTranslationExport
  readonly references: readonly RecordObjectReference[]
}
function editable(revision: TextRevision): boolean {
  return Boolean(revision.text.trim()) && ['completed', 'failed', 'cancelled', 'interrupted'].includes(revision.status)
}
function projectExport(request: Omit<PendingRecordsExport, 'result'>, allowPartial = false): TopicTranslationExport {
  return buildRecordObjectExport(request, allowPartial)
}
export function MemoryTranslationRecordsView({ store, quick, objects, objectAssets, ownerId, topicId, associatedSessionId, navigationRevision, visible = true }: RecordObjectsProps & {
  readonly store: SessionStore; readonly quick: QuickTranslationClient; readonly ownerId: string; readonly topicId: string
  readonly associatedSessionId?: string | undefined; readonly navigationRevision?: number | undefined; readonly visible?: boolean
}): unknown {
  const [, refresh] = react.useState(0)
  const associated = associatedSessionId ? store.getSession(associatedSessionId) : undefined
  const validAssociated = associated?.ownerId === ownerId && associated.topicId === topicId && !store.isSessionDeleted(associated.id) ? associated.id : undefined
  const [scope, setScope] = react.useState<RecordsScope>(() => validAssociated ? 'session' : 'topic')
  const [sessionId, setSessionId] = react.useState<string | undefined>(validAssociated)
  const [expanded, setExpanded] = react.useState(() => new Set<string>())
  const [drafts, setDrafts] = react.useState(() => new Map<string, EditDraft>())
  const [message, setMessage] = react.useState<string | undefined>(undefined)
  const [exportRequest, setExportRequest] = react.useState<PendingRecordsExport | undefined>(undefined)
  const reader = react.useRef<{ scrollTop: number } | null>(null)
  const scrollPositions = react.useRef(new Map<string, number>())
  const scrollKey = scope === 'topic' ? 'topic' : `session:${sessionId ?? ''}`
  function rememberScroll(): void { if (visible && reader.current) scrollPositions.current.set(scrollKey, reader.current.scrollTop) }
  react.useEffect(() => store.subscribe(() => {
    refresh(value => value + 1)
    setDrafts(current => new Map([...current].filter(([key, draft]) => {
      const [id, unitId] = JSON.parse(key) as [string, string]
      return !store.isSessionDeleted(id) && Boolean(store.getTranslationHistory(id)?.units.find(unit => unit.id === unitId)?.revisions.some(revision => revision.id === draft.baseRevisionId))
    })))
  }), [store])
  react.useEffect(() => objects?.subscribe(() => refresh(value => value + 1)), [objects])
  react.useEffect(() => {
    if (!validAssociated) return
    rememberScroll(); setScope('session'); setSessionId(validAssociated)
  }, [validAssociated, navigationRevision])
  react.useEffect(() => {
    if (visible && reader.current) reader.current.scrollTop = scrollPositions.current.get(scrollKey) ?? 0
  }, [visible, scrollKey])
  const sessions = [...store.getAvailableSessions(ownerId)].filter(session => session.topicId === topicId && !store.isSessionDeleted(session.id))
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
  const selectedSession = sessions.find(session => session.id === sessionId)
  const viewedSessions = scope === 'topic' ? sessions : selectedSession ? [selectedSession] : []
  const groups = viewedSessions.map(session => ({ session, units: [...(store.getTranslationHistory(session.id)?.units ?? [])].sort((a, b) => a.order - b.order) })).filter(group => group.units.length)
  async function copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); setMessage('已复制。') } catch { setMessage('复制失败，请重试。') }
  }
  function deliverExport(result: TopicTranslationExport): void {
    try { downloadExport(result); setMessage('已向浏览器发起下载。'); setExportRequest(undefined) }
    catch { setMessage('无法启动下载，请重试。') }
  }
  function exportRecords(format: 'txt' | 'json'): void {
    setMessage(undefined); setExportRequest(undefined)
    try {
      const topic = store.getTopics(ownerId).find(candidate => candidate.id === topicId)
      if (!topic) throw new Error('Topic no longer available')
      const targets = scope === 'topic' ? sessions : selectedSession ? [selectedSession] : []
      if (!targets.some(session => store.getTranslationHistory(session.id)?.units.length)) { setMessage('当前范围尚无译文记录。'); return }
      for (const session of targets) if (!quick.finalizeForExport(session.id)) throw new Error('Cannot finalize export')
      const entries = targets.map(session => {
        const history = store.getTranslationHistory(session.id)
        if (!history) throw new Error('Session no longer available')
        return { session, history }
      })
      const references = targets.flatMap(session => objects?.getSnapshot(ownerId, topicId, session.id).references ?? [])
      const frozen = structuredClone({ topic: { ownerId, topicId, topicName: topic.name }, entries, references, scope, format, exportedAt: new Date().toISOString() })
      const result = projectExport(frozen)
      if (!result.complete) { setExportRequest({ ...frozen, result }); return }
      if (!result.content) { setMessage('当前范围没有可导出的译文。'); return }
      deliverExport(result)
    } catch { setMessage('导出失败，当前内容仍保留。') }
  }
  const note = '原文只读；人工修改保存为新版本，再明确设为最终。'
  return h('section', { className: 'dsh-tp-terms dsh-tp-records', 'aria-label': '译文记录', 'data-records-scope': scope, 'data-records-session-id': sessionId },
    h('div', { className: 'dsh-tp-asset-toolbar' },
      h('div', { className: 'dsh-tp-unit-header' },
        h('div', { className: 'dsh-tp-asset-heading' }, h('h3', null, '译文记录'), h('small', { className: 'dsh-tp-muted dsh-tp-asset-note', title: note }, note)),
        h('div', { className: 'dsh-tp-actions' },
          h('button', { type: 'button', title: `导出${scope === 'topic' ? '当前主题全部会话（含归档）' : '当前查阅会话'}的最终译文；未定稿项会先提示。`, onClick: () => exportRecords('txt') }, '导出 TXT'),
          h('button', { type: 'button', title: `导出${scope === 'topic' ? '当前主题全部会话（含归档）' : '当前查阅会话'}的原文与最终译文对照；不含草稿、修订历史或调用信息。`, onClick: () => exportRecords('json') }, '导出 JSON'))),
      h('div', { className: 'dsh-tp-records-scope' },
        h('select', { 'aria-label': '译文查阅范围', value: scope, onChange: (event: { currentTarget: { value: string } }) => {
          rememberScroll(); const next = event.currentTarget.value; if (next !== 'session' && next !== 'topic') return
          if (next === 'session' && !selectedSession) setSessionId(sessions[0]?.id)
          setScope(next)
        } }, h('option', { value: 'session', disabled: !sessions.length }, '当前会话'), h('option', { value: 'topic' }, '当前主题全部会话')),
        scope === 'session' ? h('select', { 'aria-label': '查阅会话', value: sessionId ?? '', onChange: (event: { currentTarget: { value: string } }) => {
          rememberScroll(); setSessionId(event.currentTarget.value)
        } }, !selectedSession ? h('option', { value: sessionId ?? '', disabled: true }, sessionId ? '原会话已不可用' : '选择会话') : null,
        ...sessions.map(session => h('option', { key: session.id, value: session.id }, `${session.remark || session.name}${session.archivedAt !== null ? '（已归档）' : ''}`))) : null),
      message ? h('p', { role: 'status', className: 'dsh-tp-muted' }, message) : null),
    exportRequest ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '导出译文确认' },
      h('h3', null, exportRequest.scope === 'topic' ? `导出主题「${exportRequest.topic.topicName}」` : `导出会话「${exportRequest.entries[0]!.session.remark || exportRequest.entries[0]!.session.name}」`),
      h('p', null, `尚无最终译文：${exportRequest.result.missingUnits.map(unit => `${unit.sessionName} · 文本 ${unit.order}`).join('、')}。`),
      h('div', { className: 'dsh-tp-actions' },
        h('button', { type: 'button', disabled: exportRequest.result.exportedUnitIds.length === 0, onClick: () => deliverExport(projectExport(exportRequest, true)) }, '仅导出已定稿'),
        h('button', { type: 'button', onClick: () => setExportRequest(undefined) }, '取消')),
    ) : null,
    h('div', { className: 'dsh-tp-records-reader', 'aria-label': '连续译文记录', ref: reader,
      onScroll: (event: { currentTarget: { scrollTop: number } }) => { if (visible) scrollPositions.current.set(scrollKey, event.currentTarget.scrollTop) } },
      groups.length === 0 ? h('p', { className: 'dsh-tp-muted', role: 'status' }, scope === 'session' && !selectedSession ? '此会话已不可用，请选择其他会话或主题范围。' : '当前范围尚无译文记录。') : null,
      ...groups.map(({ session, units }) => h('section', { key: session.id, className: 'dsh-tp-records-session', 'aria-label': `会话译文：${session.remark || session.name}`, 'data-session-id': session.id },
        h('h3', null, session.remark || session.name),
        session.archivedAt !== null ? h('p', { className: 'dsh-tp-muted' }, '会话已归档，请先在翻译工作区恢复后编辑。') : null,
        ...units.map(unit => {
          const key = JSON.stringify([session.id, unit.id]), draft = drafts.get(key), open = expanded.has(key)
          const pointed = unit.revisions.find(revision => revision.id === unit.final?.revisionId)
          const final = pointed?.accepted && pointed.status === 'completed' && pointed.text.trim() ? pointed : undefined
          const latest = unit.revisions.at(-1)
          const candidate = latest?.accepted && latest.status === 'completed' && latest.text.trim() && latest.id !== final?.id ? latest : undefined
          const base = final ?? [...unit.revisions].reverse().find(editable), archived = session.archivedAt !== null
          const blockedEdit = quick.manualEditBlockedReason(session.id, unit.id, draft?.baseRevisionId ?? base?.id ?? '')
          const target = { ownerId, topicId, sessionId: session.id, unitId: unit.id, side: 'source' as const, revisionId: null }
          return h('article', { key: unit.id, className: 'dsh-tp-record-unit', 'data-session-id': session.id, 'data-unit-id': unit.id, 'aria-label': `文本 ${unit.order}` },
            h('div', { className: 'dsh-tp-record-unit-heading' },
              h('button', { type: 'button', 'aria-label': `${session.name} · 文本 ${unit.order}`, 'aria-expanded': open, onClick: () => {
                setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
              } }, `文本 ${unit.order} · ${final ? '已定稿' : '待定稿'}`),
              h('small', { className: 'dsh-tp-muted' }, `目标语言：${unit.targetLanguage}`)),
            h('div', { className: 'dsh-tp-record-pair' },
              h('div', { className: 'dsh-tp-record-source', 'aria-label': '原文' }, h('h4', null, '原文'), h(RecordObjectText, { text: unit.source, target, objects, objectAssets })),
              h('div', { className: 'dsh-tp-record-target', 'aria-label': '最终译文' }, h('h4', null, '最终译文'),
                final ? h('div', null, h('small', { className: 'dsh-tp-muted' }, `版本 ${final.order} · ${unit.final?.selection === 'user_fixed' ? '用户固定' : '自动最终'}`),
                  h(RecordObjectText, { text: final.text, target: { ...target, side: 'revision', revisionId: final.id }, objects, objectAssets }), h('button', { type: 'button', onClick: () => { const scope = { ...target, side: 'revision' as const, revisionId: final.id }; void copy(recordObjectPlainText(final.text, scope, objects?.getReferences(scope) ?? [])) } }, '复制最终译文')) : h('p', { className: 'dsh-tp-muted' }, '尚无最终译文。'),
                h('div', { className: 'dsh-tp-record-actions', hidden: !open },
                  candidate ? h('div', { className: 'dsh-tp-asset-candidate' }, h('h4', null, `候选 · 版本 ${candidate.order}`),
                    h(RecordObjectText, { text: candidate.text, target: { ...target, side: 'revision', revisionId: candidate.id }, objects, objectAssets }),
                    h('button', { type: 'button', disabled: archived, onClick: () => setMessage(quick.selectFinal(session.id, unit.id, candidate.id) ? '已设为最终。' : '版本已变化，未设为最终。') }, '设为最终')) : null,
                  draft ? h('div', { className: 'dsh-tp-version-editor' },
                    h('small', { className: 'dsh-tp-muted' }, `基于版本 ${unit.revisions.find(revision => revision.id === draft.baseRevisionId)?.order ?? '已失效'}保存为新版本；未调用模型。`),
                    h('textarea', { 'aria-label': '编辑译文', value: draft.text, rows: 8, disabled: archived, onChange: (event: { currentTarget: { value: string } }) => {
                      const text = event.currentTarget.value; setDrafts(current => new Map(current).set(key, { ...draft, text }))
                    } }),
                    h('div', { className: 'dsh-tp-actions' },
                      h('button', { type: 'button', disabled: archived || !!blockedEdit || !draft.text.trim() || draft.text === draft.original, title: blockedEdit, onClick: () => {
                        if (quick.saveManualRevision(session.id, unit.id, draft.baseRevisionId, draft.text)) {
                          setDrafts(current => { const next = new Map(current); next.delete(key); return next }); setMessage('已保存新候选版本；可设为最终。')
                        } else setMessage('保存失败，编辑内容仍保留。')
                      } }, '保存新版本'),
                      h('button', { type: 'button', onClick: () => setDrafts(current => { const next = new Map(current); next.delete(key); return next }) }, '取消编辑')),
                  ) : h('button', { type: 'button', disabled: archived || !!blockedEdit || !base || !editable(base), title: blockedEdit, onClick: () => { if (base && !blockedEdit) setDrafts(current => new Map(current).set(key, { baseRevisionId: base.id, original: base.text, text: base.text })) } }, '编辑译文'),
                  blockedEdit ? h('small', { className: 'dsh-tp-muted' }, blockedEdit) : null))),
            h('div', { className: 'dsh-tp-record-actions', hidden: !open }, h(RecordObjectEditor, { session, unit, objects, objectAssets }))
          )
        })))))
}
