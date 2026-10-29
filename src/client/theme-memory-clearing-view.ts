import { h, react } from './react.js'
import { Menu, MenuItemButton, IconChevronDownOutlineRegular, Toast } from './native-ui.js'
import { DEFAULT_THEME_MEMORY_CLEAR_SELECTION, type ThemeMemoryClearing, type ThemeMemoryClearPlan,
  type ThemeMemoryClearSelection, type ThemeMemoryClearResult } from './theme-memory-clearing.js'

/** The toolbar menu and inline confirmation share one frozen scope, even when asset filters change. */
export function useThemeMemoryClearing({ clearing, ownerId, topicId, visible }: {
  readonly clearing: ThemeMemoryClearing | undefined; readonly ownerId: string; readonly topicId: string; readonly visible: boolean
}): { readonly menu: unknown; readonly dialog: unknown; readonly feedback: unknown } {
  const [, refresh] = react.useState(0)
  const [open, setOpen] = react.useState(false)
  const [plan, setPlan] = react.useState<ThemeMemoryClearPlan | undefined>(undefined)
  const [selection, setSelection] = react.useState<ThemeMemoryClearSelection>(DEFAULT_THEME_MEMORY_CLEAR_SELECTION)
  const [completed, setCompleted] = react.useState<ThemeMemoryClearSelection>({ terms: false, archive: false })
  const [pending, setPending] = react.useState(false)
  const [notice, setNotice] = react.useState<{ readonly id: number; readonly result: ThemeMemoryClearResult } | undefined>(undefined)
  const scope = JSON.stringify([ownerId, topicId])
  const lifetime = react.useRef({ mounted: true, visible, scope, sequence: 0, pending: false })
  lifetime.current.visible = visible; lifetime.current.scope = scope
  react.useEffect(() => clearing?.subscribe(() => refresh(value => value + 1)), [clearing])
  react.useEffect(() => {
    lifetime.current.mounted = true
    return () => { lifetime.current.mounted = false }
  }, [])
  react.useEffect(() => { setOpen(false); setPlan(undefined); setNotice(undefined) }, [ownerId, topicId, visible])
  const blocked = clearing?.getBlockedReason(ownerId, topicId)
  const feedback = visible && notice ? notice.result.status === 'cleared'
    ? h(Toast, { key: notice.id, text: notice.result.message, tone: 'success', holdMs: 2500,
      onDone: () => { if (lifetime.current.mounted) setNotice(current => current?.id === notice.id ? undefined : current) } })
    : h('p', { role: 'alert', className: 'dsh-tp-message' }, notice.result.message) : null
  function showFailure(message: string): void {
    setNotice({ id: ++lifetime.current.sequence, result: { status: 'failed', terms: 'not_started', archive: 'not_started', message } })
  }
  async function prepare(): Promise<void> {
    setOpen(false)
    if (!clearing || lifetime.current.pending) return
    const requestedScope = scope
    lifetime.current.pending = true; setPending(true)
    try {
      const captured = await clearing.captureAsync(ownerId, topicId)
      if (!lifetime.current.mounted || !lifetime.current.visible || lifetime.current.scope !== requestedScope) return
      setPlan(captured); setSelection(DEFAULT_THEME_MEMORY_CLEAR_SELECTION); setCompleted({ terms: false, archive: false }); setNotice(undefined)
    } catch { if (lifetime.current.mounted && lifetime.current.visible && lifetime.current.scope === requestedScope) showFailure('当前术语或档案副本已变化或无法读取，请在相应界面读取最新副本后重新确认清空。') }
    finally { lifetime.current.pending = false; if (lifetime.current.mounted) setPending(false) }
  }
  async function confirm(): Promise<void> {
    if (!clearing || !plan || lifetime.current.pending) return
    const requestedScope = scope
    lifetime.current.pending = true; setPending(true); setNotice(undefined)
    try {
      const result = await clearing.clear(plan, selection)
      if (!lifetime.current.mounted || !lifetime.current.visible || lifetime.current.scope !== requestedScope) return
      setNotice({ id: ++lifetime.current.sequence, result })
      setCompleted(current => ({ terms: current.terms || result.terms === 'cleared', archive: current.archive || result.archive === 'cleared' }))
      if (result.status === 'cleared' || result.status === 'stale') setPlan(undefined)
      if (result.status === 'partial') setSelection({ terms: result.terms === 'failed', archive: result.archive === 'failed' })
    } catch {
      if (lifetime.current.mounted && lifetime.current.visible && lifetime.current.scope === requestedScope) showFailure('清空操作未完成，请核对当前记忆后重试。')
    } finally { lifetime.current.pending = false; if (lifetime.current.mounted) setPending(false) }
  }
  const option = (kind: 'terms' | 'archive', label: string): unknown => {
    if (!plan) return null
    const version = plan[kind], done = completed[kind]
    return h('label', { className: 'dsh-tp-check' }, h('input', { type: 'checkbox', 'aria-label': `清空${label}`, checked: selection[kind], disabled: pending || done,
      onChange: (event: { currentTarget: { checked: boolean } }) => { const checked = event.currentTarget.checked; setSelection(current => ({ ...current, [kind]: checked })) } }),
      done ? `${label}：已清空` : `${label}：本次运行 ${version.currentCount} 条，${version.storageAvailable ? `已保存 ${version.storedCount} 条` : '已保存数量未知'}`)
  }
  return {
    menu: clearing ? h(Menu, { open: visible && open, onClose: () => setOpen(false), portal: true, compact: true, listClassName: 'dsh-tp-popup',
      anchor: h('button', { type: 'button', disabled: pending, 'aria-label': '本主题记忆管理', 'aria-haspopup': 'menu', 'aria-expanded': visible && open,
        onClick: () => setOpen(!open) }, '记忆管理', h(IconChevronDownOutlineRegular, { size: 12 })) },
      h('div', { className: 'dsh-tp dsh-tp-menu-content' }, h(MenuItemButton, { disabled: pending || !!blocked, onSelect: () => { void prepare() } }, '清空本主题记忆'),
        blocked ? h('p', { className: 'dsh-tp-muted' }, blocked) : null)) : null,
    dialog: visible && plan ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '清空本主题记忆确认', 'aria-busy': pending,
      'data-owner-id': plan.ownerId, 'data-topic-id': plan.topicId },
      h('p', null, `清空“${plan.topicName}”的所选记忆？此主题全部会话共用这些资产。`),
      option('terms', '术语'), option('archive', '结构化档案'),
      h('p', { className: 'dsh-tp-muted' }, '同时清空所选类型的已保存内容和本次运行内容。保留主题、会话原文与译文、编号、原件关联及模型偏好。'),
      !plan.terms.storageAvailable || !plan.archive.storageAvailable ? h('p', { className: 'dsh-tp-message' }, '部分本地存储不可用，只能清理对应的当前运行期记忆，本地保存副本无法确认清理。') : null,
      blocked ? h('p', { role: 'status', className: 'dsh-tp-message' }, blocked) : null,
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending || !!blocked || !selection.terms && !selection.archive,
        onClick: () => { void confirm() } }, pending ? '正在清空…' : completed.terms || completed.archive ? '重试未完成范围' : '确认清空所选记忆'),
        h('button', { type: 'button', disabled: pending, onClick: () => setPlan(undefined) }, '取消'))) : null,
    feedback,
  }
}
