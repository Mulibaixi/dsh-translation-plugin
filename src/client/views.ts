import { h, react } from './react.js'
import { ModelPicker } from './model-picker.js'
import { type ModelCatalog } from './models.js'
import { type QuickTranslationClient, type QuickRecord } from './quick-translation.js'
import { type HistoryVersion, type SessionStore } from './session-store.js'
import { DEFAULT_SESSION_SETTINGS, validateSessionSettings, type LocalSession, type SessionSettings } from './sessions.js'
import { Menu, MenuGroup, MenuItemButton, IconChevronDownOutlineRegular, IconPanelLeftOutlineRegular, IconSendOutlineMedium } from './native-ui.js'

type TextEvent = { currentTarget: { value: string } }
type CheckEvent = { currentTarget: { checked: boolean } }
type FileEvent = { currentTarget: { files: FileList | null; value: string } }
interface StoreProps { readonly store: SessionStore }
const styles = `
.dsh-tp { box-sizing: border-box; color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 14px; line-height: 1.6; }
.dsh-tp * { box-sizing: border-box; }
.dsh-tp button, .dsh-tp input, .dsh-tp select, .dsh-tp textarea { font: inherit; color: inherit; }
.dsh-tp button { border: 0; background: transparent; border-radius: 6px; padding: 5px 8px; cursor: pointer; }
.dsh-tp button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.dsh-tp button:disabled { opacity: .45; cursor: default; }
.dsh-tp :focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #568bf0); outline-offset: 2px; }
.dsh-tp input:not([type=checkbox]), .dsh-tp textarea, .dsh-tp select { min-width: 0; padding: 8px; border: 1px solid var(--dsw-alias-border-l2, #8884); border-radius: 6px; background: var(--dsw-specific-input-major, #8881); }
.dsh-tp-panel { height: 100%; max-height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; container-type: inline-size; }
.dsh-tp-workspace { min-height: 0; height: 100%; display: flex; overflow: hidden; }
.dsh-tp-session-sidebar { flex: 0 0 160px; min-height: 0; padding: 10px 6px; border-right: 1px solid var(--dsw-alias-border-l2, #8883); overflow-y: auto; }
.dsh-tp-session-sidebar[hidden] { display: none; }
.dsh-tp-session-list { display: flex; flex-direction: column; gap: 3px; }
.dsh-tp-session-item { display: block; width: 100%; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-tp-session-name, .dsh-tp-session-remark { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tp-session-remark { color: var(--dsw-alias-label-caption, #888); font-size: 11px; line-height: 1.5; }
.dsh-tp-session-item[aria-current=true] { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.dsh-tp-session-add { display: flex; align-items: center; justify-content: center; width: 100%; align-self: stretch; text-align: center; margin-top: 2px; }
.dsh-tp-session-divider { border-top: 1px solid var(--dsw-alias-border-l2, #8883); margin: 4px 0; }
.dsh-tp-archive-toggle { width: 100%; margin-top: 14px; text-align: left; font-size: 12px !important; color: var(--dsw-alias-label-caption, #888) !important; }
.dsh-tp-main { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
.dsh-tp-workspace-header { display: flex; align-items: center; gap: 5px; flex: none; padding: 8px 10px; }
.dsh-tp-title-select { min-width: 0; flex: 1; }
.dsh-tp-title-anchor { display: block; min-width: 0; width: 100%; }
.dsh-tp-current-title { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; text-align: left; }
.dsh-tp-current-title-text { min-width: 0; flex: 1; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.dsh-tp-session-choice { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; }
.dsh-tp-session-choice-name { display: block; min-width: 0; flex: 1; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.dsh-tp-session-choice[aria-current=true] { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.dsh-tp-header-options { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: none; margin-left: auto; }
.dsh-tp-compact-trigger { display: flex; align-items: center; gap: 4px; font-weight: 400; white-space: nowrap; max-width: 110px; }
.dsh-tp-compact-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dsh-tp-chevron { color: var(--dsw-alias-label-caption, #888); flex: none; transition: transform .12s; }
.dsh-tp-chevron-open { transform: rotate(180deg); }
.dsh-tp-popup { z-index: 1100; min-width: 180px; max-width: min(320px, calc(100vw - 32px)); max-height: min(420px, calc(100vh - 96px)); overflow-y: auto; }
.dsh-tp-popup .dsh-tp-menu-content { padding: 4px; }
@container (max-width: 520px) { .dsh-tp-session-sidebar { flex-basis: 120px; } .dsh-tp-workspace-header { padding: 8px 6px; gap: 2px; } .dsh-tp-header-options { gap: 2px; } }
.dsh-tp-transcript { flex: 1 1 0; min-height: 0; overflow-y: scroll; overflow-x: hidden; scrollbar-gutter: stable; padding: 12px 16px; overscroll-behavior: contain; }
.dsh-tp-empty { color: var(--dsw-alias-label-caption, #888); text-align: center; padding: 28px 8px; font-size: 13px; }
.dsh-tp-composer-area { flex: none; margin: 8px 12px 12px; }
.dsh-tp-service-status { display: flex; align-items: center; gap: 6px; margin: 0 3px 4px; color: var(--dsw-alias-label-caption, #888); font-size: 11px; line-height: 1.5; }
.dsh-tp-service-status-text { min-width: 0; flex: 1; }
.dsh-tp button.dsh-tp-service-recheck { display: flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; height: 24px; padding: 4px; }
.dsh-tp-service-recheck[aria-busy=true] svg { animation: dsh-tp-checking 1s linear infinite; }
@keyframes dsh-tp-checking { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-tp-service-recheck[aria-busy=true] svg { animation: none; } }
.dsh-tp-runtime-note { display: block; margin: 4px 3px 0; color: var(--dsw-alias-label-caption, #888); font-size: 11px; line-height: 1.5; }
.dsh-tp-composer { padding: 10px; border-radius: var(--dsw-radius-panel, 14px); background: var(--dsw-specific-input-major, #8881); border: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-composer textarea { display: block; resize: none; width: 100%; min-height: 70px; max-height: 180px; overflow-y: auto; padding: 4px; background: transparent; border: 0; }
.dsh-tp-composer:focus-within, .dsh-tp-composer textarea:focus, .dsh-tp-composer textarea:focus-visible { outline: none !important; box-shadow: none !important; }
.dsh-tp-composer-toolbar { display: flex; justify-content: flex-end; align-items: center; gap: 6px; min-width: 0; }
.dsh-tp button.dsh-tp-attach { display: flex; align-items: center; justify-content: center; padding: 5px; margin-right: auto; }
.dsh-tp-attachment { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; }
.dsh-tp-attachment-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tp-attachment-note { margin: 2px 0 5px; color: var(--dsw-alias-label-caption, #888); font-size: 11px; }
/* DSH 主题全局使用 superellipse；普通圆形必须同时指定 corner-shape。 */
.dsh-tp .dsh-tp-send { display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; flex: 0 0 38px; border-radius: 50% !important; corner-shape: round !important; background: var(--dsw-alias-interactive-bg-accent, #4d7df3); color: #fff; padding: 0; }
.dsh-tp-muted { color: var(--dsw-alias-label-caption, #888); font-size: 12px; font-weight: 400; }
.dsh-tp-message { border-left: 3px solid #c68b32; padding: 6px 10px; margin: 6px 12px; font-size: 12px; overflow-wrap: anywhere; }
.dsh-tp-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dsh-tp-dialog { flex: none; padding: 12px; margin: 6px 12px; border: 1px solid var(--dsw-alias-border-l2, #8884); border-radius: 8px; max-height: 45%; overflow-y: auto; }
.dsh-tp-dialog p { margin: 6px 0; }
.dsh-tp-dialog input[type=text] { width: 100%; }
.dsh-tp-legacy { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover, #8881); }
.dsh-tp-translation { margin: 0 0 20px; }
.dsh-tp-translation-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 5px 0 12px; }
.dsh-tp-settings { padding: 16px 20px; height: 100%; max-height: 100%; min-height: 0; overflow-y: auto; }
.dsh-tp-settings-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-tp h2 { font-size: 18px; margin: 0; }
.dsh-tp h3 { font-size: 14px; margin: 0 0 12px; }
.dsh-tp-settings-section { padding: 18px 0; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-field { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
.dsh-tp-field textarea { resize: vertical; min-height: 80px; }
.dsh-tp-history-list { max-height: 280px; overflow-y: auto; margin: 12px 0; }
.dsh-tp-history-row { display: flex; gap: 8px; padding: 7px 0; align-items: flex-start; }
.dsh-tp-history-row input { margin-top: 6px; }
.dsh-tp-history-row span { overflow-wrap: anywhere; }
.dsh-tp-model { min-width: 0; flex: 0 1 auto; }
.dsh-tp-model-anchor { display: block; min-width: 0; max-width: 100%; }
.dsh-tp-model-trigger { display: flex; align-items: center; gap: 4px; max-width: 100%; font-size: 13px !important; font-weight: 400; }
.dsh-tp-model-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsh-tp-model-effort { min-width: 0; flex-shrink: 1000; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsh-tp-model-menu { min-width: min(260px, calc(100vw - 32px)); }
/* 与 DSH 原生紧凑菜单（目标语言）的文字规格一致。 */
.dsh-tp-model-menu .dsh-tp-menu-content { font-size: 11px; line-height: 17px; }
.dsh-tp-model-menu .dsh-tp-muted { font-size: inherit; line-height: inherit; }
.dsh-tp-popup .dsh-tp-language-custom { font-size: 11px; line-height: 17px; }
.dsh-tp-model-menu input { width: 100%; margin-bottom: 6px; }
.dsh-tp-model-search:focus, .dsh-tp-model-search:focus-visible { outline: none !important; box-shadow: none !important; border-color: var(--dsw-alias-border-l2, #8884) !important; }
.dsh-tp-model-list { max-height: 260px; overflow-y: auto; }
.dsh-tp-model-row { display: block; text-align: left; width: 100%; font-weight: 400; }
.dsh-tp-model-cell { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; }
.dsh-tp-model-cell-value { margin-left: auto; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`

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

export function PanelRouter({ store, models, quick, sessionId }: StoreProps & { readonly models: ModelCatalog; readonly quick: QuickTranslationClient; readonly sessionId?: string | undefined }): unknown {
  return h('section', { className: 'dsh-tp dsh-tp-panel', 'aria-label': '翻译面板' }, h('style', null, styles),
    sessionId?.trim() ? h(WorkspaceView, { store, models, quick, ownerId: sessionId, key: sessionId })
      : h('p', { role: 'alert' }, '请在主窗口会话中打开翻译面板。'),
  )
}

interface ContextRequest { readonly id: string; readonly x: number; readonly y: number; readonly trigger?: HTMLElement | undefined }
type WorkspaceDialog = { readonly kind: 'rename' | 'remark' | 'reload'; readonly id: string }
type ContextEvent = { preventDefault(): void; stopPropagation(): void; readonly clientX: number; readonly clientY: number; readonly currentTarget?: HTMLElement }

function sessionTitle(session: LocalSession): string {
  const label = session.remark ? `${session.name} · ${session.remark}` : session.name
  return session.legacyName ? `${label}\n旧名称：${session.legacyName}` : label
}
function sessionLabel(session: LocalSession): unknown {
  return h('span', { className: 'dsh-tp-session-choice-name' },
    h('span', { className: 'dsh-tp-session-name' }, session.name),
    session.remark ? h('span', { className: 'dsh-tp-session-remark' }, session.remark) : null,
  )
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

function SessionPicker({ store, ownerId, current, open, onOpenChange: setOpen, contextOpen, onDismissContext, onContext, onContextKeys, creating, onCreate }: StoreProps & {
  readonly ownerId: string; readonly current: LocalSession | undefined
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void
  readonly contextOpen: boolean; readonly onDismissContext: () => void
  readonly onContext: (session: LocalSession, event: ContextEvent) => void
  readonly onContextKeys: (session: LocalSession, event: KeyboardEvent & { currentTarget: HTMLElement }) => void
  readonly creating: boolean; readonly onCreate: () => void
}): unknown {
  const sessions = store.getActiveSessions(ownerId)
  const archived = store.getArchivedSessions(ownerId)
  function row(session: LocalSession, restore = false): unknown {
    return h('button', {
      type: 'button', role: 'menuitem', key: session.id, className: 'dsh-tp-session-choice', title: sessionTitle(session),
      'aria-label': `${restore ? '恢复归档会话' : '切换翻译会话'}：${sessionTitle(session)}`, 'aria-current': current?.id === session.id,
      onClick: () => { if (restore && !store.archiveSession(ownerId, session.id, false)) return; if (!restore) store.openSession(ownerId, session.id); onDismissContext(); setOpen(false) },
      onContextMenu: (event: ContextEvent) => onContext(session, event),
      onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) onContextKeys(session, event)
      },
    }, sessionLabel(session), current?.id === session.id ? h('span', { 'aria-hidden': true }, '✓') : null)
  }
  return h('div', { className: 'dsh-tp-title-select' }, h(Menu, {
    open, onClose: () => { if (!contextOpen) setOpen(false) }, portal: true, compact: true, className: 'dsh-tp-title-anchor', listClassName: 'dsh-tp-popup',
    anchor: h('button', {
      type: 'button', className: 'dsh-tp-current-title', 'aria-label': current ? `当前翻译会话：${current.name}` : '选择翻译会话',
      title: current ? sessionTitle(current) : '选择翻译会话', 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => { onDismissContext(); setOpen(!open) },
      onPointerDown: (event: { stopPropagation(): void }) => { if (contextOpen) event.stopPropagation() },
      onContextMenu: current ? (event: ContextEvent) => onContext(current, event) : undefined,
      onKeyDown: current ? (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) onContextKeys(current, event)
      } : undefined,
    }, h('span', { className: 'dsh-tp-current-title-text' }, current?.name ?? '选择翻译会话'),
      h(IconChevronDownOutlineRegular, { size: 14, className: `dsh-tp-chevron${open ? ' dsh-tp-chevron-open' : ''}` }),
    ),
  }, h('div', { className: 'dsh-tp dsh-tp-menu-content', 'aria-label': '已有翻译会话',
    onPointerDown: (event: { stopPropagation(): void }) => { if (contextOpen) event.stopPropagation() },
  },
    ...sessions.map(session => row(session)),
    archived.length ? h(MenuGroup, { label: '已归档（点击恢复）' }, ...archived.map(session => row(session, true))) : null,
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

function WorkspaceView({ store, models, quick, ownerId }: StoreProps & { readonly models: ModelCatalog; readonly quick: QuickTranslationClient; readonly ownerId: string }): unknown {
  useStore(store)
  const [, refreshQuick] = react.useState(0)
  react.useEffect(() => quick.subscribe(() => refreshQuick(value => value + 1)), [quick])
  react.useEffect(() => models.subscribe(() => refreshQuick(value => value + 1)), [models])
  react.useEffect(() => { void quick.load() }, [quick])
  const [sidebar, setSidebar] = react.useState(false)
  const [sessionPickerOpen, setSessionPickerOpen] = react.useState(false)
  const [archives, setArchives] = react.useState(false)
  const [context, setContext] = react.useState<ContextRequest | undefined>(undefined)
  const [dialog, setDialog] = react.useState<WorkspaceDialog | undefined>(undefined)
  const [deletion, setDeletion] = react.useState<DeleteRequest | undefined>(undefined)
  const [name, setName] = react.useState('')
  const [remark, setRemark] = react.useState('')
  const [files, setFiles] = react.useState(() => new Map<string, File>())
  const fileInput = react.useRef<HTMLInputElement | null>(null)
  react.useEffect(() => store.subscribe(() => setFiles(currentFiles => {
    if ([...currentFiles.keys()].every(id => store.getSession(id))) return currentFiles
    return new Map([...currentFiles].filter(([id]) => store.getSession(id)))
  })), [store])
  const action = useAsyncAction()
  react.useEffect(() => { store.ensureWorkspace(ownerId) }, [store, ownerId])
  const sessions = store.getActiveSessions(ownerId)
  const archived = store.getArchivedSessions(ownerId)
  const current = store.getActiveSession(ownerId)
  const target = context ? store.getSession(context.id) : undefined
  const dialogSession = dialog ? store.getSession(dialog.id) : undefined
  const status = current ? store.getStatus(current.id) : 'memory'
  const records = current ? quick.getRecords(current.id) : []
  const blocked = current ? quick.blockedReason(current) : undefined
  const busy = current ? quick.isBusy(current.id) : false
  const readiness = quick.getReadiness()
  const checking = readiness.status === 'loading' || readiness.status === 'idle'
  const serviceStatus = current?.mode === 'normal' ? blocked : readiness.status !== 'ready'
    ? checking ? '正在检查翻译服务…' : readiness.reason : undefined
  function contextMenu(session: LocalSession, event: ContextEvent): void {
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
  function sessionItem(session: LocalSession): unknown {
    return h('button', {
      key: session.id, type: 'button', className: 'dsh-tp-session-item', title: sessionTitle(session),
      'aria-current': session.id === current?.id, 'aria-haspopup': 'menu',
      onClick: () => { store.openSession(ownerId, session.id); setContext(undefined) },
      onContextMenu: (event: ContextEvent) => contextMenu(session, event),
      onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLElement }) => contextKeys(session, event),
    }, sessionLabel(session))
  }
  return h('div', { className: 'dsh-tp-workspace' },
    h('aside', { className: 'dsh-tp-session-sidebar', hidden: !sidebar, 'aria-label': '翻译会话侧栏' },
      h('div', { className: 'dsh-tp-session-list', 'aria-label': '使用中的翻译会话' },
        ...sessions.map(sessionItem),
        h('button', { type: 'button', className: 'dsh-tp-session-add', title: '新建主题及首会话', 'aria-label': '新建主题及首会话', disabled: action.pending, onClick: () => create() }, '+'),
      ),
      h('button', { type: 'button', className: 'dsh-tp-archive-toggle', 'aria-expanded': archives, onClick: () => setArchives(value => !value) }, `已归档（${archived.length}）`),
      archives ? h('div', { className: 'dsh-tp-session-list', 'aria-label': '已归档翻译会话' },
        ...archived.map(session => h('button', { type: 'button', className: 'dsh-tp-session-item', key: session.id, title: sessionTitle(session), 'aria-haspopup': 'menu',
          onContextMenu: (event: ContextEvent) => contextMenu(session, event),
          onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLElement }) => contextKeys(session, event),
          onClick: () => { if (store.archiveSession(ownerId, session.id, false)) setContext(undefined) },
        }, sessionLabel(session))),
        archived.length === 0 ? h('small', { className: 'dsh-tp-muted' }, '暂无归档会话。') : null,
      ) : null,
    ),
    h('div', { className: 'dsh-tp-main' },
      h('header', { className: 'dsh-tp-workspace-header' },
        h('button', { type: 'button', title: sidebar ? '收起会话侧栏' : '展开会话侧栏', 'aria-label': '切换会话侧栏', 'aria-expanded': sidebar, onClick: () => setSidebar(value => !value) }, h(IconPanelLeftOutlineRegular, { size: 16 })),
        h(SessionPicker, { store, ownerId, current, open: sessionPickerOpen, onOpenChange: setSessionPickerOpen, contextOpen: Boolean(context && target), onDismissContext: () => setContext(undefined), onContext: contextMenu, onContextKeys: contextKeys, creating: action.pending, onCreate: () => create() }),
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
        void action.run(() => store.deleteHistoryAsync(deletion.ids, false, deletion.unreadable, deletion.versions), () => setDeletion(currentRequest => currentRequest === deletion ? undefined : currentRequest))
      } }) : null,
      h('div', { className: 'dsh-tp-transcript', tabIndex: 0, 'aria-label': '翻译会话内容' },
        current?.legacyManualText ? h('div', null, h('p', { className: 'dsh-tp-muted' }, '旧版保存的人工译文'), h('div', { className: 'dsh-tp-legacy' }, current.legacyManualText)) : null,
        ...records.map(record => h(TranslationRecord, { key: record.id, record, quick, canRestore: !current?.input })),
        records.length === 0 && current?.mode !== 'normal' ? h('div', { className: 'dsh-tp-empty' }, current ? '在下方输入待翻译内容，选择模型后发送。' : '用“+”新建主题及首会话，或从已归档列表恢复。') : null,
      ),
      storeNotice(store),
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
        current.mode === 'normal' && files.has(current.id) ? h('div', null,
          h('div', { className: 'dsh-tp-attachment' },
            h('span', { className: 'dsh-tp-attachment-name', title: files.get(current.id)!.name }, files.get(current.id)!.name),
            h('button', { type: 'button', 'aria-label': '移除待译文件', title: '移除待译文件', onClick: () => setFiles(currentFiles => { const next = new Map(currentFiles); next.delete(current.id); return next }) }, '×'),
          ),
          h('p', { className: 'dsh-tp-attachment-note' }, '文件翻译尚未接入，所选文件仅暂存于本次打开的面板。'),
        ) : null,
        h('textarea', { value: current.input, 'aria-label': '待翻译内容', rows: 3, placeholder: '输入待翻译内容…', style: { outline: 'none', boxShadow: 'none' }, onChange: (event: TextEvent) => { store.updateSession(current.id, { input: event.currentTarget.value }) } }),
        Array.from(current.input).length > current.maxInputChars ? h('p', { role: 'alert', className: 'dsh-tp-muted' }, `已超过单次上限 ${current.maxInputChars} 个字符；内容保持完整。`) : null,
        h('div', { className: 'dsh-tp-composer-toolbar' },
          h('input', { type: 'file', hidden: true, ref: fileInput, key: `file:${current.id}`, 'aria-label': '待译文件', disabled: current.mode === 'quick',
            onChange: (event: FileEvent) => {
              const file = event.currentTarget.files?.[0]
              if (file && current.mode === 'normal') setFiles(currentFiles => new Map(currentFiles).set(current.id, file))
              event.currentTarget.value = ''
            },
          }),
          h('button', { type: 'button', className: 'dsh-tp-attach', 'aria-label': '选择待译文件', disabled: current.mode === 'quick',
            title: current.mode === 'quick' ? '快译仅支持纯文本，不能选择文件。' : '选择待译文件（文件翻译尚未接入）', onClick: () => fileInput.current?.click(),
          }, h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('path', { d: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3M6 15l9-9a2 2 0 0 1 3 3l-9 9' }),
          )),
          h(ModelPicker, { key: current.id, catalog: models, current: current.model, onSelect: (model: LocalSession['model']) => { store.updateSession(current.id, { model }) } }),
          h('button', { type: 'button', className: 'dsh-tp-send', disabled: !busy && !!blocked, title: busy ? '取消翻译' : blocked ?? '发送快译', 'aria-label': busy ? '取消翻译' : '发送快译', 'aria-description': busy ? undefined : blocked,
            onClick: () => { if (busy) quick.cancel(current.id); else void quick.send(current.id) },
            style: { width: 38, height: 38, minWidth: 38, maxWidth: 38, minHeight: 38, maxHeight: 38, padding: 0, borderRadius: '50%', cornerShape: 'round', aspectRatio: '1 / 1', flex: '0 0 38px' },
          }, busy ? h('span', { 'aria-hidden': true, style: { fontSize: 18, lineHeight: 1 } }, '■') : h(IconSendOutlineMedium, { size: 20 })),
        ),
        ),
        records.length ? h('small', { className: 'dsh-tp-runtime-note' }, '译文仅保留在本次运行中，重启后不恢复。') : null,
      ) : null,
    ),
    context && target ? h(Menu, { open: true, anchor: null, onClose: () => { setContext(undefined); setSessionPickerOpen(false) }, portal: true, autoFocus: true, compact: true, listClassName: 'dsh-tp-popup',
      getAnchorRect: () => ({ left: context.x, right: context.x, top: context.y, bottom: context.y, width: 0, height: 0 }),
    }, h('div', { 'aria-label': '翻译会话右键操作', onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setContext(undefined); context.trigger?.focus() }
      },
    },
      h(MenuItemButton, { disabled: action.pending, onSelect: () => create(target.id) }, '新建同主题子会话'),
      h(MenuItemButton, { disabled: action.pending, onSelect: () => { closeSessionMenus(); setName(target.topicName); setDialog({ kind: 'rename', id: target.id }) } }, '重命名主题'),
      h(MenuItemButton, { disabled: action.pending, onSelect: () => { closeSessionMenus(); setRemark(target.remark); setDialog({ kind: 'remark', id: target.id }) } }, '编辑会话备注'),
      h(MenuItemButton, { disabled: action.pending, danger: true, onSelect: () => {
        closeSessionMenus(); setDeletion({ title: `删除「${target.name}」`, ids: [target.id], unreadable: [], versions: store.captureHistoryVersions([target.id]) })
      } }, '删除'),
      h(MenuItemButton, { disabled: action.pending, onSelect: () => { closeSessionMenus(); store.archiveSession(ownerId, target.id, target.archivedAt === null) } }, target.archivedAt === null ? '归档' : '恢复归档'),
    )) : null,
  )
}

interface DeleteRequest { readonly title: string; readonly ids: readonly string[]; readonly unreadable: readonly { readonly key: string; readonly raw: string }[]; readonly versions: readonly HistoryVersion[] }
function DeleteDialog({ request, onCancel, onConfirm, sessionDeletion = false, pending = false }: {
  readonly request: DeleteRequest; readonly onCancel: () => void; readonly onConfirm: () => void; readonly sessionDeletion?: boolean; readonly pending?: boolean
}): unknown {
  return h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': sessionDeletion ? '删除翻译会话确认' : '删除会话历史确认', 'aria-busy': pending },
    h('h3', null, request.title),
    h('p', null, sessionDeletion ? '将删除该会话的当前内容与已保存历史，并从列表移除。'
      : `将删除 ${request.ids.length} 条会话历史${request.unreadable.length ? `及 ${request.unreadable.length} 份无法读取的历史副本` : ''}，并从会话列表移除。`),
    h('p', null, '是否联动删除关联记忆档案？'),
    h('label', { className: 'dsh-tp-history-row' }, h('input', { type: 'radio', name: 'translation-memory-deletion', checked: true, readOnly: true }), '保留关联记忆档案'),
    h('label', { className: 'dsh-tp-history-row' }, h('input', { type: 'radio', name: 'translation-memory-deletion', disabled: true, checked: false, readOnly: true }), '同时删除关联记忆档案（尚未接入）'),
    h('p', { className: 'dsh-tp-muted' }, '记忆系统尚未接入；本次保留关联记忆。'),
    h('div', { className: 'dsh-tp-actions' }, button(pending ? '正在删除…' : sessionDeletion ? '确认删除会话' : '确认删除历史', onConfirm, pending), button('取消', onCancel, pending)),
  )
}
function HistorySection({ store }: StoreProps): unknown {
  useStore(store)
  const [selected, setSelected] = react.useState<readonly string[]>([])
  const [request, setRequest] = react.useState<DeleteRequest | undefined>(undefined)
  const action = useAsyncAction()
  const history = store.getHistory()
  const selectedIds = selected.filter(id => history.some(session => session.id === id))
  function choose(title: string, ids: readonly string[], all = false): void {
    setRequest({ title, ids, unreadable: all ? store.getUnreadableHistory() : [], versions: store.captureHistoryVersions(ids) })
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
        void action.run(() => store.deleteHistoryAsync(request.ids, false, request.unreadable, request.versions), () => { setSelected([]); setRequest(currentRequest => currentRequest === request ? undefined : currentRequest) })
      } }) : null,
    action.failure ? h('div', { role: 'alert', className: 'dsh-tp-message' }, action.failure) : null,
  )
}

export function SettingsView({ store, onClose }: StoreProps & { readonly onClose?: (() => void) | undefined }): unknown {
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
      h('p', { className: 'dsh-tp-muted' }, '模型与推理等级选择独立保存在此设备，不受此开关影响。开启后自动保存主题名称、会话配置和当前原文草稿，数据以明文保存在此设备；不保存已提交的快译原文和译文记录。关闭后保留已有历史，停止写入新的会话内容。'),
      h('p', { className: 'dsh-tp-muted' }, '关闭保存后，已保存过的主题仍会写入身份与编号元数据，以避免重用编号；其中不含主题名称、备注、原文或译文。完全临时主题的编号仅在本次运行中保留。'),
      store.getStructureCapability() === 'runtime-only' ? h('p', { className: 'dsh-tp-muted' }, '当前环境无法协调历史保存；开启保存与相关持久操作暂不可用。') : null,
      h(HistorySection, { store }),
    ),
    errors.length ? h('div', { role: 'alert', className: 'dsh-tp-message' }, ...errors.map(error => h('p', { key: error }, error))) : null,
    storeNotice(store),
    Object.keys(pending).length && !errors.length && !saving ? button('重试保存失败的修改', () => change({})) : null,
  )
}
