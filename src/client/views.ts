import { styles } from './view-styles.js'
import { h, react } from './react.js'
import { ModelPicker } from './model-picker.js'
import { type ModelCatalog } from './models.js'
import { type QuickTranslationClient, type QuickRecord } from './quick-translation.js'
import { currentFinalRevision, isTextUnit, type TextUnit, type TextRevision } from './translation-history.js'
import { DocumentUnitView, TextUnitOpenLinks, type DocumentViewProps } from './document-unit-view.js'
import { allowPartialTranslationExport, type TranslationExport, type TranslationExportTopic, type TranslationExportSession } from './translation-export.js'
import { buildRecordObjectExportAsync, recordObjectPlainText } from './record-object-export.js'
import type { RecordObjectReference } from '../shared/record-objects.js'
import { RecordObjectText, type RecordObjectsProps } from './record-object-view.js'
import { type HistoryVersion, type SessionStore } from './session-store.js'
import { DEFAULT_SESSION_SETTINGS, validateSessionSettings, type LocalSession, type SessionSettings } from './sessions.js'
import { Menu, MenuGroup, MenuItemButton, IconChevronDownOutlineRegular, IconPanelLeftOutlineRegular, IconSendOutlineMedium } from './native-ui.js'
import { type TopicTermsViewPort } from './topic-terms-view.js'
import { downloadExport } from './browser-download.js'
import type { TopicBridgeClient } from './topic-bridge.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { NormalTranslationClient } from './normal-translation.js'
import type { TopicTermSnapshot, TopicTerm } from '../memory/topic-terms.js'
import type { TopicMemoryStore, TopicTermVersion } from './topic-memory-store.js'
import { createSessionReorder, type SessionDrop, type SessionPointerEvent } from './session-reorder.js'
export { MemoryAssetsView } from './memory-assets-view.js'

type TextEvent = { currentTarget: { value: string } }
type CheckEvent = { currentTarget: { checked: boolean } }
type FileEvent = { currentTarget: { files: FileList | null; value: string } }
interface StoreProps { readonly store: SessionStore }
interface TopicUiProps extends RecordObjectsProps, DocumentViewProps {
  readonly normal?: NormalTranslationClient | undefined
  readonly materials?: MaterialSubmissionsClient | undefined
  readonly topics?: TopicBridgeClient | undefined
  readonly terms?: (TopicTermsViewPort & TopicMemoryStore) | undefined
  readonly onDeleteTerm?: ((snapshot: TopicTermSnapshot, entry: TopicTerm) => Promise<boolean>) | undefined
  readonly onOpenAssets?: ((ownerId: string, topicId: string, sessionId?: string) => void) | undefined
}

function useStore(store: SessionStore): void {
  const [, update] = react.useState(0)
  react.useEffect(() => { const off = store.subscribe(() => update(value => value + 1)); update(value => value + 1); return off }, [store])
}
function useAsyncAction(): { readonly pending: boolean; readonly failure: string | undefined; readonly run: (action: () => Promise<boolean>, onSuccess?: () => void) => Promise<void> } {
  const [pending, setPending] = react.useState(false)
  const [failure, setFailure] = react.useState<string | undefined>(undefined)
  const lifetime = react.useRef({ mounted: false, generation: 0, busy: false })
  react.useEffect(() => {
    lifetime.current.mounted = true
    lifetime.current.busy = false
    setPending(false)
    return () => { lifetime.current.mounted = false; lifetime.current.busy = false; lifetime.current.generation += 1 }
  }, [])
  async function run(action: () => Promise<boolean>, onSuccess?: () => void): Promise<void> {
    if (!lifetime.current.mounted || lifetime.current.busy) return
    const generation = lifetime.current.generation
    const active = (): boolean => lifetime.current.mounted && lifetime.current.generation === generation
    lifetime.current.busy = true
    setPending(true); setFailure(undefined)
    try {
      const success = await action()
      if (active() && success) onSuccess?.()
    } catch {
      if (active()) setFailure('操作未完成，请重试。')
    } finally {
      if (active()) { lifetime.current.busy = false; setPending(false) }
    }
  }
  return { pending, failure, run }
}
function button(label: string, action: () => void, disabled = false): unknown { return h('button', { type: 'button', onClick: action, disabled }, label) }
function field(label: string, control: unknown, hint?: string): unknown { return h('label', { className: 'dsh-tp-field' }, h('span', null, label), control, hint ? h('small', { className: 'dsh-tp-muted' }, hint) : null) }
function modeSelect(value: LocalSession['mode'], action: (mode: LocalSession['mode']) => void): unknown {
  return h('select', { value, 'aria-label': '翻译模式', onChange: (event: TextEvent) => {
    if (event.currentTarget.value === 'quick' || event.currentTarget.value === 'normal') action(event.currentTarget.value)
  } }, h('option', { value: 'quick' }, '快译'), h('option', { value: 'normal' }, '普通'))
}
function storeNotice(store: SessionStore): unknown { return store.getNotice() ? h('div', { role: 'alert', className: 'dsh-tp-message' }, store.getNotice()) : null }

interface RevisionEdit { readonly sessionId: string; readonly unitId: string; readonly baseRevisionId: string; readonly text: string; readonly failure: string | null }
interface RevisionEditor {
  readonly drafts: ReadonlyMap<string, RevisionEdit>
  start(sessionId: string, unitId: string, baseRevisionId: string, text: string): void
  change(key: string, text: string): void
  save(key: string, finalize?: boolean): void
  cancel(key: string): void
}
function editKey(sessionId: string, unitId: string, revisionId: string): string { return JSON.stringify([sessionId, unitId, revisionId]) }

export function PanelRouter({ store, models, quick, normal, sessionId, topics, materials, terms, objects, objectAssets, documents, documentTasks, documentReviews, onDeleteTerm, onOpenAssets }: StoreProps & TopicUiProps & { readonly models: ModelCatalog; readonly quick: QuickTranslationClient; readonly sessionId?: string | undefined }): unknown {
  const [drafts, setDrafts] = react.useState<ReadonlyMap<string, RevisionEdit>>(() => new Map())
  react.useEffect(() => {
    const reconcile = (): void => setDrafts(current => {
      const kept = [...current].filter(([, edit]) => store.getSession(edit.sessionId) && store.getTranslationHistory(edit.sessionId)?.units
        .some(unit => unit.id === edit.unitId && unit.revisions.some(revision => revision.id === edit.baseRevisionId)))
      return kept.length === current.size ? current : new Map(kept)
    })
    const stop = store.subscribe(reconcile)
    reconcile()
    return stop
  }, [store])
  const editor: RevisionEditor = {
    drafts,
    start(sessionId, unitId, baseRevisionId, text) {
      if (quick.manualEditBlockedReason(sessionId, unitId, baseRevisionId) || !store.getSession(sessionId) || !store.getTranslationHistory(sessionId)?.units.some(unit => unit.id === unitId && unit.revisions.some(revision => revision.id === baseRevisionId))) return
      const key = editKey(sessionId, unitId, baseRevisionId)
      setDrafts(current => current.has(key) ? current : new Map(current).set(key, { sessionId, unitId, baseRevisionId, text, failure: null }))
    },
    change(key, text) { setDrafts(current => { const draft = current.get(key); return draft ? new Map(current).set(key, { ...draft, text, failure: null }) : current }) },
    cancel(key) { setDrafts(current => { const next = new Map(current); next.delete(key); return next }) },
    save(key, finalize = false) {
      const draft = drafts.get(key)
      if (!draft) return
      let saved = false
      try { saved = quick.saveManualRevision(draft.sessionId, draft.unitId, draft.baseRevisionId, draft.text, finalize) } catch { /* Keep the local edit available for retry. */ }
      setDrafts(current => {
        if (current.get(key) !== draft) return current
        const next = new Map(current)
        if (saved) next.delete(key)
        else next.set(key, { ...draft, failure: '保存失败，编辑内容仍保留。' })
        return next
      })
    },
  }
  return h('section', { className: 'dsh-tp dsh-tp-panel', 'aria-label': '翻译面板' }, h('style', null, styles),
    sessionId?.trim() ? h(WorkspaceView, { store, models, quick, normal, editor, topics, materials, terms, objects, objectAssets, documents, documentTasks, documentReviews, onDeleteTerm, onOpenAssets, ownerId: sessionId, key: sessionId })
      : h('p', { role: 'alert' }, '请在主窗口会话中打开翻译面板。'),
  )
}

interface ContextRequest { readonly id: string; readonly x: number; readonly y: number; readonly trigger?: HTMLElement | undefined; readonly exportFormat?: 'txt' | 'json' | undefined }
interface FrozenTranslationExport {
  readonly topic: TranslationExportTopic; readonly entries: readonly TranslationExportSession[]
  readonly scope: 'session' | 'topic'; readonly format: 'txt' | 'json'; readonly at: string
  readonly references: readonly RecordObjectReference[]
}
function projectTranslationExport(request: FrozenTranslationExport, documents: DocumentViewProps['documents']): Promise<TranslationExport> {
  return buildRecordObjectExportAsync({ ...request, exportedAt: request.at }, documents, true)
}
type WorkspaceDialog = { readonly kind: 'rename' | 'remark' | 'reload'; readonly id: string }
type ContextEvent = { preventDefault(): void; stopPropagation(): void; readonly clientX: number; readonly clientY: number; readonly currentTarget?: HTMLElement }

function sessionTitle(session: LocalSession): string {
  const label = session.remark ? `${session.name} · ${session.remark}` : session.name
  return session.legacyName ? `${label}\n旧名称：${session.legacyName}` : label
}
function sessionDisplayName(session: LocalSession): string { return session.remark || session.name }
function sessionLabel(session: LocalSession): unknown {
  return h('span', { className: 'dsh-tp-session-choice-name' }, sessionDisplayName(session))
}
type SessionClickEvent = { preventDefault(): void; stopPropagation(): void }
interface SessionSorting {
  readonly gesture: ReturnType<typeof createSessionReorder>
  props(id: string): Readonly<Record<string, unknown>>
  clicked(id: string, event?: SessionClickEvent): boolean
}
function useSessionSorting(store: SessionStore, ownerId: string): SessionSorting {
  const [drop, setDrop] = react.useState<SessionDrop | undefined>(undefined)
  const gesture = react.useMemo(() => createSessionReorder(setDrop, move => { store.moveSessionInDisplay(ownerId, move.id, move.targetId, move.after) }), [store, ownerId])
  react.useEffect(() => () => gesture.dispose(), [gesture])
  function clicked(id: string, event?: SessionClickEvent): boolean {
    if (!gesture.consumeClick(id)) return false
    event?.preventDefault(); event?.stopPropagation(); return true
  }
  return { gesture, clicked, props: id => ({
    'data-session-sort-id': id, 'data-session-dragging': drop?.id === id || undefined,
    'data-session-drop': drop?.targetId === id && drop.id !== id ? (drop.after ? 'after' : 'before') : undefined,
    onPointerDown: (event: SessionPointerEvent) => gesture.down(id, event),
    onClickCapture: (event: SessionClickEvent) => { clicked(id, event) },
  }) }
}

function ModePicker({ session, store }: StoreProps & { readonly session: LocalSession }): unknown {
  const [open, setOpen] = react.useState(false)
  return h(Menu, {
    open, onClose: () => setOpen(false), portal: true, align: 'end', compact: true, listClassName: 'dsh-tp-popup',
    anchor: h('button', { type: 'button', className: 'dsh-tp-compact-trigger', 'aria-label': '选择翻译模式', 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
      h('span', { className: 'dsh-tp-compact-label' }, session.mode === 'quick' ? '快译' : '普通'),
      h(IconChevronDownOutlineRegular, { size: 14, className: `dsh-tp-chevron${open ? ' dsh-tp-chevron-open' : ''}` }),
    ),
  },
    h(MenuItemButton, { disabled: true }, session.mode === 'quick' ? '快译（当前）' : '快译（普通会话不可降档）'),
    h(MenuItemButton, { disabled: session.mode === 'normal', onSelect: () => { if (store.updateSession(session.id, { mode: 'normal' })) setOpen(false) } }, session.mode === 'normal' ? '普通（当前）' : '升为普通'),
  )
}

function LanguagePicker({ session, store }: StoreProps & { readonly session: LocalSession }): unknown {
  const [open, setOpen] = react.useState(false)
  return h(Menu, {
    open, onClose: () => setOpen(false), portal: true, align: 'end', compact: true, listClassName: 'dsh-tp-popup',
    anchor: h('button', { type: 'button', className: 'dsh-tp-compact-trigger', 'aria-label': '选择目标语言', 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
      h('span', { className: 'dsh-tp-compact-label' }, session.targetLanguage || '目标语言'),
      h(IconChevronDownOutlineRegular, { size: 14, className: `dsh-tp-chevron${open ? ' dsh-tp-chevron-open' : ''}` }),
    ),
  }, ...['中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'].map(language => h(MenuItemButton, {
    key: language, onSelect: () => { store.updateSession(session.id, { targetLanguage: language }); setOpen(false) },
  }, language)), h('div', { className: 'dsh-tp dsh-tp-menu-content dsh-tp-language-custom' }, field('自定义目标语言', h('input', {
    value: session.targetLanguage, 'aria-label': '目标语言', onChange: (event: TextEvent) => { store.updateSession(session.id, { targetLanguage: event.currentTarget.value }) },
  }))))
}

function SessionPicker({ store, ownerId, current, open, onOpenChange: setOpen, contextOpen, onDismissContext, onContext, onContextKeys, creating, onCreate, onTopicAssets, sorting }: StoreProps & {
  readonly ownerId: string; readonly current: LocalSession | undefined
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void
  readonly contextOpen: boolean; readonly onDismissContext: () => void
  readonly onContext: (session: LocalSession, event: ContextEvent) => void
  readonly onContextKeys: (session: LocalSession, event: KeyboardEvent & { currentTarget: HTMLElement }) => void
  readonly creating: boolean; readonly onCreate: () => void
  readonly sorting: SessionSorting
  readonly onTopicAssets?: ((topic: { readonly id: string; readonly name: string }) => void) | undefined
}): unknown {
  const displayed = store.getDisplaySessions(ownerId)
  const sessions = displayed.filter(session => session.archivedAt === null)
  const archived = displayed.filter(session => session.archivedAt !== null)
  const topics = [...new Map(store.getTopics(ownerId).map(topic => [topic.id, topic])).values()]
  const assetTopic = topics.find(topic => topic.id === current?.topicId) ?? topics[0]
  function row(session: LocalSession, restore = false): unknown {
    return h('button', {
      type: 'button', role: 'menuitem', key: session.id, className: 'dsh-tp-session-choice', title: sessionTitle(session),
      ...sorting.props(session.id),
      'aria-label': `${restore ? '恢复归档会话' : '切换翻译会话'}：${sessionTitle(session)}`, 'aria-current': current?.id === session.id,
      onClick: (event?: SessionClickEvent) => { if (sorting.clicked(session.id, event)) return; if (restore && !store.archiveSession(ownerId, session.id, false)) return; if (!restore) store.openSession(ownerId, session.id); onDismissContext(); setOpen(false) },
      onContextMenu: (event: ContextEvent) => onContext(session, event),
      onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) onContextKeys(session, event)
      },
    }, sessionLabel(session), current?.id === session.id ? h('span', { 'aria-hidden': true }, '✓') : null)
  }
  return h('div', { className: 'dsh-tp-title-select' }, h(Menu, {
    open, onClose: () => { if (!contextOpen) setOpen(false) }, portal: true, compact: true, className: 'dsh-tp-title-anchor', listClassName: 'dsh-tp-popup',
    anchor: h('button', {
      type: 'button', className: 'dsh-tp-current-title', 'aria-label': current ? `当前翻译会话：${sessionDisplayName(current)}` : '选择翻译会话',
      title: current ? sessionTitle(current) : '选择翻译会话', 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => { onDismissContext(); setOpen(!open) },
      onPointerDown: (event: { stopPropagation(): void }) => { if (contextOpen) event.stopPropagation() },
      onContextMenu: current ? (event: ContextEvent) => onContext(current, event) : undefined,
      onKeyDown: current ? (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) onContextKeys(current, event)
      } : undefined,
    }, h('span', { className: 'dsh-tp-current-title-text' }, current ? sessionDisplayName(current) : '选择翻译会话'),
      h(IconChevronDownOutlineRegular, { size: 14, className: `dsh-tp-chevron${open ? ' dsh-tp-chevron-open' : ''}` }),
    ),
  }, h('div', { className: 'dsh-tp dsh-tp-menu-content', 'aria-label': '已有翻译会话',
    onPointerDown: (event: { stopPropagation(): void }) => { if (contextOpen) event.stopPropagation() },
  },
    onTopicAssets && assetTopic ? h('div', { role: 'group', 'aria-label': '记忆资产' },
      h('button', {
        type: 'button', role: 'menuitem', className: 'dsh-tp-session-choice dsh-tp-memory-assets-entry',
        key: assetTopic.id, title: `打开当前主题记忆资产：${assetTopic.name}`,
        'aria-label': `打开记忆资产：${assetTopic.name}`, 'data-topic-id': assetTopic.id,
        onClick: () => onTopicAssets(assetTopic),
      }, '记忆资产'), h('div', { role: 'separator', className: 'dsh-tp-session-divider' })) : null,
    h('div', { 'data-session-sort-list': true }, ...sessions.map(session => row(session))),
    archived.length ? h(MenuGroup, { label: '已归档（点击恢复）' }, h('div', { 'data-session-sort-list': true }, ...archived.map(session => row(session, true)))) : null,
    h('div', { role: 'separator', className: 'dsh-tp-session-divider' }),
    h('button', {
      type: 'button', role: 'menuitem', className: 'dsh-tp-session-add', title: '新建主题及首会话', 'aria-label': '新建主题及首会话', disabled: creating,
      onClick: onCreate,
    }, '+'),
  )))
}

function TranslationRecord({ record, quick, canRestore }: { readonly record: QuickRecord; readonly quick: QuickTranslationClient; readonly canRestore: boolean }): unknown {
  const status = { submitting: '正在提交…', running: '正在翻译…', completed: '译文', failed: '翻译失败', cancelled: '已取消', unknown: '执行结果未知' }[record.status]
  return h('article', { className: 'dsh-tp-translation', 'aria-label': `翻译记录：${status}` },
    h('div', { className: 'dsh-tp-muted' }, '原文'),
    h('div', { className: 'dsh-tp-translation-text' }, record.source),
    h('div', { className: 'dsh-tp-muted', role: 'status' }, record.status === 'completed' ? `${status} · ${record.targetLanguage}` : status),
    record.text && record.status !== 'completed' ? h('div', { className: 'dsh-tp-muted' }, '未完成输出') : null,
    record.text ? h('div', { className: 'dsh-tp-translation-text' }, record.text) : null,
    record.message ? h('p', { role: record.status === 'failed' || record.status === 'unknown' ? 'alert' : 'status', className: 'dsh-tp-muted' }, record.message) : null,
    record.status !== 'completed' && record.status !== 'submitting' && record.status !== 'running'
      ? button('恢复原文到输入框', () => quick.restoreSource(record), !canRestore) : null,
    record.status === 'unknown' ? button('查询本轮结果', () => quick.query(record)) : null,
  )
}

function TranslationRevision({ unit, revision, quick, session, editor, objects, objectAssets }: RecordObjectsProps & { readonly unit: TextUnit; readonly revision: TextRevision; readonly quick: QuickTranslationClient; readonly session: LocalSession; readonly editor: RevisionEditor }): unknown {
  const [details, setDetails] = react.useState(false)
  const [copyState, setCopyState] = react.useState<'idle' | 'copied' | 'failed'>('idle')
  const status = { submitting: '正在提交…', running: '正在翻译…', completed: '译文', failed: '翻译失败', cancelled: '已取消', unknown: '执行结果未知', interrupted: '重启前未确认／已中断', context_requested: '等待补充背景' }[revision.status]
  const record = quick.getRecords(session.id).find(record => record.id === revision.operationId)
  const currentSource = revision.sourceVersion === unit.sourceVersion
  const eligible = revision.sourceVersion === unit.sourceVersion && revision.accepted && revision.status === 'completed' && !!revision.text.trim()
  const fixed = unit.final?.revisionId === revision.id && unit.final.selection === 'user_fixed'
  const label = `文本 ${unit.order} 版本 ${revision.order}`
  const key = editKey(session.id, unit.id, revision.id)
  const draft = editor.drafts.get(key)
  const otherEdit = [...editor.drafts.values()].some(edit => edit.sessionId === session.id && edit.unitId === unit.id && edit.baseRevisionId !== revision.id)
  const canEdit = !!revision.text.trim() && ['completed', 'failed', 'cancelled', 'interrupted'].includes(revision.status) && session.archivedAt === null
  const editBlocked = quick.manualEditBlockedReason(session.id, unit.id, revision.id)
  const base = unit.revisions.find(base => base.id === revision.baseRevisionId)
  const metadata = revision.callRecord
  const model = metadata?.model ?? revision.model
  const usage = (count: number | null | undefined): string => count === null || count === undefined ? '未提供' : String(count)
  async function copy(): Promise<void> {
    try { const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'revision' as const, revisionId: revision.id }; await navigator.clipboard.writeText(recordObjectPlainText(revision.text, target, objects?.getReferences(target) ?? [])); setCopyState('copied') }
    catch { setCopyState('failed') }
  }
  return h('section', { className: 'dsh-tp-version', 'aria-label': label },
    h('div', { className: 'dsh-tp-version-header' },
      h('span', { className: 'dsh-tp-muted', role: 'status' }, `版本 ${revision.order} · ${revision.kind === 'manual' ? '人工修订' : status} · ${unit.targetLanguage}${base ? ` · 基于版本 ${base.order}` : ''}${revision.sourceVersion === unit.sourceVersion ? '' : ` · 已过时（原文版本 ${revision.sourceVersion}）`}`),
      h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
        h('button', { type: 'button', 'aria-label': `复制${label}`, disabled: !revision.text, onClick: () => { void copy() } }, copyState === 'copied' ? '已复制' : '复制'),
        h('button', { type: 'button', 'aria-label': `${label}设为最终`, disabled: !eligible || fixed, onClick: () => { quick.selectFinal(session.id, unit.id, revision.id) } }, fixed ? '已固定' : '设为最终'),
        h('button', { type: 'button', 'aria-label': `编辑${label}`, disabled: !!editBlocked || !canEdit || !!draft || otherEdit, title: editBlocked ?? (otherEdit ? '请先保存或取消此段的当前编辑。' : undefined), onClick: () => editor.start(session.id, unit.id, revision.id, revision.text) }, draft ? '编辑中' : '编辑'),
        h('button', { type: 'button', 'aria-label': `${label}详情`, 'aria-expanded': details, onClick: () => setDetails(value => !value) }, '详情'),
      ),
    ),
    details ? h('div', { className: 'dsh-tp-muted dsh-tp-version-details' },
      revision.kind === 'manual' ? h('div', null, '人工修订，未调用模型。') : h('div', null,
        h('div', null, model ? `${metadata ? '调用模型' : '选用模型'}：${model.provider}/${model.model} · 推理：${model.reasoningEffort ?? 'Default'}` : '选用模型：未提供'),
        h('div', null, `提示词版本：${metadata?.promptVersion ?? '未提供'}`),
        h('div', null, `用量：输入 ${usage(metadata?.usage.inputTokens)} · 输出 ${usage(metadata?.usage.outputTokens)} token`),
      ),
      h('time', { dateTime: revision.createdAt }, `${revision.kind === 'manual' ? '保存' : '开始'}：${new Date(revision.createdAt).toLocaleString()}`),
      revision.kind === 'manual' ? null : h('div', null, h('time', { dateTime: revision.updatedAt }, `更新：${new Date(revision.updatedAt).toLocaleString()}`)),
    ) : null,
    revision.text && revision.status !== 'completed' ? h('div', { className: 'dsh-tp-muted' }, '未完成输出') : null,
    draft ? h('div', { className: 'dsh-tp-version-editor' },
      h('small', { className: 'dsh-tp-muted' }, `基于版本 ${revision.order}保存为新版本`),
      h('textarea', { 'aria-label': `编辑${label}译文`, value: draft.text, rows: 4, onChange: (event: TextEvent) => { const text = event.currentTarget.value; editor.change(key, text) } }),
      h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
        h('button', { type: 'button', 'aria-label': `保存${label}编辑`, disabled: !!editBlocked || !draft.text.trim(), title: editBlocked, onClick: () => editor.save(key) }, '保存最新版本'),
        h('button', { type: 'button', 'aria-label': `保存${label}并定稿`, disabled: !!editBlocked || !draft.text.trim() || !currentSource, title: editBlocked ?? (!currentSource ? '原文版本已变化，不能将此修订设为最终。' : undefined), onClick: () => editor.save(key, true) }, '保存并定稿'),
        h('button', { type: 'button', 'aria-label': `取消${label}编辑`, onClick: () => editor.cancel(key) }, '取消'),
      ),
      draft.failure ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, draft.failure) : null,
    ) : revision.text ? h(RecordObjectText, { text: revision.text, target: { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'revision', revisionId: revision.id }, objects, objectAssets }) : null,
    editBlocked ? h('small', { className: 'dsh-tp-muted' }, editBlocked) : null,
    revision.message ? h('p', { role: revision.status === 'failed' || revision.status === 'unknown' ? 'alert' : 'status', className: 'dsh-tp-muted' }, revision.message) : null,
    copyState === 'failed' ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, '复制失败，请重试。') : null,
    revision.status === 'unknown' && record?.status === 'unknown' ? button('查询本轮结果', () => quick.query(record)) : null,
  )
}

function TranslationUnit({ store, unit, quick, normal, session, editor, topics, objects, objectAssets }: StoreProps & RecordObjectsProps & { readonly unit: TextUnit; readonly quick: QuickTranslationClient; readonly normal?: NormalTranslationClient | undefined; readonly session: LocalSession; readonly editor: RevisionEditor; readonly topics?: TopicBridgeClient | undefined }): unknown {
  const [expanded, setExpanded] = react.useState(false)
  const [referenceFailure, setReferenceFailure] = react.useState(false)
  const [sourcesExpanded, setSourcesExpanded] = react.useState(false)
  const [exchangeExpanded, setExchangeExpanded] = react.useState(false)
  const latest = unit.revisions.at(-1)
  const retranslation = normal?.getRetranslationStatus(session.id, unit.id)
  const sourceHistory = unit.sourceVersions.length > 1 ? h('div', null,
    h('small', { className: 'dsh-tp-muted' }, `当前原文版本 ${unit.sourceVersion}`),
    h('button', { type: 'button', 'aria-label': `文本 ${unit.order}原文版本`, 'aria-expanded': sourcesExpanded, onClick: () => setSourcesExpanded(value => !value) }, sourcesExpanded ? '收起原文版本' : '查看原文版本'),
    sourcesExpanded ? h('div', { className: 'dsh-tp-old-versions' }, ...unit.sourceVersions.map(source => h('section', { key: source.version },
      h('small', { className: 'dsh-tp-muted' }, `原文版本 ${source.version}${source.version === unit.sourceVersion ? '（当前）' : '（历史）'}`), h('div', { className: 'dsh-tp-translation-text' }, source.text)))) : null) : null
  const operation = normal?.getUnitStatus(session.id, unit.id)
  const exchange = operation ? store.getTranslationHistory(session.id)?.exchanges.filter(item => item.unitId === unit.id && item.operationId === operation.operationId).at(-1) : undefined
  const operationStatus: Record<string, string> = {
    accepted: '材料已受理，等待翻译执行。', running: '正在翻译…', waiting_context: '等待主模型补充背景。',
    waiting_user: '等待用户补充具体要求。', resuming: '补充已登记，等待翻译续作。', completed: '翻译完成。',
    failed: '翻译失败。', cancelled: '已取消。', unknown: '执行状态未知，可查询本轮状态。',
  }
  const execution = operation && operation.status !== 'completed' ? h('div', { className: 'dsh-tp-muted' },
    h('p', { role: operation.status === 'failed' || operation.status === 'unknown' ? 'alert' : 'status' }, operation.message ?? operationStatus[operation.status]),
    exchange ? h('section', { className: 'dsh-tp-message', 'aria-label': `文本 ${unit.order}补充问题状态` },
      h('p', { role: 'status' }, `补充协调：${exchange.status === 'open' ? '等待主模型答复' : exchange.status === 'waiting_user' ? '等待用户答复' : exchange.status === 'resuming' ? '正在续作' : exchange.status === 'resolved' ? '已完成' : exchange.status === 'cancelled' ? '已取消' : '状态未知'}`),
      ['open', 'waiting_user', 'unknown'].includes(exchange.status) ? h('button', { type: 'button', 'aria-label': exchangeExpanded ? `收起文本 ${unit.order}补充问题` : `查看文本 ${unit.order}补充问题`, onClick: () => setExchangeExpanded(value => !value) }, exchangeExpanded ? '收起补充问题' : `查看补充问题（${exchange.questions.questions.length}）`) : null,
      exchangeExpanded ? h('div', { className: 'dsh-tp-exchange-questions' }, ...exchange.questions.questions.map((question, index) => {
        const excerpt = question.range ? Array.from(unit.source).slice(question.range.start, question.range.end).join('') : null
        return h('article', { key: `${exchange.exchangeId}:${index}` },
          h('p', null, question.question), h('small', { className: 'dsh-tp-muted' }, question.reason),
          excerpt === null ? null : h('blockquote', { className: 'dsh-tp-muted' }, `原文位置 ${question.range!.start}–${question.range!.end}：“${excerpt}”`))
      })) : null,
    ) : null,
    h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
      ['accepted', 'running', 'waiting_context', 'waiting_user', 'resuming', 'unknown'].includes(operation.status) ? button(operation.querying ? '正在查询…' : '查询普通执行状态', () => { void normal?.query(session.id, unit.id) }, operation.querying) : null,
      ['accepted', 'running', 'waiting_context', 'waiting_user', 'resuming', 'unknown'].includes(operation.status) ? button('取消普通翻译', () => { void normal?.cancel(session.id, unit.id) }, operation.querying) : null,
    )) : null
  const edit = [...editor.drafts.values()].find(edit => edit.sessionId === session.id && edit.unitId === unit.id)
  react.useEffect(() => { if (edit && edit.baseRevisionId !== latest?.id) setExpanded(true) }, [edit?.baseRevisionId, latest?.id])
  if (!latest) return h('article', { className: 'dsh-tp-translation', 'aria-label': `文本 ${unit.order}` },
    h(TextUnitOpenLinks, { unit, session, objects, objectAssets }),
    h('div', { className: 'dsh-tp-muted' }, '原文'),
    h(RecordObjectText, { text: unit.source, target: { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source', revisionId: null }, objects, objectAssets }),
    sourceHistory, execution ?? h('p', { className: 'dsh-tp-muted', role: 'status' }, '材料已受理，等待翻译执行。'))
  const final = currentFinalRevision(unit), pointed = unit.revisions.find(revision => revision.id === unit.final?.revisionId)
  const finalLabel = final ? `${unit.final?.selection === 'user_fixed' ? '用户固定' : '自动最终'}：版本 ${final.order}` : pointed ? pointed.sourceVersion !== unit.sourceVersion ? `原最终版本 ${pointed.order}已过时，待新原文定稿` : `最新尝试尚未完整，原自动最终版本 ${pointed.order}保留在历史中` : '待定稿'
  const blocked = session.mode === 'normal' ? normal?.retranslateBlockedReason(session.id, unit.id) ?? (normal ? undefined : '普通重译入口未就绪。') : quick.retranslateBlockedReason(session, unit.id)
  const canReference = ['completed', 'failed', 'cancelled', 'interrupted'].includes(latest.status)
  const published = topics?.isPublished(session.ownerId, session.id, unit.id) ?? false
  return h('article', { className: 'dsh-tp-translation', 'aria-label': `文本 ${unit.order}` },
    h(TextUnitOpenLinks, { unit, session, objects, objectAssets }),
    h('div', { className: 'dsh-tp-muted' }, '原文'),
    h(RecordObjectText, { text: unit.source, target: { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source', revisionId: null }, objects, objectAssets }),
    sourceHistory,
    h('div', { className: 'dsh-tp-unit-header' },
      h('span', { className: 'dsh-tp-muted', role: 'status' }, finalLabel),
      h('button', { type: 'button', 'aria-label': `重译文本 ${unit.order}`, disabled: !!blocked, title: blocked ?? '使用当前模型重译，沿用此段原文、目标语言与翻译要求。', onClick: () => { if (session.mode === 'normal') void normal?.retranslate(session.id, unit.id); else void quick.retranslate(session.id, unit.id) } }, '重译'),
    ),
    topics ? h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
      h('button', { type: 'button', disabled: !canReference, 'aria-label': `文本 ${unit.order}供主模型参考`,
        title: '仅此明确选择的历史单元供当前主会话读取；不发送翻译命令。', onClick: () => setReferenceFailure(!topics.publishUnit(session.ownerId, session.id, unit.id)) }, published ? '更新主模型参考' : '供主模型参考'),
      published ? h('button', { type: 'button', 'aria-label': `取消文本 ${unit.order}参考`, onClick: () => { topics.revokeUnit(session.ownerId, session.id, unit.id); setReferenceFailure(false) } }, '取消参考') : null,
    ) : null,
    referenceFailure ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, '未能提供此参考，请核对单元状态及内容大小。') : null,
    retranslation ? h('p', { className: 'dsh-tp-muted', role: 'status' }, retranslation.message) : null,
    execution,
    h(TranslationRevision, { key: latest.id, unit, revision: latest, quick, session, editor, objects, objectAssets }),
    unit.revisions.length > 1 ? h('button', { type: 'button', 'aria-label': `文本 ${unit.order}旧版本`, 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) }, `${expanded ? '收起' : '展开'}旧版本（${unit.revisions.length - 1}）`) : null,
    expanded ? h('div', { className: 'dsh-tp-old-versions', 'aria-label': `文本 ${unit.order}旧版本列表` },
      ...unit.revisions.slice(0, -1).reverse().map(revision => h(TranslationRevision, { key: revision.id, unit, revision, quick, session, editor, objects, objectAssets })),
    ) : null,
  )
}

function WorkspaceView({ store, models, quick, normal, editor, ownerId, topics, materials, terms, objects, objectAssets, documents, documentTasks, documentReviews, onDeleteTerm, onOpenAssets }: StoreProps & TopicUiProps & { readonly models: ModelCatalog; readonly quick: QuickTranslationClient; readonly editor: RevisionEditor; readonly ownerId: string }): unknown {
  useStore(store)
  const [, refreshQuick] = react.useState(0)
  react.useEffect(() => {
    const refresh = () => {
      refreshQuick(value => value + 1)
      if (quick.getReadiness().status === 'idle') void quick.load()
    }
    const unsubscribe = quick.subscribe(refresh)
    if (quick.getReadiness().status === 'idle') void quick.load()
    return unsubscribe
  }, [quick])
  react.useEffect(() => normal?.subscribe(() => refreshQuick(value => value + 1)), [normal])
  react.useEffect(() => objects?.subscribe(() => refreshQuick(value => value + 1)), [objects])
  react.useEffect(() => {
    const refresh = () => {
      refreshQuick(value => value + 1)
      if (models.getSnapshot().status === 'idle') void models.load()
    }
    const unsubscribe = models.subscribe(refresh)
    if (models.getSnapshot().status === 'idle') void models.load()
    return unsubscribe
  }, [models])
  react.useEffect(() => topics?.retain(ownerId), [topics, ownerId])
  react.useEffect(() => topics?.subscribe(() => refreshQuick(value => value + 1)), [topics])
  react.useEffect(() => materials?.subscribe(() => refreshQuick(value => value + 1)), [materials])
  const [sidebar, setSidebar] = react.useState(false)
  const [sessionPickerOpen, setSessionPickerOpen] = react.useState(false)
  const sorting = useSessionSorting(store, ownerId)
  react.useEffect(() => { sorting.gesture.cancel() }, [sidebar, sessionPickerOpen, sorting.gesture])
  const [archives, setArchives] = react.useState(false)
  const [context, setContext] = react.useState<ContextRequest | undefined>(undefined)
  const [dialog, setDialog] = react.useState<WorkspaceDialog | undefined>(undefined)
  const [deletion, setDeletion] = react.useState<DeleteRequest | undefined>(undefined)
  const [name, setName] = react.useState('')
  const [remark, setRemark] = react.useState('')
  const [exportRequest, setExportRequest] = react.useState<(FrozenTranslationExport & { readonly result: TranslationExport }) | undefined>(undefined)
  const [exportNotice, setExportNotice] = react.useState<{ readonly message: string; readonly failure: boolean } | undefined>(undefined)
  const [exporting, setExporting] = react.useState(false)
  const [exportLabel, setExportLabel] = react.useState('')
  const exportLifetime = react.useRef({ mounted: true, generation: 0, busy: false })
  react.useEffect(() => { exportLifetime.current.mounted = true; return () => { exportLifetime.current.mounted = false; exportLifetime.current.generation++; exportLifetime.current.busy = false } }, [])
  const fileInput = react.useRef<HTMLInputElement | null>(null)
  const sourceInput = react.useRef<HTMLTextAreaElement | null>(null)
  react.useEffect(() => () => { materials?.clearSelectedFiles(ownerId) }, [materials, ownerId])
  const action = useAsyncAction()
  react.useEffect(() => { store.ensureWorkspace(ownerId) }, [store, ownerId])
  const displayed = store.getDisplaySessions(ownerId)
  const sessions = displayed.filter(session => session.archivedAt === null)
  const archived = displayed.filter(session => session.archivedAt !== null)
  const current = store.getActiveSession(ownerId)
  const selectedFile = current ? materials?.getSelectedFile(current.id) : undefined
  const longDraft = current?.mode === 'normal' ? materials?.getLongDraft(current.id) : undefined
  const target = context ? store.getSession(context.id) : undefined
  const targetTopicSessions = target ? store.getAvailableSessions(ownerId).filter(session => session.topicId === target.topicId) : []
  const targetTopicHasRecords = targetTopicSessions.some(session => store.getTranslationHistory(session.id)?.units.length)
  const dialogSession = dialog ? store.getSession(dialog.id) : undefined
  const status = current ? store.getStatus(current.id) : 'memory'
  const records = current ? quick.getRecords(current.id) : []
  const units = current ? quick.getUnits(current.id) : []
  const represented = new Set(units.flatMap(unit => isTextUnit(unit) ? unit.revisions.map(revision => revision.operationId) : unit.tasks.map(task => task.operationId)))
  const transient = records.filter(record => !represented.has(record.id))
  const historyNote = store.getSettings().rememberHistory ? undefined
    : store.getHistory().length ? '已保存的历史保留；后续内容仅保留在本次运行。' : '本次内容仅保留在本次运行。'
  const materialStatus = current?.mode === 'normal' ? materials?.getStatus(current.id) : undefined
  const blocked = current?.mode === 'normal' ? materialStatus?.blocked ?? (materials ? undefined : '普通模式暂不可用：当前 DSH 缺少同步发送材料接口。') : current ? quick.blockedReason(current) : undefined
  const busy = current?.mode === 'normal' ? materialStatus?.busy ?? false : current ? quick.isBusy(current.id) : false
  const readiness = quick.getReadiness()
  const checking = readiness.status === 'loading' || readiness.status === 'idle'
  const serviceStatus = current?.mode === 'normal' ? blocked : readiness.status !== 'ready'
    ? checking ? '正在检查翻译服务…' : readiness.reason : undefined
  function contextMenu(session: LocalSession, event: ContextEvent): void {
    sorting.gesture.cancel()
    event.preventDefault(); event.stopPropagation()
    setContext({ id: session.id, x: event.clientX, y: event.clientY, trigger: event.currentTarget })
  }
  function contextKeys(session: LocalSession, event: KeyboardEvent & { currentTarget: HTMLElement }): void {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    const rect = event.currentTarget.getBoundingClientRect()
    contextMenu(session, { preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), clientX: rect.left, clientY: rect.bottom, currentTarget: event.currentTarget })
  }
  function create(parentId?: string): void {
    closeSessionMenus()
    void action.run(async () => Boolean(await store.createSessionAsync(ownerId, parentId)))
  }
  function closeSessionMenus(): void { setSessionPickerOpen(false); setContext(undefined) }
  function openTopicAssets(topic: { readonly id: string; readonly name: string }, sessionId?: string): void {
    if (!store.getTopics(ownerId).some(owned => owned.id === topic.id)) return
    closeSessionMenus(); onOpenAssets?.(ownerId, topic.id, sessionId ?? (current?.topicId === topic.id ? current.id : undefined))
  }
  function openSessionAssets(session: LocalSession): void { openTopicAssets({ id: session.topicId, name: session.topicName }, session.id) }
  function deliver(result: TranslationExport, request: FrozenTranslationExport): void {
    closeSessionMenus()
    if (request.entries.some(({ session }) => {
      const current = store.getSession(session.id)
      return !current || store.isSessionDeleted(session.id) || current.ownerId !== request.topic.ownerId || current.topicId !== request.topic.topicId
    })) { setExportNotice({ message: '导出范围已不可用，请重新导出。', failure: true }); return }
    try { downloadExport(allowPartialTranslationExport(result)); setExportNotice({ message: `已向浏览器发起${request.scope === 'topic' ? `主题「${request.topic.topicName}」` : `会话「${request.entries[0]!.session.remark || request.entries[0]!.session.name}」`}的下载。`, failure: false }); setExportRequest(undefined) }
    catch { setExportNotice({ message: '无法启动下载，请重试。', failure: true }) }
  }
  async function exportSession(id: string, format: 'txt' | 'json', scope: 'session' | 'topic'): Promise<void> {
    if (exportLifetime.current.busy) return
    const generation = ++exportLifetime.current.generation
    const active = (): boolean => exportLifetime.current.mounted && exportLifetime.current.generation === generation && Boolean(store.getSession(id)?.ownerId === ownerId && !store.isSessionDeleted(id))
    exportLifetime.current.busy = true; setExporting(true)
    closeSessionMenus(); setExportNotice(undefined); setExportRequest(undefined)
    try {
      const target = store.getSession(id)
      if (!target || target.ownerId !== ownerId) throw new Error('Session no longer available')
      const selected = scope === 'topic' ? store.getAvailableSessions(ownerId).filter(session => session.topicId === target.topicId) : [target]
      for (const session of selected) if (!quick.finalizeForExport(session.id)) throw new Error('Cannot finalize export')
      const entries = selected.map(session => {
        const history = store.getTranslationHistory(session.id)
        if (!history) throw new Error('Session no longer available')
        return { session, history }
      })
      const references = entries.flatMap(({ session }) => objects?.getSnapshot(ownerId, target.topicId, session.id).references ?? [])
      const snapshot: FrozenTranslationExport = { ...structuredClone({ topic: { ownerId, topicId: target.topicId, topicName: target.topicName }, references, scope, format, at: new Date().toISOString() }), entries: entries.map(({ session, history }) => ({ session: structuredClone(session), history })) }
      setExportLabel(scope === 'topic' ? `主题「${target.topicName}」` : `会话「${target.remark || target.name}」`)
      const result = await projectTranslationExport(snapshot, documents)
      if (!active()) return
      if (!result.complete) setExportRequest({ ...snapshot, result })
      else if (result.content) deliver(result, snapshot)
      else setExportNotice({ message: '当前范围没有可导出的译文。', failure: false })
    } catch { if (active()) setExportNotice({ message: '导出失败，当前内容仍保留。', failure: true }) }
    finally { if (exportLifetime.current.generation === generation) { exportLifetime.current.busy = false; if (exportLifetime.current.mounted) setExporting(false) } }
  }
  function sessionItem(session: LocalSession): unknown {
    return h('button', {
      key: session.id, type: 'button', className: 'dsh-tp-session-item', title: sessionTitle(session),
      ...sorting.props(session.id),
      'aria-current': session.id === current?.id, 'aria-haspopup': 'menu',
      onClick: (event?: SessionClickEvent) => { if (sorting.clicked(session.id, event)) return; store.openSession(ownerId, session.id); setContext(undefined) },
      onContextMenu: (event: ContextEvent) => contextMenu(session, event),
      onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLElement }) => contextKeys(session, event),
    }, sessionLabel(session))
  }
  return h('div', { className: 'dsh-tp-workspace' },
    h('aside', { className: 'dsh-tp-session-sidebar', hidden: !sidebar, 'aria-label': '翻译会话侧栏' },
      h('div', { className: 'dsh-tp-session-list', 'aria-label': '使用中的翻译会话', 'data-session-sort-list': true },
        ...sessions.map(sessionItem),
        h('button', { type: 'button', className: 'dsh-tp-session-add', title: '新建主题及首会话', 'aria-label': '新建主题及首会话', disabled: action.pending, onClick: () => create() }, '+'),
      ),
      h('button', { type: 'button', className: 'dsh-tp-archive-toggle', 'aria-expanded': archives, onClick: () => setArchives(value => !value) }, `已归档（${archived.length}）`),
      archives ? h('div', { className: 'dsh-tp-session-list', 'aria-label': '已归档翻译会话', 'data-session-sort-list': true },
        ...archived.map(session => h('button', { type: 'button', className: 'dsh-tp-session-item', key: session.id, title: sessionTitle(session), 'aria-haspopup': 'menu',
          ...sorting.props(session.id),
          onContextMenu: (event: ContextEvent) => contextMenu(session, event),
          onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLElement }) => contextKeys(session, event),
          onClick: (event?: SessionClickEvent) => { if (sorting.clicked(session.id, event)) return; if (store.archiveSession(ownerId, session.id, false)) setContext(undefined) },
        }, sessionLabel(session))),
        archived.length === 0 ? h('small', { className: 'dsh-tp-muted' }, '暂无归档会话。') : null,
      ) : null,
    ),
    h('div', { className: 'dsh-tp-main' },
      h('header', { className: 'dsh-tp-workspace-header' },
        h('button', { type: 'button', title: sidebar ? '收起会话侧栏' : '展开会话侧栏', 'aria-label': '切换会话侧栏', 'aria-expanded': sidebar, onClick: () => setSidebar(value => !value) }, h(IconPanelLeftOutlineRegular, { size: 16 })),
        h(SessionPicker, { store, ownerId, current, open: sessionPickerOpen, onOpenChange: setSessionPickerOpen, contextOpen: Boolean(context && target), onDismissContext: () => setContext(undefined), onContext: contextMenu, onContextKeys: contextKeys, creating: action.pending, onCreate: () => create(), onTopicAssets: onOpenAssets ? openTopicAssets : undefined, sorting }),
        current ? h('div', { className: 'dsh-tp-header-options' },
          h(ModePicker, { store, session: current, key: `mode:${current.id}` }),
          h(LanguagePicker, { store, session: current, key: `language:${current.id}` }),
        ) : null,
      ),
      dialog?.kind === 'rename' && dialogSession ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '重命名主题', 'aria-busy': action.pending },
        field('主题名称', h('input', { type: 'text', value: name, autoFocus: true, disabled: action.pending, onChange: (event: TextEvent) => setName(event.currentTarget.value) })),
        h('p', { className: 'dsh-tp-muted' }, '同主题的全部会话（含归档会话）一起更名，编号与单会话备注保持不变。'),
        h('div', { className: 'dsh-tp-actions' }, button(action.pending ? '正在保存…' : '确认重命名主题', () => { void action.run(() => store.renameSessionAsync(dialog.id, name), () => setDialog(currentDialog => currentDialog === dialog ? undefined : currentDialog)) }, action.pending), button('取消', () => setDialog(undefined), action.pending)),
      ) : null,
      dialog?.kind === 'remark' && dialogSession ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '编辑会话备注' },
        field('会话备注', h('input', { type: 'text', value: remark, autoFocus: true, onChange: (event: TextEvent) => setRemark(event.currentTarget.value) }), '仅用于区分此会话，可留空，也可与其他会话重复。'),
        h('div', { className: 'dsh-tp-actions' }, button('保存备注', () => { if (store.updateSession(dialog.id, { remark })) setDialog(undefined) }), button('取消', () => setDialog(undefined))),
      ) : null,
      deletion ? h(DeleteDialog, { request: deletion, sessionDeletion: true, pending: action.pending, onCancel: () => setDeletion(undefined), onConfirm: () => {
        void action.run(() => deleteConfirmed(store, terms, deletion), () => setDeletion(currentRequest => currentRequest === deletion ? undefined : currentRequest))
      }, onTermsChange: (checked: boolean) => setDeletion(currentRequest => currentRequest === deletion ? { ...deletion, includeTerms: checked } : currentRequest) }) : null,
      h('div', { className: 'dsh-tp-transcript', tabIndex: 0, 'aria-label': '翻译会话内容' },
        historyNote && (units.length || records.length) ? h('p', { className: 'dsh-tp-history-note' }, historyNote) : null,
        current?.legacyManualText ? h('div', null, h('p', { className: 'dsh-tp-muted' }, '旧版保存的人工译文'), h('div', { className: 'dsh-tp-legacy' }, current.legacyManualText)) : null,
        ...units.map(unit => isTextUnit(unit) ? h(TranslationUnit, { key: unit.id, store, unit, quick, normal, session: current!, editor, objects, objectAssets, topics: current?.mode === 'normal' ? topics : undefined }) : h(DocumentUnitView, { key: unit.id, unit, session: current!, store, documents, documentTasks, documentReviews, objects, objectAssets })),
        ...transient.map(record => h(TranslationRecord, { key: record.id, record, quick, canRestore: !current?.input })),
        units.length === 0 && records.length === 0 && current?.mode !== 'normal' ? h('div', { className: 'dsh-tp-empty' }, current ? '在下方输入待翻译内容，选择模型后发送。' : '用“+”新建主题及首会话，或从已归档列表恢复。') : null,
      ),
      storeNotice(store),
      terms?.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-muted dsh-tp-message' }, terms.getNotice()) : null,
      exporting ? h('p', { role: 'status', className: 'dsh-tp-muted dsh-tp-message' }, `正在读取${exportLabel}的固定译文…`) : null,
      exportNotice ? h('div', { role: exportNotice.failure ? 'alert' : 'status', className: exportNotice.failure ? 'dsh-tp-message' : 'dsh-tp-muted dsh-tp-message' }, exportNotice.message) : null,
      exportRequest ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '导出译文确认' },
        h('h3', null, `导出${exportRequest.scope === 'topic' ? '主题' : '会话'}「${exportRequest.scope === 'topic' ? exportRequest.topic.topicName : exportRequest.entries[0]!.session.name}」`),
        h('p', null, `当前范围包含缺项：${exportRequest.result.missingUnits.map(unit => `${exportRequest.scope === 'topic' && 'sessionName' in unit ? `${unit.sessionName} · ` : ''}单元 ${unit.order}`).join('、')}。完整导出尚不可用。`),
        h('p', null, '部分导出会保留有效译文并标明缺失区间。'),
        h('div', { className: 'dsh-tp-actions' },
          button('导出部分结果（含缺口）', () => deliver(exportRequest.result, exportRequest), exportRequest.result.exportedUnitIds.length === 0),
          button('取消', () => { closeSessionMenus(); setExportRequest(undefined) }),
        ),
      ) : null,
      action.failure ? h('div', { role: 'alert', className: 'dsh-tp-message' }, action.failure) : null,
      current && status === 'conflict' ? h('div', { className: 'dsh-tp-actions dsh-tp-message' },
        button('读取本地副本', () => setDialog({ kind: 'reload', id: current.id }), action.pending),
        button('用当前会话覆盖本地副本', () => { void action.run(() => store.overwriteSessionAsync(current.id)) }, action.pending || !store.getSettings().rememberHistory),
      ) : null,
      dialog?.kind === 'reload' && dialogSession ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '读取会话历史确认' },
        h('p', null, '读取本地副本会替换本窗口该会话内容。确认继续？'),
        button('确认读取', () => { if (store.reloadSession(dialog.id)) setDialog(undefined) }, action.pending), button('取消', () => setDialog(undefined), action.pending),
      ) : null,
      current ? h('div', { className: 'dsh-tp-composer-area' },
        current.mode === 'normal' ? h('p', { className: 'dsh-tp-muted', role: 'status' }, materialStatus?.message ?? '材料会进入主会话及模型请求记录；待译草稿保留。') : null,
        current.mode === 'normal' && materialStatus?.unknown ? button('检查提交状态', () => { void materials?.query(current.id) }) : null,
        serviceStatus ? h('div', { className: 'dsh-tp-service-status' },
          h('span', { className: 'dsh-tp-service-status-text', role: 'status' }, serviceStatus),
          current.mode === 'quick' ? h('button', { type: 'button', className: 'dsh-tp-service-recheck', disabled: checking, 'aria-busy': checking,
            'aria-label': '重新检查翻译服务', title: checking ? '正在检查翻译服务…' : '重新检查翻译服务（仅检查服务，不发送翻译请求）',
            onClick: () => { void quick.load() },
          }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('path', { d: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17' }),
          )) : null,
        ) : null,
        h('div', { className: 'dsh-tp-composer' },
        current.mode === 'normal' && selectedFile ? h('div', null,
          h('div', { className: 'dsh-tp-attachment' },
            h('span', { className: 'dsh-tp-attachment-name', title: selectedFile.name }, selectedFile.name),
            h('button', { type: 'button', 'aria-label': '移除待译文件', title: '移除待译文件', onClick: () => { materials?.setFileSelected(current.id, undefined) } }, '×'),
          ),
          h('p', { className: 'dsh-tp-attachment-note' }, 'TXT 可交付主模型准备，分批翻译尚未接入。'),
        ) : null,
        current.mode === 'normal' && longDraft ? h('div', null,
          h('div', { className: 'dsh-tp-attachment' },
            h('button', { type: 'button', className: 'dsh-tp-attachment-name', 'aria-label': '编辑长原稿', title: `${longDraft.totalCodePoints} 个字符 · ${longDraft.bytes} 字节`,
              onClick: () => sourceInput.current?.focus() }, '长原稿'),
          ),
          h('p', { className: 'dsh-tp-attachment-note' }, '发送时将固定为 UTF-8 原稿，正文可继续编辑；分批翻译尚未接入。'),
        ) : null,
        h('textarea', { ref: sourceInput, value: current.input, 'aria-label': '待翻译内容', rows: 3, placeholder: '输入待翻译内容…', style: { outline: 'none', boxShadow: 'none' }, onChange: (event: TextEvent) => { store.updateSession(current.id, { input: event.currentTarget.value }) } }),
        current.mode === 'quick' && Array.from(current.input).length > current.maxInputChars ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, `已超过单次上限 ${current.maxInputChars} 个字符；内容保持完整。`) : null,
        h('div', { className: 'dsh-tp-composer-toolbar' },
          h('input', { type: 'file', accept: '.txt', hidden: true, ref: fileInput, key: `file:${current.id}`, 'aria-label': '待译文件', disabled: current.mode === 'quick',
            onChange: (event: FileEvent) => {
              const file = event.currentTarget.files?.[0]
              if (file && current.mode === 'normal') materials?.setFileSelected(current.id, file)
              event.currentTarget.value = ''
            },
          }),
          h('button', { type: 'button', className: 'dsh-tp-attach', 'aria-label': '选择待译文件', disabled: current.mode === 'quick',
            title: current.mode === 'quick' ? '快译仅支持纯文本，不能选择文件。' : '选择 UTF-8 TXT 原稿（最多 2 MiB）', onClick: () => fileInput.current?.click(),
          }, h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('path', { d: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3M6 15l9-9a2 2 0 0 1 3 3l-9 9' }),
          )),
          h(ModelPicker, { key: current.id, catalog: models, current: current.model, onSelect: (model: LocalSession['model']) => { store.updateSession(current.id, { model }) } }),
          h('button', { type: 'button', className: 'dsh-tp-send', disabled: current.mode === 'normal' ? busy || !!blocked : !busy && !!blocked, title: current.mode === 'normal' ? blocked ?? '发送待译材料' : busy ? '取消翻译' : blocked ?? '发送快译', 'aria-label': current.mode === 'normal' ? busy ? '正在提交材料' : '发送待译材料' : busy ? '取消翻译' : '发送快译', 'aria-description': busy ? undefined : blocked,
            onClick: () => { if (current.mode === 'normal') void materials?.send(current.id); else if (busy) quick.cancel(current.id); else void quick.send(current.id) },
            style: { width: 38, height: 38, minWidth: 38, maxWidth: 38, minHeight: 38, maxHeight: 38, padding: 0, borderRadius: '50%', cornerShape: 'round', aspectRatio: '1 / 1', flex: '0 0 38px' },
          }, busy ? h('span', { 'aria-hidden': true, style: { fontSize: 18, lineHeight: 1 } }, '■') : h(IconSendOutlineMedium, { size: 20 })),
        ),
        ),
      ) : null,
    ),
    context && target ? h(Menu, { key: context.exportFormat ?? 'actions', open: true, anchor: null, onClose: () => { setContext(undefined); setSessionPickerOpen(false) }, portal: true, autoFocus: true, compact: true, listClassName: 'dsh-tp-popup',
      getAnchorRect: () => ({ left: context.x, right: context.x, top: context.y, bottom: context.y, width: 0, height: 0 }),
    }, h('div', { 'aria-label': '翻译会话右键操作', onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setContext(undefined); context.trigger?.focus() }
      },
    },
      context.exportFormat ? h('div', { 'aria-label': '导出内容范围' },
        h(MenuItemButton, { onSelect: () => setContext({ ...context, exportFormat: undefined }) }, '返回'),
        h(MenuItemButton, { disabled: action.pending || exporting || !store.getTranslationHistory(target.id)?.units.length,
          onSelect: () => exportSession(target.id, context.exportFormat!, 'session') }, '当前会话'),
        h(MenuItemButton, { disabled: action.pending || exporting || !targetTopicHasRecords,
          onSelect: () => exportSession(target.id, context.exportFormat!, 'topic') }, '整个主题')) : h('div', null,
      h(MenuItemButton, { disabled: action.pending, onSelect: () => create(target.id) }, '新建子会话'),
      h(MenuItemButton, { disabled: action.pending, onSelect: () => { closeSessionMenus(); setName(target.topicName); setDialog({ kind: 'rename', id: target.id }) } }, '重命名'),
      h(MenuItemButton, { disabled: action.pending, onSelect: () => { closeSessionMenus(); setRemark(target.remark); setDialog({ kind: 'remark', id: target.id }) } }, '备注'),
      onOpenAssets ? h(MenuItemButton, { onSelect: () => openSessionAssets(target) }, '记忆') : null,
      h(MenuItemButton, { disabled: action.pending || exporting || !targetTopicHasRecords, onSelect: () => { setSessionPickerOpen(false); setContext({ ...context, exportFormat: 'txt' }) } }, '导出译文 TXT'),
      h(MenuItemButton, { disabled: action.pending || exporting || !targetTopicHasRecords, onSelect: () => { setSessionPickerOpen(false); setContext({ ...context, exportFormat: 'json' }) } }, '导出对照 JSON'),
      h(MenuItemButton, { disabled: action.pending, onSelect: () => { closeSessionMenus(); store.archiveSession(ownerId, target.id, target.archivedAt === null) } }, target.archivedAt === null ? '归档' : '恢复'),
      h(MenuItemButton, { disabled: action.pending, danger: true, onSelect: () => {
        closeSessionMenus(); setDeletion(captureDeleteRequest(store, terms, `删除「${target.name}」`, [target.id]))
      } }, '删除'),
    ))) : null,
  )
}

interface DeleteRequest {
  readonly title: string; readonly ids: readonly string[]; readonly unreadable: readonly { readonly key: string; readonly raw: string }[]; readonly versions: readonly HistoryVersion[]
  readonly termVersions: readonly TopicTermVersion[]; readonly termNames: readonly string[]; readonly includeTerms: boolean
}
function captureDeleteRequest(store: SessionStore, terms: TopicMemoryStore | undefined, title: string, ids: readonly string[], unreadable: DeleteRequest['unreadable'] = []): DeleteRequest {
  const names = new Map<string, string>()
  for (const id of ids) {
    const session = store.getSession(id)
    if (session) names.set(JSON.stringify([session.ownerId, session.topicId]), session.topicName)
  }
  return { title, ids: [...ids], unreadable, versions: store.captureHistoryVersions(ids), termVersions: terms?.captureForSessions(ids) ?? [], termNames: [...names.values()], includeTerms: false }
}
function deleteConfirmed(store: SessionStore, terms: TopicMemoryStore | undefined, request: DeleteRequest): Promise<boolean> {
  return terms ? terms.deleteHistoryAsync(request.ids, request.unreadable, request.versions, request.includeTerms ? request.termVersions : [])
    : store.deleteHistoryAsync(request.ids, false, request.unreadable, request.versions)
}
function DeleteDialog({ request, onCancel, onConfirm, onTermsChange, sessionDeletion = false, pending = false }: {
  readonly request: DeleteRequest; readonly onCancel: () => void; readonly onConfirm: () => void; readonly onTermsChange: (checked: boolean) => void; readonly sessionDeletion?: boolean; readonly pending?: boolean
}): unknown {
  return h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': sessionDeletion ? '删除翻译会话确认' : '删除会话历史确认', 'aria-busy': pending },
    h('h3', null, request.title),
    h('p', null, sessionDeletion ? '将删除该会话的当前内容与已保存历史，并从列表移除。'
      : `将删除 ${request.ids.length} 条会话历史${request.unreadable.length ? `及 ${request.unreadable.length} 份无法读取的历史副本` : ''}，并从会话列表移除。`),
    request.termVersions.length ? h('label', { className: 'dsh-tp-history-row' }, h('input', { type: 'checkbox', checked: request.includeTerms, disabled: pending, 'aria-label': '同时删除所选主题术语', onChange: (event: CheckEvent) => {
      const checked = event.currentTarget.checked; onTermsChange(checked)
    } }), `同时删除${request.termNames.length === 1 ? `「${request.termNames[0]}」` : `这些主题（${request.termNames.length} 个）`}的术语档案`) : null,
    h('div', { className: 'dsh-tp-actions' }, button(pending ? '正在删除…' : sessionDeletion ? '确认删除会话' : '确认删除历史', onConfirm, pending), button('取消', onCancel, pending)),
  )
}
function HistorySection({ store, terms }: StoreProps & { readonly terms?: TopicMemoryStore | undefined }): unknown {
  useStore(store)
  const [selected, setSelected] = react.useState<readonly string[]>([])
  const [request, setRequest] = react.useState<DeleteRequest | undefined>(undefined)
  const action = useAsyncAction()
  const history = store.getHistory()
  const selectedIds = selected.filter(id => history.some(session => session.id === id))
  function choose(title: string, ids: readonly string[], all = false): void {
    setRequest(captureDeleteRequest(store, terms, title, ids, all ? store.getUnreadableHistory() : []))
  }
  return h('div', null,
    h('div', { className: 'dsh-tp-actions' },
      button('清除历史快译', () => choose('清除历史快译', history.filter(session => session.mode === 'quick').map(session => session.id)), action.pending || !history.some(session => session.mode === 'quick')),
      button('清除所有会话历史', () => choose('清除所有会话历史', history.map(session => session.id), true), action.pending),
    ),
    h('div', { className: 'dsh-tp-history-list', 'aria-label': '已保存会话历史' },
      history.length === 0 ? h('p', { className: 'dsh-tp-muted' }, '尚无已保存的会话历史。') : null,
      ...history.map(session => h('label', { key: session.id, className: 'dsh-tp-history-row', title: sessionTitle(session) },
        h('input', { type: 'checkbox', checked: selectedIds.includes(session.id), disabled: action.pending, 'aria-label': `选择会话 ${session.name}`, onChange: (event: CheckEvent) => {
          const checked = event.currentTarget.checked
          setSelected(current => checked ? [...new Set([...current, session.id])] : current.filter(id => id !== session.id))
        } }),
      h('span', null, session.name,
        session.remark ? h('div', { className: 'dsh-tp-muted' }, session.remark) : null,
        h('div', { className: 'dsh-tp-muted' }, `${session.mode === 'quick' ? '快译' : '普通'} · ${session.targetLanguage} · ${session.updatedAt.slice(0, 10)}${session.archivedAt ? ' · 已归档' : ''}`)),
      )),
    ),
    button(`删除所选历史（${selectedIds.length}）`, () => choose('删除所选历史', selectedIds), action.pending || selectedIds.length === 0),
    request ? h(DeleteDialog, { request, pending: action.pending, onCancel: () => setRequest(undefined), onConfirm: () => {
        void action.run(() => deleteConfirmed(store, terms, request), () => { setSelected([]); setRequest(currentRequest => currentRequest === request ? undefined : currentRequest) })
      }, onTermsChange: (checked: boolean) => setRequest(currentRequest => currentRequest === request ? { ...request, includeTerms: checked } : currentRequest) }) : null,
    action.failure ? h('div', { role: 'alert', className: 'dsh-tp-message' }, action.failure) : null,
    terms?.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, terms.getNotice()) : null,
  )
}

export function SettingsView({ store, onClose, terms }: StoreProps & { readonly onClose?: (() => void) | undefined; readonly terms?: TopicMemoryStore | undefined }): unknown {
  useStore(store)
  const [pending, setPending] = react.useState<Partial<Omit<SessionSettings, 'schemaVersion'>>>({})
  const [errors, setErrors] = react.useState<readonly string[]>([])
  const [saving, setSaving] = react.useState(false)
  const lifecycle = react.useRef(0)
  const editVersion = react.useRef(0)
  const inFlight = react.useRef(0)
  const editsRef = react.useRef<Partial<Omit<SessionSettings, 'schemaVersion'>>>({})
  react.useEffect(() => {
    const generation = ++lifecycle.current
    inFlight.current = 0; setSaving(false)
    return () => { if (lifecycle.current === generation) lifecycle.current++ }
  }, [])
  const form = { ...store.getSettings(), ...pending }
  function save(edits: Partial<Omit<SessionSettings, 'schemaVersion'>>, restore = false): void {
    const version = ++editVersion.current
    const generation = lifecycle.current
    editsRef.current = edits; setPending(edits)
    const problems = validateSessionSettings({ ...store.getSettings(), ...edits })
    setErrors(problems)
    if (problems.length) return
    inFlight.current++; setSaving(true)
    void store.patchSettingsAsync(edits, restore).then(success => {
      if (lifecycle.current !== generation || editVersion.current !== version) return
      if (success) { editsRef.current = {}; setPending({}) }
    }).catch(() => {
      if (lifecycle.current === generation && editVersion.current === version) setErrors(['设置保存失败，编辑值仍保留。'])
    }).finally(() => {
      if (lifecycle.current === generation) { inFlight.current--; setSaving(inFlight.current > 0) }
    })
  }
  function change(patch: Partial<Omit<SessionSettings, 'schemaVersion'>>): void {
    save({ ...editsRef.current, ...patch })
  }
  function reset(): void {
    const { schemaVersion: _, ...defaults } = DEFAULT_SESSION_SETTINGS
    save(defaults, true)
  }

  return h('section', { className: 'dsh-tp dsh-tp-settings', 'aria-label': '翻译设置' },
    h('style', null, styles),
    h('header', { className: 'dsh-tp-settings-header' }, h('h2', null, '翻译设置'),
      h('div', { className: 'dsh-tp-actions' }, button('恢复默认设置', reset, saving), onClose ? button('返回工作区', onClose) : null),
    ),
    h('p', { className: 'dsh-tp-muted' }, '有效修改即时保存到此设备。“+”新建主题采用默认设置；同主题子会话继承起点会话的配置。'),
    h('div', { className: 'dsh-tp-settings-section' },
      h('h3', null, '新会话默认值'),
      field('翻译模式', modeSelect(form.defaultMode, defaultMode => change({ defaultMode }))),
      field('目标语言', h('input', { value: form.targetLanguage, onChange: (event: TextEvent) => change({ targetLanguage: event.currentTarget.value }) })),
      field('翻译要求', h('textarea', { value: form.defaultInstruction, rows: 3, placeholder: '可留空', onChange: (event: TextEvent) => change({ defaultInstruction: event.currentTarget.value }) })),
      field('单次上限', h('input', { type: 'number', value: form.maxInputChars, min: 1, max: 200000, step: 1, onChange: (event: TextEvent) => change({ maxInputChars: Number(event.currentTarget.value) }) }), '原文字符数：1–200000。降低默认值不会裁剪已有输入。'),
    ),
    h('div', { className: 'dsh-tp-settings-section' },
      h('h3', null, '会话历史保存'),
      h('label', { className: 'dsh-tp-history-row' }, h('input', {
        type: 'checkbox', checked: form.rememberHistory, disabled: saving, 'aria-label': '允许保存会话历史到本地',
        onChange: (event: CheckEvent) => change({ rememberHistory: event.currentTarget.checked }),
      }), '允许保存会话历史到本地'),
      h('p', { className: 'dsh-tp-muted' }, '模型与推理等级选择独立保存在此设备，不受此开关影响。开启后自动保存主题名称、会话配置和当前原文草稿，以及已受理的原文、各版译文与定稿选择，数据以明文保存在此设备。已保存的历史保留；关闭后的后续内容仅保留在本次运行。'),
      h('p', { className: 'dsh-tp-muted' }, '关闭保存后，已保存过的主题仍会写入身份与编号元数据，以避免重用编号；其中不含主题名称、备注、原文或译文。完全临时主题的编号仅在本次运行中保留。'),
      store.getStructureCapability() === 'runtime-only' ? h('p', { className: 'dsh-tp-muted' }, '当前环境无法协调历史保存；开启保存与相关持久操作暂不可用。') : null,
      h(HistorySection, { store, terms }),
    ),
    errors.length ? h('div', { role: 'alert', className: 'dsh-tp-message' }, ...errors.map(error => h('p', { key: error }, error))) : null,
    storeNotice(store),
    Object.keys(pending).length && !errors.length && !saving ? button('重试保存失败的修改', () => change({})) : null,
  )
}
