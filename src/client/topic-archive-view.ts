import { h, react } from './react.js'
import type { TopicArchiveEntry, TopicArchiveKind, TopicArchiveSnapshot, TopicArchiveUserInput, ArchiveMutationResult } from '../memory/topic-archive.js'
import type { TopicArchiveStore } from './topic-archive-store.js'
import type { SessionStore } from './session-store.js'
import { TopicEvidenceView, type TopicTermsViewPort } from './topic-terms-view.js'

const kinds = { entity: '实体', fact: '事实', relation: '关系' } as const
const statuses = { proposal: '待确认', active: '生效', review_required: '待复核', disabled: '已停用' } as const
const origins = { inferred: '模型提案', source_checked: '原文依据', user_explicit: '用户采用' } as const
const storageLabels = { memory: '仅本次运行', saved: '已保存', conflict: '存在存储冲突', error: '保存失败' } as const
type TextEvent = { readonly currentTarget: { readonly value: string } }
interface ArchiveForm {
  readonly kind: TopicArchiveKind; readonly id: string | null; readonly expectedEntryVersion: number | null; readonly snapshotVersion: number
  readonly name: string; readonly aliases: string; readonly description: string; readonly title: string; readonly body: string
  readonly entityIds: readonly string[]; readonly sourceEntityId: string; readonly relation: string; readonly targetEntityId: string
}
function formFrom(snapshot: TopicArchiveSnapshot, kind: TopicArchiveKind, entry?: TopicArchiveEntry): ArchiveForm {
  return { kind, id: entry?.id ?? null, expectedEntryVersion: entry?.version ?? null, snapshotVersion: snapshot.version,
    name: entry?.kind === 'entity' ? entry.name : '', aliases: entry?.kind === 'entity' ? entry.aliases.join('\n') : '',
    description: entry?.kind === 'entity' || entry?.kind === 'relation' ? entry.description : '',
    title: entry?.kind === 'fact' ? entry.title : '', body: entry?.kind === 'fact' ? entry.body : '', entityIds: entry?.kind === 'fact' ? entry.entityIds : [],
    sourceEntityId: entry?.kind === 'relation' ? entry.sourceEntityId : '', relation: entry?.kind === 'relation' ? entry.relation : '', targetEntityId: entry?.kind === 'relation' ? entry.targetEntityId : '' }
}
function inputFrom(form: ArchiveForm): TopicArchiveUserInput {
  const identity = { id: form.id, expectedEntryVersion: form.expectedEntryVersion }
  return form.kind === 'entity' ? { ...identity, kind: form.kind, name: form.name.trim(), aliases: form.aliases.split(/\r?\n/).map(value => value.trim()).filter(Boolean), description: form.description } :
    form.kind === 'fact' ? { ...identity, kind: form.kind, title: form.title.trim(), body: form.body, entityIds: form.entityIds } :
      { ...identity, kind: form.kind, sourceEntityId: form.sourceEntityId, relation: form.relation.trim(), targetEntityId: form.targetEntityId, description: form.description }
}
function changedDraft(form: ArchiveForm, original: ArchiveForm): boolean {
  const { id: _formId, expectedEntryVersion: _formVersion, ...content } = inputFrom(form)
  const { id: _originalId, expectedEntryVersion: _originalVersion, ...baseline } = inputFrom(original)
  return JSON.stringify(content) !== JSON.stringify(baseline)
}
function entityLabel(snapshot: TopicArchiveSnapshot, id: string): string {
  const entity = snapshot.entries.find(entry => entry.id === id && entry.kind === 'entity')
  return entity?.kind === 'entity' ? entity.status === 'active' ? entity.name : `${entity.name}（${statuses[entity.status]}）` : `实体不可用（ID：${id}）`
}
function title(snapshot: TopicArchiveSnapshot, entry: TopicArchiveEntry): string {
  return entry.kind === 'entity' ? entry.name : entry.kind === 'fact' ? entry.title : `${entityLabel(snapshot, entry.sourceEntityId)} · ${entry.relation} · ${entityLabel(snapshot, entry.targetEntityId)}`
}
function mutationMessage(result: ArchiveMutationResult): true | string {
  if (result.status === 'save_failed') return '修改已保留在本次运行，但尚未保存到本地；输入仍保留，可重试保存。'
  if (result.status === 'stale') return '档案已变化，输入仍保留；请核对最新条目后重试。'
  if (result.status === 'requires_user_action') return '此条目已由用户采用，请通过编辑修改。'
  if (result.status === 'invalid') return '档案内容或关联实体无效；请检查必填内容与实体状态。'
  return result.status === 'updated' || result.status === 'unchanged' ? true : '操作未完成，请核对后重试。'
}
/** One mounted view per topic and type keeps drafts when the user changes entries or categories. */
export function TopicArchiveView({ sessions, terms, archive, ownerId, topicId, kind, active = true, evidenceContextKey, adoptionPending = false }: {
  readonly sessions: SessionStore; readonly terms: TopicTermsViewPort; readonly archive: TopicArchiveStore
  readonly ownerId: string; readonly topicId: string; readonly kind: TopicArchiveKind
  readonly active?: boolean | undefined; readonly evidenceContextKey?: string | undefined
  readonly adoptionPending?: boolean | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  react.useEffect(() => archive.subscribe(() => refresh(value => value + 1)), [archive])
  react.useEffect(() => sessions.subscribe(() => refresh(value => value + 1)), [sessions])
  const [query, setQuery] = react.useState(''), [status, setStatus] = react.useState('all')
  const [selected, setSelected] = react.useState<string | undefined>(undefined)
  const [form, setForm] = react.useState<ArchiveForm | undefined>(undefined), [original, setOriginal] = react.useState<ArchiveForm | undefined>(undefined)
  const drafts = react.useRef(new Map<string | null, { form: ArchiveForm; original: ArchiveForm }>())
  const [actionPending, setPending] = react.useState(false), [failure, setFailure] = react.useState<string | undefined>(undefined)
  const [copyNotice, setCopyNotice] = react.useState<string | undefined>(undefined)
  const [retry, setRetry] = react.useState<{ readonly kind: 'adopt' | 'disable'; readonly id: string } | undefined>(undefined)
  const [deletion, setDeletion] = react.useState<{ readonly snapshotVersion: number; readonly entry: TopicArchiveEntry } | undefined>(undefined)
  const alive = react.useRef(true), busy = react.useRef(false)
  react.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  react.useEffect(() => active ? archive.retain(ownerId, topicId) : undefined, [archive, ownerId, topicId, active])
  const readState = archive.getReadState(ownerId, topicId)
  if (readState.retired) return h('section', { className: 'dsh-tp-archive', 'aria-label': `${kinds[kind]}档案` },
    h('p', { role: 'status', className: 'dsh-tp-message' }, '此主题档案已删除，无法继续编辑。若主题删除尚未完成，请重试删除主题。'))
  if (!readState.snapshot) return h('section', { className: 'dsh-tp-archive', 'aria-label': `${kinds[kind]}档案` },
    h('p', { role: readState.status === 'error' ? 'alert' : 'status', className: 'dsh-tp-message' }, readState.error ?? '正在读取主题档案…'),
    readState.status === 'error' ? h('button', { type: 'button', onClick: () => { void archive.reloadAsync(ownerId, topicId).catch(() => {}) } }, '重试读取档案') : null)
  const snapshot = readState.snapshot, all = snapshot.entries.filter(entry => entry.kind === kind)
  const pending = actionPending || adoptionPending || readState.status !== 'ready'
  const note = [
    '同主题共用；快译不使用。关联实体须为生效条目。',
    `保存状态：${readState.status === 'error' ? '读取失败' : adoptionPending ? '正在采用…' : readState.status === 'loading' ? '正在刷新' : storageLabels[archive.getStatus(ownerId, topicId)]}`,
  ].join(' ')
  const entities = snapshot.entries.filter(entry => entry.kind === 'entity'), needle = query.trim().toLocaleLowerCase()
  const entries = all.filter(entry => (status === 'all' || status === entry.status) &&
    (entry.kind === 'entity' ? [entry.name, ...entry.aliases, entry.description] : entry.kind === 'fact' ? [entry.title, entry.body, ...entry.entityIds.map(id => entityLabel(snapshot, id))] :
      [entityLabel(snapshot, entry.sourceEntityId), entry.relation, entityLabel(snapshot, entry.targetEntityId), entry.description]).some(value => value.toLocaleLowerCase().includes(needle)))
  const entry = all.find(entry => entry.id === selected), dirty = form !== undefined && JSON.stringify(form) !== JSON.stringify(original)
  const deletedForm = Boolean(form?.id && !all.some(entry => entry.id === form.id))
  const deletedDrafts = [...drafts.current.values()].filter(draft => draft.form.id !== null && !all.some(entry => entry.id === draft.form.id) && changedDraft(draft.form, draft.original))
  const activeEntity = (id: string): boolean => entities.some(entry => entry.id === id && entry.status === 'active')
  const valid = form && (kind === 'entity' ? form.name.trim() : kind === 'fact' ? form.title.trim() && form.body.trim() && form.entityIds.every(activeEntity) : form.relation.trim() && activeEntity(form.sourceEntityId) && activeEntity(form.targetEntityId))
  function preserve(): void { if (form && original) drafts.current.set(form.id, { form, original }) }
  function showEntry(entry: TopicArchiveEntry): void {
    preserve(); const cached = drafts.current.get(entry.id)
    setSelected(entry.id); setForm(cached?.form); setOriginal(cached?.original); setFailure(undefined); setCopyNotice(undefined)
  }
  function edit(entry?: TopicArchiveEntry): void {
    preserve(); const cached = drafts.current.get(entry?.id ?? null), value = cached?.form ?? formFrom(snapshot, kind, entry)
    setSelected(entry?.id); setForm(value); setOriginal(cached?.original ?? value); setFailure(undefined); setCopyNotice(undefined)
  }
  function showDeletedDraft(id: string): void {
    preserve(); const cached = drafts.current.get(id)
    if (!cached) return
    setSelected(undefined); setForm(cached.form); setOriginal(cached.original); setFailure(undefined); setCopyNotice(undefined)
  }
  function copyDraft(): void {
    if (!form) return
    const text = kind === 'entity' ? `实体名称：${form.name}\n实体别名：${form.aliases}\n描述：${form.description}` :
      kind === 'fact' ? `事实标题：${form.title}\n事实内容：${form.body}\n关联实体：${form.entityIds.map(id => entityLabel(snapshot, id)).join('、')}` :
        `源实体：${entityLabel(snapshot, form.sourceEntityId)}\n关系：${form.relation}\n目标实体：${entityLabel(snapshot, form.targetEntityId)}\n描述：${form.description}`
    void run(async () => { await navigator.clipboard.writeText(text); if (alive.current) setCopyNotice('已复制编辑稿。'); return true })
  }
  async function run(action: () => Promise<boolean | string>): Promise<void> {
    if (busy.current) return
    busy.current = true; setPending(true); setFailure(undefined)
    try { const result = await action(); if (result !== true && alive.current) setFailure(typeof result === 'string' ? result : '操作未完成；档案可能已变化，请核对后重试。') }
    catch { if (alive.current) setFailure('操作未完成，请重试。') }
    finally { busy.current = false; if (alive.current) setPending(false) }
  }
  async function act(action: 'adopt' | 'disable', entry: TopicArchiveEntry): Promise<true | string> {
    const result = await archive.apply(ownerId, topicId, snapshot.version, { kind: action, id: entry.id, expectedEntryVersion: entry.version })
    if (alive.current) setRetry(result.status === 'save_failed' ? { kind: action, id: entry.id } : undefined)
    return mutationMessage(result)
  }
  function textField(label: string, key: 'name' | 'aliases' | 'description' | 'title' | 'body' | 'relation', multiline = false): unknown {
    return h('label', { className: 'dsh-tp-field' }, h('span', null, label), h(multiline ? 'textarea' : 'input', {
      value: form?.[key] ?? '', disabled: pending, rows: multiline ? 3 : undefined, 'aria-label': label, placeholder: key === 'aliases' ? '一行一个' : undefined,
      onChange: (event: TextEvent) => { const value = event.currentTarget.value; setForm(current => current ? { ...current, [key]: value } : current) },
    }))
  }
  function entitySelect(label: string, key: 'sourceEntityId' | 'targetEntityId'): unknown {
    const value = form?.[key] ?? ''
    return h('label', { className: 'dsh-tp-field' }, h('span', null, label), h('select', { 'aria-label': label, value, disabled: pending,
      onChange: (event: TextEvent) => { const value = event.currentTarget.value; setForm(current => current ? { ...current, [key]: value } : current) } },
    h('option', { value: '' }, '选择实体'),
    ...entities.map(entity => h('option', { key: entity.id, value: entity.id, disabled: entity.status !== 'active' }, entityLabel(snapshot, entity.id))),
    value && !entities.some(entity => entity.id === value) ? h('option', { value, disabled: true }, entityLabel(snapshot, value)) : null))
  }
  function factEntities(): unknown {
    const values = form?.entityIds ?? [], missing = values.filter(id => !entities.some(entry => entry.id === id))
    return h('fieldset', { className: 'dsh-tp-archive-entities', disabled: pending }, h('legend', null, '关联实体'),
      entities.length ? null : h('small', { className: 'dsh-tp-muted' }, '暂无实体，可先保存无关联事实。'),
      ...entities.map(entity => h('label', { key: entity.id }, h('input', { type: 'checkbox', checked: values.includes(entity.id), disabled: !values.includes(entity.id) && entity.status !== 'active',
        'aria-label': `关联实体：${entityLabel(snapshot, entity.id)}`, onChange: (event: { currentTarget: { checked: boolean } }) => {
          const checked = event.currentTarget.checked
          setForm(current => current ? { ...current, entityIds: checked ? [...current.entityIds, entity.id] : current.entityIds.filter(id => id !== entity.id) } : current)
        } }), entityLabel(snapshot, entity.id))),
      ...missing.map(id => h('label', { key: id }, h('input', { type: 'checkbox', checked: true, 'aria-label': `关联实体：${entityLabel(snapshot, id)}`,
        onChange: () => setForm(current => current ? { ...current, entityIds: current.entityIds.filter(value => value !== id) } : current) }), entityLabel(snapshot, id))))
  }
  function save(): void {
    if (!form || deletedForm) return
    const captured = form
    void run(async () => {
      const result = await archive.saveUserEntry(ownerId, topicId, captured.snapshotVersion, inputFrom(captured)), message = mutationMessage(result)
      if (!alive.current) return message
      if (result.status === 'save_failed' || message === true) {
        drafts.current.delete(captured.id)
        const baseline = formFrom(result.snapshot, kind, result.entry ?? undefined)
        setForm(current => current?.id === captured.id ? message === true && current === captured ? undefined : {
          ...current, id: result.entry?.id ?? captured.id, expectedEntryVersion: result.entry?.version ?? captured.expectedEntryVersion, snapshotVersion: result.snapshot.version,
        } : current)
        if (message === true) { setOriginal(baseline); setSelected(result.entry?.id ?? captured.id ?? undefined) }
      }
      return message
    })
  }
  return h('section', { className: 'dsh-tp-terms', 'aria-label': `主题${kinds[kind]}`, 'aria-busy': adoptionPending || readState.status === 'loading' },
    h('div', { className: 'dsh-tp-asset-toolbar' },
      h('div', { className: 'dsh-tp-unit-header' },
        h('div', { className: 'dsh-tp-asset-heading' }, h('h3', null, `主题${kinds[kind]}`), h('small', { className: 'dsh-tp-muted dsh-tp-asset-note', title: note }, note)),
        h('button', { type: 'button', disabled: pending || Boolean(form), onClick: () => edit() }, `新增${kinds[kind]}`)),
      h('div', { className: 'dsh-tp-asset-filters' },
        h('input', { type: 'search', 'aria-label': '搜索档案', placeholder: `搜索${kinds[kind]}`, value: query, onChange: (event: TextEvent) => setQuery(event.currentTarget.value) }),
        h('select', { 'aria-label': '档案状态', value: status, onChange: (event: TextEvent) => setStatus(event.currentTarget.value) }, h('option', { value: 'all' }, '全部状态'),
          ...Object.entries(statuses).map(([value, label]) => h('option', { key: value, value }, label)))),
      snapshot.version > 0 ? h('small', { className: 'dsh-tp-muted' }, h('time', { dateTime: snapshot.updatedAt }, `档案更新于 ${new Date(snapshot.updatedAt).toLocaleString()}`)) : null,
      archive.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-message' }, archive.getNotice()) : null,
      readState.status === 'error' ? h('p', { role: 'alert', className: 'dsh-tp-message' }, readState.error ?? '最新档案读取失败，当前显示上次读取内容。',
        h('button', { type: 'button', disabled: actionPending || adoptionPending, onClick: () => { void archive.reloadAsync(ownerId, topicId).catch(() => {}) } }, '重试读取档案')) : null,
      failure ? h('p', { role: 'alert', className: 'dsh-tp-message' }, failure) : null,
      retry && snapshot.entries.some(entry => entry.id === retry.id) ? h('button', { type: 'button', disabled: pending, onClick: () => {
        const entry = snapshot.entries.find(entry => entry.id === retry.id)!
        void run(() => act(retry.kind, entry))
      } }, '重试保存') : null,
      archive.getStatus(ownerId, topicId) === 'conflict' ? h('button', { type: 'button', disabled: pending, onClick: () => { void run(async () => { await archive.reloadAsync(ownerId, topicId); return true }) } }, '读取最新档案') : null),
    h('div', { className: 'dsh-tp-asset-columns' },
      h('div', { className: 'dsh-tp-asset-list', 'aria-label': '档案条目列表' },
        entries.length ? null : h('p', { className: 'dsh-tp-muted' }, all.length ? `没有匹配的${kinds[kind]}。` : `暂无${kinds[kind]}。`),
        ...entries.map(entry => h('article', { key: entry.id, className: 'dsh-tp-term',
          // 条目本身即详情入口：点击或回车展开右侧详情，条目内的操作按钮不触发。
          role: 'button', tabIndex: 0, 'aria-expanded': entry.id === selected, 'aria-current': entry.id === selected, 'data-archive-id': entry.id,
          onClick: () => showEntry(entry),
          onKeyDown: (event: { readonly key: string; readonly target?: unknown; readonly currentTarget?: unknown; preventDefault(): void }) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            // 焦点在条目内的操作按钮上时，按键交给按钮本身。
            if (event.target !== undefined && event.target !== event.currentTarget) return
            event.preventDefault(); showEntry(entry)
          } },
          h('div', { className: 'dsh-tp-unit-header' }, h('span', null, title(snapshot, entry)), h('span', { className: 'dsh-tp-muted', role: 'status' }, statuses[entry.status])),
          h('div', { className: 'dsh-tp-actions dsh-tp-version-actions', onClick: (event: { readonly target?: unknown; readonly currentTarget?: unknown; stopPropagation(): void }) => {
            // 只拦下操作按钮自身的事件；操作行的空白区域仍属于条目本身。
            if (event.target !== event.currentTarget) event.stopPropagation()
          } },
            entry.status !== 'active' ? h('button', { type: 'button', disabled: pending, onClick: () => { void run(() => act('adopt', entry)) } }, entry.status === 'disabled' ? '重新采用' : '采用') : null,
            entry.status === 'active' ? h('button', { type: 'button', disabled: pending, onClick: () => { void run(() => act('disable', entry)) } }, '停用') : null,
            h('button', { type: 'button', disabled: pending, onClick: () => setDeletion(structuredClone({ snapshotVersion: snapshot.version, entry })) }, '删除')))),
        deletedDrafts.length ? h('div', { 'aria-label': '已删除条目的草稿' }, h('small', { className: 'dsh-tp-muted' }, '已删除条目的草稿'),
          ...deletedDrafts.map(({ form }) => h('button', { key: form.id!, type: 'button', className: 'dsh-tp-asset-choice', disabled: pending,
            'aria-label': `查看已删除条目的草稿：${form.name || form.title || form.relation}`, onClick: () => showDeletedDraft(form.id!) }, form.name || form.title || form.relation))) : null),
      h('div', { className: 'dsh-tp-asset-details', 'aria-label': '档案详情' },
        form ? h('div', { className: 'dsh-tp-term-form', 'aria-label': form.id ? `编辑${kinds[kind]}` : `新增${kinds[kind]}表单` },
          h('h3', null, `${form.id ? '编辑' : '新增'}${kinds[kind]}`),
          deletedForm ? h('p', { className: 'dsh-tp-message', role: 'status' }, '条目已删除，编辑稿保留供复制。') : null,
          copyNotice ? h('p', { className: 'dsh-tp-muted', role: 'status' }, copyNotice) : null,
          kind === 'entity' ? [textField('实体名称', 'name'), textField('实体别名', 'aliases', true), textField('描述', 'description', true)] :
            kind === 'fact' ? [textField('事实标题', 'title'), textField('事实内容', 'body', true), factEntities()] :
              [entitySelect('源实体', 'sourceEntityId'), textField('关系', 'relation'), entitySelect('目标实体', 'targetEntityId'), textField('描述', 'description', true)],
          form.snapshotVersion !== snapshot.version ? h('button', { type: 'button', disabled: pending || (form.id !== null && !all.some(entry => entry.id === form.id)), onClick: () => {
            const current = all.find(entry => entry.id === form.id), baseline = formFrom(snapshot, kind, current)
            setForm({ ...form, expectedEntryVersion: current?.version ?? null, snapshotVersion: snapshot.version }); setOriginal(baseline); setFailure(undefined)
          } }, '继续基于最新版本编辑') : null,
          h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending || deletedForm || !dirty || !valid, onClick: save }, pending ? '正在保存…' : '保存并采用'),
            deletedForm ? h('button', { type: 'button', disabled: pending, onClick: copyDraft }, '复制编辑稿') : null,
            h('button', { type: 'button', disabled: pending, onClick: () => { drafts.current.delete(form.id); setForm(undefined); setOriginal(undefined) } }, '取消')),
        ) : entry ? h('div', { className: 'dsh-tp-term-details' },
          h('div', { className: 'dsh-tp-asset-detail-header' },
            h('h3', null, title(snapshot, entry)),
            h('button', { type: 'button', disabled: pending, onClick: () => edit(entry) }, '编辑')),
          h('div', { className: 'dsh-tp-muted' }, `${statuses[entry.status]} · ${entry.acceptance ? entry.origin === 'inferred' ? '模型推断 · 用户已采纳' : `${origins[entry.origin]} · 用户已采纳` : origins[entry.origin]} · 条目版本 ${entry.version}`),
          entry.kind === 'entity' ? [h('div', null, `别名：${entry.aliases.join('、') || '无'}`), h('div', { className: 'dsh-tp-translation-text' }, entry.description)] :
            entry.kind === 'fact' ? [h('div', { className: 'dsh-tp-translation-text' }, entry.body), h('div', null, `关联实体：${entry.entityIds.map(id => entityLabel(snapshot, id)).join('、') || '无'}`)] :
              [h('div', null, `源实体：${entityLabel(snapshot, entry.sourceEntityId)}`), h('div', null, `关系：${entry.relation}`), h('div', null, `目标实体：${entityLabel(snapshot, entry.targetEntityId)}`), h('div', { className: 'dsh-tp-translation-text' }, entry.description)],
          ...entry.evidence.map((reference, index) => h(TopicEvidenceView, { key: `${ownerId}:${topicId}:${entry.id}:${entry.version}:${index}`, sessions, terms, snapshot, reference, active, contextKey: evidenceContextKey })),
        ) : h('p', { className: 'dsh-tp-muted' }, `点击左侧${kinds[kind]}条目查看详情。`))),
    deletion ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '删除主题档案确认' },
      h('p', null, `删除“${title(snapshot, deletion.entry)}”？同主题全部会话共用此条目。${deletion.entry.kind === 'entity' ? '引用此实体的事实和关系将标为待复核。' : ''}`),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending, onClick: () => { void run(async () => {
        const removed = await archive.deleteEntryAsync(ownerId, topicId, deletion.entry.id, deletion.snapshotVersion, deletion.entry.version)
        if (removed && alive.current) {
          drafts.current.delete(deletion.entry.id)
          setForm(current => current?.id === deletion.entry.id ? undefined : current)
          setOriginal(current => current?.id === deletion.entry.id ? undefined : current)
          setSelected(current => current === deletion.entry.id ? undefined : current)
          setDeletion(current => current === deletion ? undefined : current)
        }
        return removed ? true : '删除未完成，档案可能已变化；请核对后重新确认。'
      }) } }, '确认删除档案'), h('button', { type: 'button', disabled: pending, onClick: () => setDeletion(undefined) }, '取消'))) : null)
}
