import { ReferenceEvidenceView } from './reference-view.js'
import { h, react } from './react.js'
import { resolveTermEvidence, type TopicTermSnapshot, type TopicTerm, type TopicTermUserInput, type TermMutationResult, type TermEvidenceRef, type UnitEvidenceRef, type TermEvidenceFact } from '../memory/topic-terms.js'
import type { SessionStore, HistoryStatus } from './session-store.js'
import { isTextUnit } from './translation-history.js'
import { isDocumentEvidenceUnloaded } from './document-evidence.js'
import { buildTopicTermsJsonExport, buildTopicTermsMarkdownExport, type TopicTermsExport, type TopicTermsExportSnapshot } from './topic-terms-export.js'
import type { EvidenceReadResult } from '../shared/translation-evidence.js'

/** User editing and adoption record real browser actions, separate from model commands. */
export interface TopicTermsViewPort {
  getSnapshot(ownerId: string, topicId: string): TopicTermSnapshot
  subscribe(listener: () => void): () => void
  readReferenceAsync?(ownerId:string,topicId:string,ref:import('../shared/reference-memory.js').ReferenceEvidenceRef):Promise<import('../shared/reference-memory.js').ReferenceText|undefined>
  readEvidence(sessionId: string, unitId: string): TermEvidenceFact | undefined
  readEvidenceAsync?(ownerId: string, topicId: string, reference: TermEvidenceRef): Promise<EvidenceReadResult>
  getNotice(): string | undefined
  getStatus(ownerId: string, topicId: string): HistoryStatus
  reload(ownerId: string, topicId: string): boolean
  saveUserTerm(ownerId: string, topicId: string, expectedVersion: number, input: TopicTermUserInput): Promise<TermMutationResult>
  apply(ownerId: string, topicId: string, expectedVersion: number,
    command: { readonly kind: 'adopt' | 'disable'; readonly id: string; readonly expectedEntryVersion: number }): Promise<TermMutationResult>
}
const labels = { proposal: '待确认', active: '生效', conflict: '有冲突', review_required: '待复核', disabled: '已停用' } as const
const origins = { inferred: '模型提案', source_checked: '原文依据', reference_derived: '参考资料（主模型解读）', user_explicit: '用户采用' } as const
const storageLabels = { memory: '仅本次运行', saved: '已保存', conflict: '存在存储冲突', error: '保存失败' } as const
function evidenceBody(terms: TopicTermsViewPort, snapshot: TopicTermSnapshot, ref: TermEvidenceRef): string | undefined {
  return resolveTermEvidence(snapshot, ref, (sessionId, unitId) => terms.readEvidence(sessionId, unitId))
}
/** The same precise reference viewer is shared by terminology and structured archives. */
function UnitEvidenceView({ sessions, terms, snapshot, reference, active = true, contextKey = '' }: {
  readonly sessions: SessionStore; readonly terms: TopicTermsViewPort; readonly snapshot: { readonly ownerId: string; readonly topicId: string }
  readonly reference: UnitEvidenceRef; readonly active?: boolean; readonly contextKey?: string
}): unknown {
  const [open, setOpen] = react.useState(false)
  const [loaded, setLoaded] = react.useState<{ readonly key: string; readonly result: EvidenceReadResult } | undefined>(undefined)
  const [pendingKey, setPendingKey] = react.useState<string | undefined>(undefined)
  const generation = react.useRef(0)
  const candidate = sessions.getSession(reference.sessionId)
  const session = candidate?.topicId === snapshot.topicId && !sessions.isSessionDeleted(candidate.id) ? candidate : undefined
  const unit = session ? sessions.getTranslationHistory(session.id)?.units.find(unit => unit.id === reference.unitId) : undefined
  const revision = reference.revisionId && unit && isTextUnit(unit) ? unit.revisions.find(revision => revision.id === reference.revisionId) : undefined
  const body = resolveTermEvidence(snapshot, reference, (sessionId, unitId) => terms.readEvidence(sessionId, unitId))
  const unloaded = isDocumentEvidenceUnloaded(sessions, snapshot, reference)
  const selection = sessions.getTranslationHistory(reference.sessionId)?.events.filter(event => event.type === 'final.selected' && event.unitId === reference.unitId).at(-1)
  const identity = JSON.stringify([snapshot.ownerId, snapshot.topicId, reference, candidate?.ownerId, candidate?.topicId,
    sessions.isSessionDeleted(reference.sessionId), sessions.getStatus(reference.sessionId), unit?.sourceVersion, unit?.final, selection?.id, active, contextKey])
  const currentIdentity = react.useRef(identity)
  currentIdentity.current = identity
  react.useEffect(() => {
    generation.current++; setOpen(false); setLoaded(undefined); setPendingKey(undefined)
    return () => { generation.current++ }
  }, [identity, terms])
  const result = loaded?.key === identity ? loaded.result : undefined
  const pending = pendingKey === identity
  const state = result?.status ?? (body !== undefined ? 'ready' : unloaded ? 'unloaded' : candidate && candidate.topicId !== snapshot.topicId ? 'forbidden' : 'missing')
  const visibleBody = result?.status === 'ready' ? result.text : body
  const statusLabels = { ready: '来源已加载', unloaded: '来源尚未加载', missing: '来源已缺失或变化', corrupt: '来源完整性校验失败', forbidden: '无权读取此来源' } as const
  const title = `${session?.name ?? '已删除会话'} · ${unit ? `${isTextUnit(unit) ? '文本' : '文档'} ${unit.order}` : '来源不可用'}${revision ? ` · 版本 ${revision.order}` : ''} · ${reference.kind === 'source' ? '原文' : '最终译文'}${reference.role === 'example' ? '（示例）' : ''}`
  async function toggle(reload = false): Promise<void> {
    if (!active || pending) return
    if (open && !reload) { generation.current++; setOpen(false); return }
    setOpen(true)
    if ((!reload && result) || !terms.readEvidenceAsync) return
    const captured = identity, ticket = ++generation.current
    setPendingKey(captured)
    try {
      const read = await terms.readEvidenceAsync(snapshot.ownerId, snapshot.topicId, structuredClone(reference))
      if (ticket === generation.current && currentIdentity.current === captured) setLoaded({ key: captured, result: read })
    } catch {
      if (ticket === generation.current && currentIdentity.current === captured) setLoaded({ key: captured,
        result: { status: 'unloaded', request: null, reason: 'connection_unavailable' } })
    } finally {
      if (ticket === generation.current && currentIdentity.current === captured) setPendingKey(undefined)
    }
  }
  return h('div', { className: 'dsh-tp-term-evidence', 'data-evidence-state': state },
    h('span', { className: 'dsh-tp-muted' }, title),
    h('button', { type: 'button', disabled: !active || pending || (!terms.readEvidenceAsync && body === undefined), 'aria-expanded': open,
      onClick: () => { void toggle() } }, pending ? '正在加载来源…' : open ? '收起来源' : state === 'ready' ? '查看来源' : terms.readEvidenceAsync ? '加载来源片段' : unloaded ? '文档依据尚未加载' : '依据已变化或不可用'),
    open ? h('small', { className: 'dsh-tp-muted', role: 'status' }, pending ? '正在读取准确来源范围。' : statusLabels[state]) : null,
    open && !pending && state === 'ready' && visibleBody !== undefined ? h('div', { className: 'dsh-tp-translation-text' }, visibleBody) : null,
    open && result?.status === 'unloaded' ? h('p', { className: 'dsh-tp-muted' }, result.reason === 'range_required'
      ? '整份依据超过单次读取上限；此处只读取已明确引用的有界片段，未截断为全文。'
      : '来源暂未取得，可重试；此状态不表示依据已失效。') : null,
    open && result && result.status !== 'ready' ? h('button', { type: 'button', disabled: pending || !active,
      onClick: () => { void toggle(true) } }, '重新查阅来源') : null,
  )
}
function TermRow({ entry, selected, pending, onAction, onDelete, onDetails }: {
  readonly entry: TopicTerm; readonly selected: boolean; readonly pending: boolean
  readonly onAction: (kind: 'adopt' | 'disable', entry: TopicTerm) => void
  readonly onDelete: (entry: TopicTerm) => void; readonly onDetails: () => void
}): unknown {
  return h('article', { className: 'dsh-tp-term', 'aria-label': `术语 ${entry.sourceForms.join('、')}`, 'aria-current': selected },
    h('div', { className: 'dsh-tp-unit-header' }, h('span', null, `${entry.sourceForms.join('、')} → ${entry.preferred}`), h('span', { className: 'dsh-tp-muted', role: 'status' }, labels[entry.status])),
    h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
      entry.status !== 'active' ? h('button', { type: 'button', disabled: pending, onClick: () => onAction('adopt', entry) }, entry.status === 'disabled' ? '重新采用' : '采用') : null,
      entry.status === 'active' ? h('button', { type: 'button', disabled: pending, onClick: () => onAction('disable', entry) }, '停用') : null,
      h('button', { type: 'button', disabled: pending, onClick: () => onDelete(entry) }, '删除'),
      h('button', { type: 'button', disabled: pending, 'aria-expanded': selected, onClick: onDetails }, '详情'),
    ),
  )
}
interface TermForm {
  readonly id: string | null; readonly expectedEntryVersion: number | null; readonly snapshotVersion: number
  readonly sourceLanguage: string; readonly targetLanguage: string; readonly sourceForms: string; readonly aliases: string
  readonly sense: string; readonly preferred: string; readonly forbidden: string
}
function formFrom(snapshot: TopicTermSnapshot, entry?: TopicTerm, targetLanguage = '中文'): TermForm {
  return { id: entry?.id ?? null, expectedEntryVersion: entry?.version ?? null, snapshotVersion: snapshot.version,
    sourceLanguage: entry?.sourceLanguage ?? '', targetLanguage: entry?.targetLanguage ?? targetLanguage, sourceForms: entry?.sourceForms.join('\n') ?? '',
    aliases: entry?.aliases.join('\n') ?? '', sense: entry?.sense ?? '', preferred: entry?.preferred ?? '', forbidden: entry?.forbidden.join('\n') ?? '' }
}
function splitLines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) }
function mutationMessage(result: TermMutationResult): true | string {
  if (result.status === 'conflict') return '请先停用或处理同范围的冲突条目，再保存或采用此术语。'
  if (result.status === 'stale') return '术语已变化，输入仍保留；请核对最新条目后重试。'
  if (result.status === 'invalid') return '术语内容或来源无效，未修改此条目。'
  return result.status === 'updated' || result.status === 'unchanged' ? true : '操作未完成，请核对后重试。'
}
export function TopicTermsView({ sessions, terms, ownerId, topicId, topicName, onDelete, onExport, bridgeReason, onReconnect, hideExport = false, targetLanguage, active = true, evidenceContextKey }: {
  readonly sessions: SessionStore; readonly terms: TopicTermsViewPort; readonly ownerId: string; readonly topicId: string; readonly topicName: string
  readonly onDelete: (snapshot: TopicTermSnapshot, entry: TopicTerm) => Promise<boolean>; readonly onExport: (result: TopicTermsExport) => void
  readonly bridgeReason?: string | undefined; readonly onReconnect?: (() => void) | undefined
  readonly hideExport?: boolean | undefined
  readonly targetLanguage?: string | undefined
  readonly active?: boolean | undefined; readonly evidenceContextKey?: string | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  react.useEffect(() => terms.subscribe(() => refresh(value => value + 1)), [terms])
  react.useEffect(() => sessions.subscribe(() => refresh(value => value + 1)), [sessions])
  const [query, setQuery] = react.useState('')
  const [status, setStatus] = react.useState<string>('all')
  const [selected, setSelected] = react.useState<string | undefined>(undefined)
  const [form, setForm] = react.useState<TermForm | undefined>(undefined)
  const [original, setOriginal] = react.useState<TermForm | undefined>(undefined)
  const [descriptionOpen, setDescriptionOpen] = react.useState(false)
  const drafts = react.useRef(new Map<string | null, { form: TermForm; original: TermForm }>())
  const [pending, setPending] = react.useState(false)
  const [failure, setFailure] = react.useState<string | undefined>(undefined)
  const [deletion, setDeletion] = react.useState<{ readonly snapshot: TopicTermSnapshot; readonly entry: TopicTerm } | undefined>(undefined)
  const alive = react.useRef(true), busy = react.useRef(false)
  react.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const snapshot = terms.getSnapshot(ownerId, topicId)
  const scopedSession = sessions.getActiveSession(ownerId)
  const scopedLanguage = targetLanguage ?? (scopedSession?.topicId === topicId ? scopedSession.targetLanguage :
    sessions.getAvailableSessions(ownerId).find(session => session.topicId === topicId)?.targetLanguage) ?? sessions.getSettings().targetLanguage
  const note = [
    '同主题共用；快译不使用。',
    sessions.getSettings().rememberHistory ? '已开启历史保存；主题术语保存在此设备。' : '已保存的术语保留；后续修改仅保留在本次运行。',
    `保存状态：${storageLabels[terms.getStatus(ownerId, topicId)]}`,
  ].join(' ')
  const needle = query.trim().toLocaleLowerCase()
  const entries = snapshot.entries.filter(entry => (status === 'all' || status === entry.status) &&
    [entry.preferred, entry.sense, ...entry.sourceForms, ...entry.aliases, ...entry.forbidden].some(value => value.toLocaleLowerCase().includes(needle)))
  const entry = snapshot.entries.find(entry => entry.id === selected)
  const dirty = form !== undefined && JSON.stringify(form) !== JSON.stringify(original)
  const validForm = form && splitLines(form.sourceForms).length > 0 && form.preferred.trim() && form.targetLanguage.trim()
  function preserveForm(): void { if (form && original) drafts.current.set(form.id, { form, original }) }
  function showEntry(entry: TopicTerm): void {
    preserveForm(); const draft = drafts.current.get(entry.id)
    setForm(draft?.form); setOriginal(draft?.original); setDescriptionOpen(!!draft?.form.sense.trim()); setSelected(entry.id); setFailure(undefined)
  }
  function startEdit(entry?: TopicTerm): void {
    preserveForm(); const draft = drafts.current.get(entry?.id ?? null), value = draft?.form ?? formFrom(snapshot, entry, scopedLanguage)
    setForm(value); setOriginal(draft?.original ?? value); setDescriptionOpen(!!value.sense.trim()); setSelected(entry?.id); setFailure(undefined)
  }
  react.useEffect(() => terms.subscribe(() => {
    const current = terms.getSnapshot(ownerId, topicId)
    for (const id of drafts.current.keys()) if (id !== null && !current.entries.some(entry => entry.id === id)) drafts.current.delete(id)
    setForm(form => form?.id && !current.entries.some(entry => entry.id === form.id) ? undefined : form)
  }), [terms, ownerId, topicId])
  function formField(label: string, key: 'sourceLanguage' | 'targetLanguage' | 'sourceForms' | 'aliases' | 'sense' | 'preferred' | 'forbidden', multiline = false): unknown {
    return h('label', { className: 'dsh-tp-field' }, h('span', null, label), h(multiline ? 'textarea' : 'input', {
      value: form?.[key] ?? '', disabled: pending, rows: multiline ? 2 : undefined, 'aria-label': label,
      placeholder: multiline && key !== 'sense' ? '一行一个' : undefined,
      onChange: (event: { currentTarget: { value: string } }) => { const value = event.currentTarget.value; setForm(current => current ? { ...current, [key]: value } : current) },
    }))
  }
  function exportTerms(format: 'json' | 'markdown'): void {
    setFailure(undefined)
    try {
      const frozen = structuredClone(terms.getSnapshot(ownerId, topicId))
      const input: TopicTermsExportSnapshot = {
        topicName: sessions.getTopics(ownerId).find(topic => topic.id === topicId)?.name ?? topicName,
        snapshot: frozen, exportedAt: new Date().toISOString(), rememberHistory: sessions.getSettings().rememberHistory, storageStatus: terms.getStatus(ownerId, topicId),
        evidenceAvailability: frozen.entries.flatMap(entry => entry.evidence.map((ref, evidenceIndex) => {
          if (ref.kind === 'reference') return {entryId: entry.id, evidenceIndex, sessionName: null, unitOrder: null, revisionOrder: null, readable: false, sourceLabel:'参考资料：'+ref.referenceId+' / '+ref.segmentId, readability:'not_loaded' as const}
          const candidate = sessions.getSession(ref.sessionId)
          const session = candidate?.topicId === topicId && !sessions.isSessionDeleted(candidate.id) ? candidate : undefined
          const unit = session ? sessions.getTranslationHistory(session.id)?.units.find(unit => unit.id === ref.unitId) : undefined
          const revision = unit && isTextUnit(unit) ? unit.revisions.find(revision => revision.id === ref.revisionId) : undefined
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
    try { const result = await action(); if (result !== true && alive.current) setFailure(typeof result === 'string' ? result : '操作未完成；术语可能已变化，请核对后重试。') }
    catch { if (alive.current) setFailure('操作未完成，请重试。') }
    finally { busy.current = false; if (alive.current) setPending(false) }
  }
  return h('section', { className: 'dsh-tp-terms', 'aria-label': `主题术语：${topicName}` },
    h('div', { className: 'dsh-tp-asset-toolbar' },
      h('div', { className: 'dsh-tp-unit-header' },
        h('div', { className: 'dsh-tp-asset-heading' }, h('h3', null, '主题术语'), h('small', { className: 'dsh-tp-muted dsh-tp-asset-note', title: note }, note)),
        h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending || Boolean(form), onClick: () => startEdit() }, '新增术语'),
          hideExport ? null : h('button', { type: 'button', onClick: () => exportTerms('json') }, '导出 JSON'), hideExport ? null : h('button', { type: 'button', onClick: () => exportTerms('markdown') }, '导出 Markdown'))),
      h('div', { className: 'dsh-tp-asset-filters' },
        h('input', { type: 'search', 'aria-label': '搜索术语', placeholder: '搜索术语', value: query, onChange: (event: { currentTarget: { value: string } }) => setQuery(event.currentTarget.value) }),
        h('select', { 'aria-label': '术语状态', value: status, onChange: (event: { currentTarget: { value: string } }) => setStatus(event.currentTarget.value) },
          h('option', { value: 'all' }, '全部状态'), ...Object.entries(labels).map(([value, label]) => h('option', { key: value, value }, label)))),
      snapshot.version > 0 ? h('div', { className: 'dsh-tp-muted' }, h('time', { dateTime: snapshot.updatedAt }, `档案更新于 ${new Date(snapshot.updatedAt).toLocaleString()}`)) : null,
      bridgeReason ? h('small', { role: 'status', className: 'dsh-tp-muted' }, bridgeReason) : null,
      bridgeReason && onReconnect ? h('button', { type: 'button', onClick: onReconnect }, '重新连接主会话') : null,
      terms.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, terms.getNotice()) : null,
      terms.getStatus(ownerId, topicId) === 'conflict' ? h('button', { type: 'button', disabled: pending, onClick: () => { if (!terms.reload(ownerId, topicId)) setFailure('最新主题术语无法读取，当前内容保留。') } }, '读取最新术语') : null,
      failure ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, failure) : null,
    ),
    h('div', { className: 'dsh-tp-asset-columns' },
      h('div', { className: 'dsh-tp-asset-list', 'aria-label': '术语条目列表' },
        entries.length === 0 ? h('p', { className: 'dsh-tp-muted' }, snapshot.entries.length === 0 ? '暂无术语。' : '没有匹配的术语。') : null,
        ...entries.map(entry => h(TermRow, { key: entry.id, entry, selected: selected === entry.id, pending,
          onAction: (kind: 'adopt' | 'disable', entry: TopicTerm) => { void run(async () => mutationMessage(await terms.apply(ownerId, topicId, snapshot.version, { kind, id: entry.id, expectedEntryVersion: entry.version }))) },
          onDelete: (entry: TopicTerm) => setDeletion(structuredClone({ snapshot, entry })),
          onDetails: () => showEntry(entry),
        }))),
      h('div', { className: 'dsh-tp-asset-details', 'aria-label': '术语详情' },
        form ? h('div', { className: 'dsh-tp-term-form', 'aria-label': form.id ? '编辑术语' : '新增术语表单' },
          h('h3', null, form.id ? '编辑术语' : '新增术语'),
          formField('原词', 'sourceForms', true), formField('译法', 'preferred'),
          h('small', { className: 'dsh-tp-muted' }, `目标语言：${form.targetLanguage}`),
          h('button', { type: 'button', disabled: pending, 'aria-expanded': descriptionOpen, onClick: () => setDescriptionOpen(value => !value) }, descriptionOpen ? '收起说明' : '添加说明（可选）'),
          descriptionOpen ? formField('说明', 'sense', true) : null,
          form.snapshotVersion !== snapshot.version ? h('button', { type: 'button', disabled: pending || (form.id !== null && !snapshot.entries.some(entry => entry.id === form.id)), onClick: () => {
            const current = form.id === null ? undefined : snapshot.entries.find(entry => entry.id === form.id)
            const baseline = formFrom(snapshot, current, scopedLanguage)
            setForm({ ...form, snapshotVersion: snapshot.version, expectedEntryVersion: current?.version ?? null }); setOriginal(baseline); setFailure(undefined)
          } }, '继续基于最新版本编辑') : null,
          h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending || !dirty || !validForm, onClick: () => { if (!form) return; const captured = form; void run(async () => {
            const result = await terms.saveUserTerm(ownerId, topicId, captured.snapshotVersion, { id: captured.id, expectedEntryVersion: captured.expectedEntryVersion,
              sourceLanguage: captured.sourceLanguage.trim() || null, targetLanguage: captured.targetLanguage.trim(), sourceForms: splitLines(captured.sourceForms),
              aliases: splitLines(captured.aliases), sense: captured.sense, preferred: captured.preferred.trim(), forbidden: splitLines(captured.forbidden) })
            const message = mutationMessage(result)
            if (message === true && alive.current) { drafts.current.delete(captured.id); setForm(undefined); setOriginal(undefined); setSelected(result.entry?.id ?? captured.id ?? undefined) }
            return message
          }) } }, pending ? '正在保存…' : '保存并采用'), h('button', { type: 'button', disabled: pending, onClick: () => { drafts.current.delete(form.id); setForm(undefined); setOriginal(undefined) } }, '取消')),
        ) : entry ? h('div', { className: 'dsh-tp-term-details' },
          h('h3', null, `${entry.sourceForms.join('、')} → ${entry.preferred}`), h('div', { className: 'dsh-tp-muted' }, `${labels[entry.status]} · ${entry.sourceLanguage ?? '未指定源语言'} → ${entry.targetLanguage} · ${origins[entry.origin]} · 条目版本 ${entry.version}`),
          h('button', { type: 'button', disabled: pending, onClick: () => startEdit(entry) }, '编辑'),
          entry.sense ? h('div', null, `说明：${entry.sense}`) : null, entry.aliases.length ? h('div', null, `别名：${entry.aliases.join('、')}`) : null,
          entry.forbidden.length ? h('div', null, `避免：${entry.forbidden.join('、')}`) : null,
          ...entry.evidence.map((reference, index) => h(TopicEvidenceView, { key: `${ownerId}:${topicId}:${entry.id}:${entry.version}:${index}`, sessions, terms, snapshot, reference, active, contextKey: evidenceContextKey })),
        ) : h('p', { className: 'dsh-tp-muted' }, '选择术语查看详情。'),
      ),
    ),
    deletion ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '删除主题术语确认' },
      h('p', null, `删除“${deletion.entry.sourceForms.join('、')} → ${deletion.entry.preferred}”？同主题全部会话共用此条目。`),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending, onClick: () => { void run(async () => {
        const removed = await onDelete(deletion.snapshot, deletion.entry)
        if (removed && alive.current) setDeletion(current => current === deletion ? undefined : current)
        return removed
      }) } }, pending ? '正在删除…' : '确认删除术语'), h('button', { type: 'button', disabled: pending, onClick: () => setDeletion(undefined) }, '取消')),
    ) : null,
  )
}

export function TopicEvidenceView(props: { readonly sessions: SessionStore; readonly terms: TopicTermsViewPort; readonly snapshot: {readonly ownerId: string; readonly topicId: string}; readonly reference: TermEvidenceRef; readonly active?: boolean; readonly contextKey?: string }): unknown {
  return props.reference.kind === 'reference' ? h(ReferenceEvidenceView, {reference:props.reference,active:props.active,read:props.terms.readReferenceAsync ? ()=>props.terms.readReferenceAsync!(props.snapshot.ownerId,props.snapshot.topicId,props.reference as import('../shared/reference-memory.js').ReferenceEvidenceRef) : undefined}) : h(UnitEvidenceView, props)
}
