import { h, react } from './react.js'
import type { OtherMemoryClient, OtherMemorySettingInput } from './other-memory-client.js'
import type { OtherMemoryEntry, OtherMemorySetting, OtherMemoryReference } from '../shared/other-memory.js'
import type { SessionStore } from './session-store.js'
import { referenceSegmentationComplete } from '../shared/reference-segmentation.js'

interface Props {
  readonly client: OtherMemoryClient; readonly store: SessionStore; readonly topicId: string
  readonly mainSessionId?: string | undefined; readonly active: boolean
}
const NEW = 'new'
function formOf(entry: OtherMemorySetting): OtherMemorySettingInput {
  return { id: entry.id, expectedVersion: entry.version, topicId: entry.topicId, title: entry.title, body: entry.body, enabled: entry.enabled }
}
function persistence(entry: OtherMemoryEntry): string { return entry.persistence === 'saved' ? '已保存' : '仅本次运行' }
function canSegment(entry: OtherMemoryReference): boolean { return entry.category === 'full_text' && entry.source.encoding === 'utf-8' && /\.(?:txt|text|md|markdown|csv|tsv|json|jsonl|log|rst)$/iu.test(entry.source.name) }
function fileLabel(entry: OtherMemoryReference): string {
  if (entry.category !== 'full_text') return '已停用的旧资料（仅打开／删除）'
  const progress = !canSegment(entry) ? '此格式仅可打开原件' : referenceSegmentationComplete(entry) ? `已分段 ${entry.segmentation!.ends.length} 段`
    : entry.segmentation?.ends.length ? `分段未完成（${entry.segmentation.ends.length} 段）` : '待主模型分段'
  return `原文／双语对照文件 · ${progress}`
}

/** Settings are editable text; references expose only their registered original files. */
export function OtherMemoryView({ client, store, topicId, mainSessionId, active }: Props): unknown {
  const [, refresh] = react.useState(0)
  const [selected, setSelected] = react.useState<string | undefined>(undefined)
  const [forms, setForms] = react.useState<Readonly<Record<string, OtherMemorySettingInput>>>({})
  const [pending, setPending] = react.useState(false)
  const [feedback, setFeedback] = react.useState<{ readonly text: string; readonly failure: boolean } | undefined>(undefined)
  const [deletion, setDeletion] = react.useState<OtherMemoryEntry | 'topic' | undefined>(undefined)
  const alive = react.useRef(true)
  react.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  react.useEffect(() => client.subscribe(() => refresh(value => value + 1)), [client])
  react.useEffect(() => store.subscribe(() => refresh(value => value + 1)), [store])
  react.useEffect(() => client.retain(topicId), [client, topicId])
  react.useEffect(() => { if (active) void client.refresh(topicId) }, [client, topicId, active])
  const entries = client.entries(topicId), status = client.getStatus(topicId)
  const settings = entries.filter((entry): entry is OtherMemorySetting => entry.kind === 'setting')
  const files = entries.filter((entry): entry is OtherMemoryReference => entry.kind === 'reference')
  const form = selected ? forms[selected] : undefined
  const stale = form?.id ? !settings.some(entry => entry.id === form.id && entry.version === form.expectedVersion) : false
  function update(patch: Partial<OtherMemorySettingInput>): void {
    if (selected && form) setForms(current => ({ ...current, [selected]: { ...form, ...patch } }))
  }
  function edit(entry?: OtherMemorySetting): void {
    const key = entry?.id ?? NEW
    setForms(current => current[key] ? current : { ...current, [key]: entry ? formOf(entry) : { id: null, expectedVersion: null, topicId, title: '', body: '', enabled: true } })
    setSelected(key); setFeedback(undefined)
  }
  function discard(key: string): void { setForms(current => { const next = { ...current }; delete next[key]; return next }); setSelected(undefined) }
  async function run(action: () => Promise<string | void>): Promise<void> {
    if (pending) return
    setPending(true); setFeedback(undefined)
    try { const text = await action(); if (alive.current && text) setFeedback({ text, failure: false }) }
    catch (error) { if (alive.current) setFeedback({ text: (error as Error).message, failure: true }) }
    finally { if (alive.current) setPending(false) }
  }
  async function save(): Promise<string> {
    if (!form || !selected) return ''
    const saved = await client.putSetting(form)
    if (alive.current) discard(selected)
    return saved.persistence === 'saved' ? '设定已保存。' : '设定已在本次运行生效，尚未持久保存。'
  }
  async function confirmDelete(): Promise<string> {
    if (!deletion) return ''
    if (deletion === 'topic') await client.clearTopic(topicId)
    else await client.remove(deletion)
    if (alive.current) { setDeletion(undefined); if (deletion !== 'topic' && selected === deletion.id) discard(selected) }
    return deletion === 'topic' ? '本主题其他记忆已清空，用户级设定保留。' : '条目已删除。'
  }
  return h('div', { className: 'dsh-tp-other-memory', 'aria-label': '其他记忆' },
    h('div', { className: 'dsh-tp-unit-header' },
      h('p', { className: 'dsh-tp-muted' }, '启用的用户级和主题级设定会完整提供给本主题普通翻译。参考文件仅在本主题登记。'),
      h('div', { className: 'dsh-tp-actions' },
        h('button', { type: 'button', disabled: pending || status.loading, onClick: () => { void client.refresh(topicId) } }, status.loading ? '正在刷新…' : '刷新其他记忆'),
        h('button', { type: 'button', disabled: pending || !status.ready || !entries.some(entry => entry.topicId === topicId), onClick: () => setDeletion('topic') }, '清空本主题其他记忆'))),
    !store.getSettings().rememberHistory ? h('p', { className: 'dsh-tp-muted', role: 'status' }, '历史保存已关闭；新增与编辑仅保留在本次运行，已有保存副本保留。') : null,
    status.error ? h('p', { role: 'alert', className: 'dsh-tp-message' }, status.error) : null,
    feedback ? h('p', { role: feedback.failure ? 'alert' : 'status', className: 'dsh-tp-message' }, feedback.text) : null,
    h('section', { 'aria-label': '翻译设定' },
      h('p', { className: 'dsh-tp-muted' }, '启用设定会在每次普通翻译及重译时完整带入。请保持精简、准确，保留必要条件；具体译例放在原文／双语对照文件中。'),
      h('div', { className: 'dsh-tp-unit-header' }, h('h3', null, '翻译设定'), h('button', { type: 'button', disabled: pending || !status.ready, onClick: () => edit() }, '新建设定')),
      ...settings.map(entry => h('div', { key: entry.id, className: 'dsh-tp-other-memory-setting', 'data-memory-id': entry.id },
        h('div', { className: 'dsh-tp-unit-header' }, h('strong', null, entry.title), h('span', { className: 'dsh-tp-muted' }, `${entry.topicId === null ? '用户级' : '主题级'} · ${entry.enabled ? '启用' : '停用'} · ${persistence(entry)}`)),
        h('div', { className: 'dsh-tp-translation-text' }, entry.body),
        h('div', { className: 'dsh-tp-actions' },
          h('button', { type: 'button', disabled: pending, onClick: () => edit(entry) }, '编辑设定'),
          h('button', { type: 'button', disabled: pending, onClick: () => { void run(async () => { await client.putSetting({ ...formOf(entry), enabled: !entry.enabled }); return entry.enabled ? '设定已停用。' : '设定已启用。' }) } }, entry.enabled ? '停用设定' : '启用设定'),
          h('button', { type: 'button', disabled: pending, onClick: () => setDeletion(entry) }, '删除设定')))),
      status.ready && !settings.length ? h('p', { className: 'dsh-tp-muted' }, '尚无翻译设定。') : null,
      form && selected ? h('div', { className: 'dsh-tp-other-memory-form', 'aria-label': form.id ? '编辑翻译设定' : '新建翻译设定' },
        h('h4', null, form.id ? '编辑设定' : '新建设定'),
        h('label', null, '作用范围', h('select', { value: form.topicId === null ? 'user' : 'topic', disabled: pending, 'aria-label': '设定作用范围', onChange: (event: { currentTarget: { value: string } }) => update({ topicId: event.currentTarget.value === 'user' ? null : topicId }) },
          h('option', { value: 'topic' }, '当前主题'), h('option', { value: 'user' }, '用户级（当前资料库的所有主题）'))),
        h('label', null, '标题', h('input', { value: form.title, maxLength: 200, disabled: pending, 'aria-label': '设定标题', onChange: (event: { currentTarget: { value: string } }) => update({ title: event.currentTarget.value }) })),
        h('label', null, '完整要求', h('textarea', { value: form.body, rows: 7, disabled: pending, 'aria-label': '设定完整要求', placeholder: '填写可独立理解的翻译风格、格式或特殊处理要求；适用条件也写在这里。', onChange: (event: { currentTarget: { value: string } }) => update({ body: event.currentTarget.value }) })),
        h('label', { className: 'dsh-tp-checkbox' }, h('input', { type: 'checkbox', checked: form.enabled, disabled: pending, onChange: (event: { currentTarget: { checked: boolean } }) => update({ enabled: event.currentTarget.checked }) }), '启用此设定'),
        stale ? h('p', { role: 'status', className: 'dsh-tp-message' }, '条目已变化；当前编辑稿已保留。请核对最新条目后继续。') : null,
        h('div', { className: 'dsh-tp-actions' },
          h('button', { type: 'button', disabled: pending || stale || !form.title.trim() || !form.body.trim(), onClick: () => { void run(save) } }, pending ? '正在处理…' : '保存设定'),
          stale && settings.some(entry => entry.id === form.id) ? h('button', { type: 'button', disabled: pending, onClick: () => update({ expectedVersion: settings.find(entry => entry.id === form.id)!.version }) }, '基于最新版本继续编辑') : null,
          h('button', { type: 'button', disabled: pending, onClick: () => discard(selected) }, '取消编辑'))) : null),
    h('section', { 'aria-label': '主题参考文件' },
      h('h3', null, '主题参考文件'),
      h('div', { className: 'dsh-tp-other-memory-upload' },
        h('label', null, '登记文件', h('input', { type: 'file', disabled: pending || !status.ready || !client.canUpload(mainSessionId), 'aria-label': '登记主题参考文件', onChange: (event: { currentTarget: { files: FileList | null; value: string } }) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''
          if (file && mainSessionId) void run(async () => { await client.importFile(topicId, mainSessionId, file); return '原文／双语对照文件已登记。' })
        } }))),
      !mainSessionId ? h('p', { className: 'dsh-tp-muted' }, '选择主会话后可上传参考文件；已登记原件可直接打开。') : null,
      h('p', { className: 'dsh-tp-muted' }, '仅登记原文／双语对照文件。上传后主模型标记语义边界，全文分段完成后通过已配置的嵌入服务建立索引。原件保持不变，不自动推测双语对齐。其他学习资料请在主聊天提炼。非文本格式仍可打开原件。'),
      ...files.map(entry => h('div', { key: entry.id, className: 'dsh-tp-other-memory-file', 'data-memory-id': entry.id },
        h('div', null, h('strong', null, entry.source.name), h('span', { className: 'dsh-tp-muted' }, ` · ${fileLabel(entry)} · ${persistence(entry)}`)),
        h('div', { className: 'dsh-tp-actions' },
          canSegment(entry) ? h('button', { type: 'button', disabled: pending || !mainSessionId, onClick: () => { if (mainSessionId) void run(async () => { await client.requestSegmentation(entry, mainSessionId); return '分段请求已进入主会话；完成后可刷新查看。' }) } }, '请求主模型分段') : null,
          h('button', { type: 'button', disabled: pending, onClick: () => { void run(async () => { try { await client.open(entry) } catch (error) { throw new Error(`原始文件不可用：${(error as Error).message}`) } }) } }, '打开原始文件'),
          h('button', { type: 'button', disabled: pending, onClick: () => setDeletion(entry) }, '删除参考文件')))),
      status.ready && !files.length ? h('p', { className: 'dsh-tp-muted' }, '尚无主题参考文件。') : null),
    active && deletion ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '删除其他记忆确认' },
      h('p', null, deletion === 'topic' ? '清空本主题的全部设定与参考文件登记？用户级设定保留。' : `删除“${deletion.kind === 'setting' ? deletion.title : deletion.source.name}”？${deletion.topicId === null ? '此用户级设定供当前资料库的全部主题共用。' : ''}`),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending, onClick: () => { void run(confirmDelete) } }, '确认删除其他记忆'), h('button', { type: 'button', disabled: pending, onClick: () => setDeletion(undefined) }, '取消删除'))) : null)
}
