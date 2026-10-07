import { h, react } from './react.js'
import { downloadExport } from './browser-download.js'
import type { SessionStore } from './session-store.js'
import type { QuickTranslationClient } from './quick-translation.js'
import type { TextRevision } from './translation-history.js'
import { buildTopicBilingualExport, buildTopicFinalTextExport, type TopicTranslationExport, type TranslationExportSession, type TranslationExportTopic } from './translation-export.js'

interface EditDraft { readonly baseRevisionId: string; readonly original: string; readonly text: string }
interface PendingTopicExport {
  readonly topic: TranslationExportTopic; readonly entries: readonly TranslationExportSession[]
  readonly format: 'txt' | 'json'; readonly exportedAt: string; readonly result: TopicTranslationExport
}
function editable(revision: TextRevision): boolean {
  return Boolean(revision.text.trim()) && ['completed', 'failed', 'cancelled', 'interrupted'].includes(revision.status)
}
function projectTopicExport(request: Omit<PendingTopicExport, 'result'>, allowPartial = false): TopicTranslationExport {
  return (request.format === 'txt' ? buildTopicFinalTextExport : buildTopicBilingualExport)(
    request.topic, request.entries, request.exportedAt, { allowPartial })
}
export function MemoryTranslationRecordsView({ store, quick, ownerId, topicId }: {
  readonly store: SessionStore; readonly quick: QuickTranslationClient; readonly ownerId: string; readonly topicId: string
}): unknown {
  const [, refresh] = react.useState(0)
  const [selection, setSelection] = react.useState<{ sessionId: string; unitId: string } | undefined>(undefined)
  const [drafts, setDrafts] = react.useState(() => new Map<string, EditDraft>())
  const [message, setMessage] = react.useState<string | undefined>(undefined)
  const [exportRequest, setExportRequest] = react.useState<PendingTopicExport | undefined>(undefined)
  react.useEffect(() => store.subscribe(() => {
    refresh(value => value + 1)
    setDrafts(current => new Map([...current].filter(([key, draft]) => {
      const [sessionId, unitId] = JSON.parse(key) as [string, string]
      return !store.isSessionDeleted(sessionId) && Boolean(store.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)?.revisions.some(revision => revision.id === draft.baseRevisionId))
    })))
  }), [store])
  const sessions = store.getAvailableSessions(ownerId).filter(session => session.topicId === topicId && !store.isSessionDeleted(session.id))
  const groups = sessions.map(session => ({ session, units: store.getTranslationHistory(session.id)?.units ?? [] })).filter(group => group.units.length)
  const session = sessions.find(session => session.id === selection?.sessionId)
  const unit = session ? store.getTranslationHistory(session.id)?.units.find(unit => unit.id === selection?.unitId) : undefined
  const final = unit?.revisions.find(revision => revision.id === unit.final?.revisionId)
  const latest = unit?.revisions.at(-1)
  const candidate = latest?.accepted && latest.status === 'completed' && latest.text.trim() && latest.id !== final?.id ? latest : undefined
  const key = selection ? JSON.stringify([selection.sessionId, selection.unitId]) : ''
  const draft = drafts.get(key)
  const archived = session?.archivedAt !== null
  const base = final ?? [...(unit?.revisions ?? [])].reverse().find(editable)
  async function copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); setMessage('已复制。') } catch { setMessage('复制失败，请重试。') }
  }
  function deliverExport(result: TopicTranslationExport): void {
    try { downloadExport(result); setMessage('已向浏览器发起下载。'); setExportRequest(undefined) }
    catch { setMessage('无法启动下载，请重试。') }
  }
  function exportTopic(format: 'txt' | 'json'): void {
    setMessage(undefined); setExportRequest(undefined)
    try {
      const topic = store.getTopics(ownerId).find(candidate => candidate.id === topicId)
      if (!topic) throw new Error('Topic no longer available')
      const sessions = store.getAvailableSessions(ownerId).filter(session => session.topicId === topicId && !store.isSessionDeleted(session.id))
      if (!sessions.length) { setMessage('当前主题尚无译文记录。'); return }
      for (const session of sessions) if (!quick.finalizeForExport(session.id)) throw new Error('Cannot finalize export')
      const entries = sessions.map(session => {
        const history = store.getTranslationHistory(session.id)
        if (!history) throw new Error('Session no longer available')
        return { session, history }
      })
      if (!entries.some(entry => entry.history.units.length)) { setMessage('当前主题尚无译文记录。'); return }
      const frozen = structuredClone({ topic: { ownerId, topicId, topicName: topic.name }, entries, format, exportedAt: new Date().toISOString() })
      const result = projectTopicExport(frozen)
      if (!result.complete) { setExportRequest({ ...frozen, result }); return }
      if (!result.content) { setMessage('当前主题没有可导出的译文。'); return }
      deliverExport(result)
    } catch { setMessage('导出失败，当前内容仍保留。') }
  }
  const note = '原文只读；人工修改保存为新版本，再明确设为最终。'
  return h('section', { className: 'dsh-tp-terms', 'aria-label': '译文记录' },
    h('div', { className: 'dsh-tp-asset-toolbar' },
      h('div', { className: 'dsh-tp-unit-header' },
        h('div', { className: 'dsh-tp-asset-heading' }, h('h3', null, '译文记录'), h('small', { className: 'dsh-tp-muted dsh-tp-asset-note', title: note }, note)),
        h('div', { className: 'dsh-tp-actions' },
          h('button', { type: 'button', title: '导出当前主题（含归档会话）的全部最终译文，按会话序号和文本编号排序；未定稿项会先提示。', onClick: () => exportTopic('txt') }, '导出 TXT'),
          h('button', { type: 'button', title: '导出当前主题（含归档会话）的原文与最终译文对照，保留会话名称、备注、序号及缺项标记；不含草稿、修订历史或调用信息。', onClick: () => exportTopic('json') }, '导出 JSON'))),
      message ? h('p', { role: 'status', className: 'dsh-tp-muted' }, message) : null),
    exportRequest ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '导出译文确认' },
      h('h3', null, `导出主题「${exportRequest.topic.topicName}」`),
      h('p', null, `尚无最终译文：${exportRequest.result.missingUnits.map(unit => `${unit.sessionName} · 文本 ${unit.order}`).join('、')}。`),
      h('div', { className: 'dsh-tp-actions' },
        h('button', { type: 'button', disabled: exportRequest.result.exportedUnitIds.length === 0, onClick: () => deliverExport(projectTopicExport(exportRequest, true)) }, '仅导出已定稿'),
        h('button', { type: 'button', onClick: () => setExportRequest(undefined) }, '取消')),
    ) : null,
    h('div', { className: 'dsh-tp-asset-columns' },
      h('div', { className: 'dsh-tp-asset-list', 'aria-label': '译文条目列表' },
        groups.length === 0 ? h('p', { className: 'dsh-tp-muted' }, '尚无译文记录。') : null,
        ...groups.map(({ session, units }) => h('section', { key: session.id, 'aria-label': `会话译文：${session.name}` },
          h('h3', null, session.name), ...units.map(unit => h('button', { key: unit.id, type: 'button', className: 'dsh-tp-asset-choice',
            'aria-label': `${session.name} · 文本 ${unit.order}`, 'aria-current': selection?.sessionId === session.id && selection.unitId === unit.id,
            onClick: () => { setSelection({ sessionId: session.id, unitId: unit.id }); setMessage(undefined) } }, `文本 ${unit.order} · ${unit.final ? '已定稿' : '待定稿'}`))))),
      h('div', { className: 'dsh-tp-asset-details', 'aria-label': '译文详情' },
        unit && session ? h('div', null, h('h3', null, `${session.name} · 文本 ${unit.order}`),
          h('div', { className: 'dsh-tp-muted' }, `目标语言：${unit.targetLanguage}`),
          archived ? h('p', { className: 'dsh-tp-muted' }, '会话已归档，请先在翻译工作区恢复后编辑。') : null,
          h('h3', null, '原文'), h('div', { className: 'dsh-tp-translation-text' }, unit.source),
          h('h3', null, '最终译文'), final ? h('div', null,
            h('small', { className: 'dsh-tp-muted' }, `版本 ${final.order} · ${unit.final?.selection === 'user_fixed' ? '用户固定' : '自动最终'}`),
            h('div', { className: 'dsh-tp-translation-text' }, final.text),
            h('button', { type: 'button', onClick: () => { void copy(final.text) } }, '复制最终译文')) : h('p', { className: 'dsh-tp-muted' }, '尚无最终译文。'),
          candidate ? h('div', { className: 'dsh-tp-asset-candidate' }, h('h3', null, `候选 · 版本 ${candidate.order}`),
            h('div', { className: 'dsh-tp-translation-text' }, candidate.text),
            h('button', { type: 'button', disabled: archived, onClick: () => { setMessage(quick.selectFinal(session.id, unit.id, candidate.id) ? '已设为最终。' : '版本已变化，未设为最终。') } }, '设为最终')) : null,
          draft ? h('div', { className: 'dsh-tp-version-editor' },
            h('small', { className: 'dsh-tp-muted' }, `基于版本 ${unit.revisions.find(revision => revision.id === draft.baseRevisionId)?.order ?? '已失效'}保存为新版本；未调用模型。`),
            h('textarea', { 'aria-label': '编辑译文', value: draft.text, rows: 8, disabled: archived, onChange: (event: { currentTarget: { value: string } }) => {
              const text = event.currentTarget.value; setDrafts(current => new Map(current).set(key, { ...draft, text }))
            } }),
            h('div', { className: 'dsh-tp-actions' },
              h('button', { type: 'button', disabled: archived || !draft.text.trim() || draft.text === draft.original, onClick: () => {
                if (quick.saveManualRevision(session.id, unit.id, draft.baseRevisionId, draft.text)) {
                  setDrafts(current => { const next = new Map(current); next.delete(key); return next }); setMessage('已保存新候选版本；可设为最终。')
                } else setMessage('保存失败，编辑内容仍保留。')
              } }, '保存新版本'),
              h('button', { type: 'button', onClick: () => setDrafts(current => { const next = new Map(current); next.delete(key); return next }) }, '取消编辑')),
          ) : h('button', { type: 'button', disabled: archived || !base || !editable(base), onClick: () => { if (base) setDrafts(current => new Map(current).set(key, { baseRevisionId: base.id, original: base.text, text: base.text })) } }, '编辑译文'),
        ) : h('p', { className: 'dsh-tp-muted' }, '选择条目查看原文与最终译文。'),
      ),
    ),
  )
}
