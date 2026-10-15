import { h, react } from './react.js'
import { downloadExport } from './browser-download.js'
import { useExportDownloadFeedback } from './export-download-feedback.js'
import type { SessionStore } from './session-store.js'
import type { QuickTranslationClient } from './quick-translation.js'
import { currentFinalRevision, isTextUnit, revisionDeletionChanged, type TextRevision } from './translation-history.js'
import { DocumentUnitView, TextUnitOpenLinks, type DocumentViewProps } from './document-unit-view.js'
import { allowPartialTranslationExport, type TopicTranslationExport, type TranslationExportSession, type TranslationExportTopic } from './translation-export.js'
import { buildRecordObjectExportAsync, recordObjectPlainText } from './record-object-export.js'
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
function projectExport(request: Omit<PendingRecordsExport, 'result'>, documents: DocumentViewProps['documents']): Promise<TopicTranslationExport> {
  return buildRecordObjectExportAsync(request, documents, true)
}
export function MemoryTranslationRecordsView({ store, quick, objects, objectAssets, documents, documentTasks, documentReviews, ownerId, topicId, associatedSessionId, navigationRevision, visible = true }: RecordObjectsProps & DocumentViewProps & {
  readonly store: SessionStore; readonly quick: QuickTranslationClient; readonly ownerId: string; readonly topicId: string
  readonly associatedSessionId?: string | undefined; readonly navigationRevision?: number | undefined; readonly visible?: boolean
}): unknown {
  const [, refresh] = react.useState(0)
  const associated = associatedSessionId ? store.getSession(associatedSessionId) : undefined
  const validAssociated = associated?.topicId === topicId && !store.isSessionDeleted(associated.id) ? associated.id : undefined
  const [scope, setScope] = react.useState<RecordsScope>(() => validAssociated ? 'session' : 'topic')
  const [sessionId, setSessionId] = react.useState<string | undefined>(validAssociated)
  const [expanded, setExpanded] = react.useState(() => new Set<string>())
  const [drafts, setDrafts] = react.useState(() => new Map<string, EditDraft>())
  const [message, setMessage] = react.useState<string | undefined>(undefined)
  const exportFeedback = useExportDownloadFeedback(visible)
  const [exportRequest, setExportRequest] = react.useState<PendingRecordsExport | undefined>(undefined)
  const [exporting, setExporting] = react.useState(false)
  const [exportLabel, setExportLabel] = react.useState('')
  const lifetime = react.useRef({ mounted: true, exportId: 0, busy: false })
  react.useEffect(() => { lifetime.current.mounted = true; setExportRequest(undefined); setExporting(false); return () => { lifetime.current.mounted = false; lifetime.current.exportId++; lifetime.current.busy = false } }, [ownerId, topicId])
  const reader = react.useRef<{ scrollTop: number } | null>(null)
  const scrollPositions = react.useRef(new Map<string, number>())
  const scrollKey = scope === 'topic' ? 'topic' : `session:${sessionId ?? ''}`
  function rememberScroll(): void { if (visible && reader.current) scrollPositions.current.set(scrollKey, reader.current.scrollTop) }
  react.useEffect(() => store.subscribe(() => {
    refresh(value => value + 1)
    setExportRequest(request => request?.entries.some(entry => revisionDeletionChanged(entry.history, store.getTranslationHistory(entry.session.id))) ? undefined : request)
    setDrafts(current => new Map([...current].filter(([key, draft]) => {
      const [id, unitId] = JSON.parse(key) as [string, string]
      return !store.isSessionDeleted(id) && Boolean(store.getTranslationHistory(id)?.units.find(unit => unit.id === unitId)?.revisions.some(revision => revision.id === draft.baseRevisionId && (!('status' in revision) || revision.status !== 'deleted')))
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
  const sessions = [...store.getTopicSessions(topicId)]
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
  const selectedSession = sessions.find(session => session.id === sessionId)
  const viewedSessions = scope === 'topic' ? sessions : selectedSession ? [selectedSession] : []
  const groups = viewedSessions.map(session => ({ session, units: [...(store.getTranslationHistory(session.id)?.units ?? [])].sort((a, b) => a.order - b.order) })).filter(group => group.units.length)
  async function copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); setMessage('已复制。') } catch { setMessage('复制失败，请重试。') }
  }
  function deliverExport(result: TopicTranslationExport, request: Omit<PendingRecordsExport, 'result'>): void {
    if (request.entries.some(({ session, history }) => {
      const current = store.getSession(session.id)
      return !current || store.isSessionDeleted(session.id) || current.ownerId !== session.ownerId || current.topicId !== request.topic.topicId || revisionDeletionChanged(history, store.getTranslationHistory(session.id))
    })) { setMessage('导出范围已不可用，请重新导出。'); return }
    try {
      const download = allowPartialTranslationExport(result)
      downloadExport(download); exportFeedback.downloadStarted(download.fileName)
      setMessage(undefined); setExportRequest(undefined)
    }
    catch { setMessage('无法启动下载，请重试。') }
  }
  async function exportRecords(format: 'txt' | 'json'): Promise<void> {
    if (lifetime.current.busy) return
    const exportId = ++lifetime.current.exportId
    const active = (): boolean => lifetime.current.mounted && lifetime.current.exportId === exportId && store.getTopics(ownerId).some(topic => topic.id === topicId)
    lifetime.current.busy = true; setExporting(true)
    exportFeedback.clear(); setMessage(undefined); setExportRequest(undefined)
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
      const references = targets.flatMap(session => objects?.getSnapshot(session.ownerId, topicId, session.id).references ?? [])
      const frozen = { ...structuredClone({ topic: { ownerId: store.getTopicAssetOwner(topicId) ?? ownerId, topicId, topicName: topic.name }, references, scope, format, exportedAt: new Date().toISOString() }), entries: entries.map(({ session, history }) => ({ session: structuredClone(session), history })) }
      setExportLabel(scope === 'topic' ? `主题「${topic.name}」` : `会话「${selectedSession!.remark || selectedSession!.name}」`)
      const result = await projectExport(frozen, documents)
      if (!active()) return
      if (frozen.entries.some(entry => revisionDeletionChanged(entry.history, store.getTranslationHistory(entry.session.id)))) { setMessage('导出期间版本已删除，请重新导出。'); return }
      if (!result.complete) { setExportRequest({ ...frozen, result }); return }
      if (!result.content) { setMessage('当前范围没有可导出的译文。'); return }
      deliverExport(result, frozen)
    } catch { if (active()) setMessage('导出失败，当前内容仍保留。') }
    finally { if (lifetime.current.exportId === exportId) { lifetime.current.busy = false; if (lifetime.current.mounted) setExporting(false) } }
  }
  const note = '原文只读；人工修改保存为新版本，再明确设为最终。'
  return h('section', { className: 'dsh-tp-terms dsh-tp-records', 'aria-label': '译文记录', 'data-records-scope': scope, 'data-records-session-id': sessionId },
    exportFeedback.toast,
    h('div', { className: 'dsh-tp-asset-toolbar' },
      h('div', { className: 'dsh-tp-unit-header' },
        h('div', { className: 'dsh-tp-asset-heading' }, h('h3', null, '译文记录'), h('small', { className: 'dsh-tp-muted dsh-tp-asset-note', title: note }, note)),
        h('div', { className: 'dsh-tp-actions' },
          h('button', { type: 'button', disabled: exporting, title: `导出${scope === 'topic' ? '当前主题全部会话（含归档）' : '当前查阅会话'}的最终译文；未定稿项会先提示。`, onClick: () => { void exportRecords('txt') } }, '导出 TXT'),
          h('button', { type: 'button', disabled: exporting, title: `导出${scope === 'topic' ? '当前主题全部会话（含归档）' : '当前查阅会话'}的原文与最终译文对照；不含草稿、修订历史或调用信息。`, onClick: () => { void exportRecords('json') } }, '导出 JSON'))),
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
      exporting ? h('p', { role: 'status', className: 'dsh-tp-muted' }, `正在读取${exportLabel}的固定译文…`) : null,
      message ? h('p', { role: 'status', className: 'dsh-tp-muted' }, message) : null),
    exportRequest ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '导出译文确认' },
      h('h3', null, exportRequest.scope === 'topic' ? `导出主题「${exportRequest.topic.topicName}」` : `导出会话「${exportRequest.entries[0]!.session.remark || exportRequest.entries[0]!.session.name}」`),
      h('p', null, `当前范围包含缺项：${exportRequest.result.missingUnits.map(unit => `${unit.sessionName} · 单元 ${unit.order}`).join('、')}。完整导出尚不可用。`),
      h('p', null, '部分导出会保留有效译文并标明缺失区间。'),
      h('div', { className: 'dsh-tp-actions' },
        h('button', { type: 'button', disabled: exportRequest.result.exportedUnitIds.length === 0, onClick: () => deliverExport(exportRequest.result, exportRequest) }, '导出部分结果（含缺口）'),
        h('button', { type: 'button', onClick: () => setExportRequest(undefined) }, '取消')),
    ) : null,
    h('div', { className: 'dsh-tp-records-reader', 'aria-label': '连续译文记录', ref: reader,
      onScroll: (event: { currentTarget: { scrollTop: number } }) => { if (visible) scrollPositions.current.set(scrollKey, event.currentTarget.scrollTop) } },
      groups.length === 0 ? h('p', { className: 'dsh-tp-muted', role: 'status' }, scope === 'session' && !selectedSession ? '此会话已不可用，请选择其他会话或主题范围。' : '当前范围尚无译文记录。') : null,
      ...groups.map(({ session, units }) => h('section', { key: session.id, className: 'dsh-tp-records-session', 'aria-label': `会话译文：${session.remark || session.name}`, 'data-session-id': session.id },
        h('h3', null, session.remark || session.name),
        session.archivedAt !== null ? h('p', { className: 'dsh-tp-muted' }, '会话已归档，请先在翻译工作区恢复后编辑。') : null,
        ...units.map(unit => {
          if (!isTextUnit(unit)) return h(DocumentUnitView, { key: unit.id, unit, session, store, documents, documentTasks, documentReviews, objects, objectAssets, visible, navigationRevision })
          const revisions = unit.revisions
          const key = JSON.stringify([session.id, unit.id]), draft = drafts.get(key), open = expanded.has(key)
          const pointed = unit.revisions.find(revision => revision.id === unit.final?.revisionId)
          const final = currentFinalRevision(unit)
          const latest = unit.revisions.at(-1)
          const candidate = latest?.accepted && latest.status === 'completed' && latest.text.trim() && latest.id !== final?.id ? latest : undefined
          const archived = session.archivedAt !== null
          const target = { ownerId: session.ownerId, topicId, sessionId: session.id, unitId: unit.id, side: 'source' as const, revisionId: null }
          function startEditing(revision: TextRevision): void {
            setDrafts(current => {
              const existing = current.get(key)
              if (existing) return current
              return new Map(current).set(key, { baseRevisionId: revision.id, original: revision.text, text: revision.text })
            })
          }
          function revisionView(revision: TextRevision, kind: 'final' | 'candidate'): unknown {
            const isCandidate = kind === 'candidate'
            const revisionDraft = draft?.baseRevisionId === revision.id ? draft : undefined
            const otherDraft = Boolean(draft && !revisionDraft)
            const blockedEdit = quick.manualEditBlockedReason(session.id, unit.id, revision.id)
            const revisionTarget = { ...target, side: 'revision' as const, revisionId: revision.id }
            const stale = revision.sourceVersion !== unit.sourceVersion
            const canSave = Boolean(revisionDraft && revisionDraft.text.trim() && revisionDraft.text !== revisionDraft.original && !archived && !blockedEdit)
            function saveDraft(finalize: boolean): void {
              if (!revisionDraft) return
              if (quick.saveManualRevision(session.id, unit.id, revision.id, revisionDraft.text, finalize)) {
                setDrafts(current => { const next = new Map(current); next.delete(key); return next })
                setMessage(finalize ? '已保存并设为最终。' : '已保存为最新候选。')
              } else setMessage('保存失败，编辑内容仍保留。')
            }
            return h('div', { className: 'dsh-tp-record-revision', 'data-revision-kind': kind, 'data-revision-id': revision.id },
              h('small', { className: 'dsh-tp-muted' }, isCandidate
                ? `候选 · 版本 ${revision.order}${stale ? ` · 已过时（原文版本 ${revision.sourceVersion}）` : ''}`
                : `版本 ${revision.order} · ${unit.final?.selection === 'user_fixed' ? '用户固定' : '自动最终'}`),
              h(RecordObjectText, { text: revision.text, target: revisionTarget, objects, objectAssets }),
              h('div', { className: 'dsh-tp-actions dsh-tp-record-version-actions' },
                h('button', { type: 'button', 'aria-label': `${isCandidate ? '复制候选版本' : '复制最终译文'} ${revision.order}`, onClick: () => { void copy(recordObjectPlainText(revision.text, revisionTarget, objects?.getReferences(revisionTarget) ?? [])) } }, '复制'),
                h('button', { type: 'button', 'aria-label': `编辑${isCandidate ? '候选版本' : '最终版本'} ${revision.order}`, disabled: archived || !!blockedEdit || !editable(revision) || otherDraft || !!revisionDraft, title: blockedEdit ?? (otherDraft ? '请先保存或取消此段的当前编辑。' : undefined), onClick: () => startEditing(revision) }, revisionDraft ? '编辑中' : '编辑'),
                isCandidate ? h('button', { type: 'button', 'aria-label': `将候选版本 ${revision.order} 设为最终`, disabled: archived || stale || Boolean(draft), title: draft ? '请先保存或取消此段的当前编辑。' : undefined,
                  onClick: () => setMessage(quick.selectFinal(session.id, unit.id, revision.id) ? '已设为最终。' : '版本已变化，未设为最终。') }, '设为最终') : null),
              blockedEdit ? h('small', { className: 'dsh-tp-muted' }, blockedEdit) : null,
              revisionDraft ? h('div', { className: 'dsh-tp-version-editor dsh-tp-record-inline-editor' },
                h('small', { className: 'dsh-tp-muted' }, `基于版本 ${revisions.find(item => item.id === revisionDraft.baseRevisionId)?.order ?? '已失效'}保存为新版本；未调用模型。`),
                h('textarea', { 'aria-label': `编辑版本 ${revision.order} 的译文`, value: revisionDraft.text, rows: 8, disabled: archived || !!blockedEdit, onChange: (event: { currentTarget: { value: string } }) => {
                  const text = event.currentTarget.value
                  setDrafts(current => new Map(current).set(key, { ...revisionDraft, text }))
                } }),
                h('div', { className: 'dsh-tp-actions' },
                  h('button', { type: 'button', disabled: !canSave, title: blockedEdit, onClick: () => saveDraft(false) }, '保存最新版本'),
                  h('button', { type: 'button', disabled: !canSave || (isCandidate && stale), title: isCandidate && stale ? '原文版本已变化，不能将此候选设为最终。' : blockedEdit, onClick: () => saveDraft(true) }, '保存并定稿'),
                  h('button', { type: 'button', onClick: () => setDrafts(current => { const next = new Map(current); next.delete(key); return next }) }, '取消编辑')),
              ) : null)
          }
          return h('article', { key: unit.id, className: 'dsh-tp-record-unit', 'data-session-id': session.id, 'data-unit-id': unit.id, 'aria-label': `文本 ${unit.order}` },
            h('div', { className: 'dsh-tp-record-unit-heading' },
              h('button', { type: 'button', 'aria-label': `${session.name} · 文本 ${unit.order}`, 'aria-expanded': open, onClick: () => {
                setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
              } }, `文本 ${unit.order} · ${candidate || !final ? '待定稿' : '已定稿'}`),
              h('small', { className: 'dsh-tp-muted' }, `目标语言：${unit.targetLanguage}${unit.sourceVersion > 1 ? ` · 原文版本 ${unit.sourceVersion}` : ''}`),
              h(TextUnitOpenLinks, { unit, session, objects, objectAssets, visible, navigationRevision })),
            h('div', { className: 'dsh-tp-record-pair' },
              h('div', { className: 'dsh-tp-record-source', 'aria-label': '原文' }, h('h4', null, '原文'), h(RecordObjectText, { text: unit.source, target, objects, objectAssets }),
                open && unit.sourceVersions.length > 1 ? h('div', null, ...unit.sourceVersions.slice(0, -1).map(source => h('section', { key: source.version },
                  h('small', { className: 'dsh-tp-muted' }, `历史原文版本 ${source.version}`), h('div', { className: 'dsh-tp-translation-text' }, source.text)))) : null),
              h('div', { className: 'dsh-tp-record-target', 'aria-label': '最终译文' }, h('h4', null, '最终译文'),
                final ? revisionView(final, 'final') : null,
                candidate ? revisionView(candidate, 'candidate') : null,
                !final && !candidate ? h('p', { className: 'dsh-tp-muted' }, '尚无最终译文。') : null,
                h('div', { className: 'dsh-tp-record-actions', hidden: !open },
                  pointed && !final ? h('p', { className: 'dsh-tp-muted' }, pointed.sourceVersion !== unit.sourceVersion ? `原最终版本 ${pointed.order}已过时 · 原文版本 ${pointed.sourceVersion}` : `最新尝试尚未完整，原自动最终版本 ${pointed.order}保留在历史中`) : null))),
            h('div', { className: 'dsh-tp-record-actions', hidden: !open }, h(RecordObjectEditor, { session, unit, objects, objectAssets }))
          )
        })))))
}
