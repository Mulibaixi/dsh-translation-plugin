import { h, react } from './react.js'
import { Menu, IconChevronDownOutlineRegular } from './native-ui.js'
import { resolveMemoryAssetsSelection, type MemoryAssetsNavigation } from './memory-assets-window.js'
import type { SessionStore } from './session-store.js'

// Match only our title inside the host's floating caption; buttons and resize retain host cursors.
export const MEMORY_ASSETS_TITLE_CURSOR_CSS = `
[data-dockkit-float] [data-dockkit-float-grip]:has([data-dockkit-float-title] [data-dsh-translation-assets-title]) { cursor: default; }
`

const titleStyles = `
/* Native float and docked titles share the tab chip's 170px cap. Release only our occurrence. */
[data-dockkit-float-title]:has([data-dsh-translation-assets-title]),
[data-dockkit-tab]:has([data-dsh-translation-assets-title]) { min-width: 0; max-width: none; }
.dsh-tp-assets-title { display: flex; flex: 1 1 auto; align-items: baseline; gap: 8px; width: 100%; min-width: 0; max-width: 100%; }
.dsh-tp-assets-title-label { flex: 0 0 auto; white-space: nowrap; font-size: 14px; font-weight: 700; }
.dsh-tp-assets-title-session { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 400; }
.dsh-tp-assets-title-picker { display: block; flex: 0 1 auto; min-width: 0; }
.dsh-tp-assets-title button.dsh-tp-assets-topic-trigger { display: flex; align-items: center; gap: 3px; min-width: 0; max-width: 100%; border: 0; border-radius: 4px; padding: 0 3px; background: transparent; color: var(--dsw-alias-label-caption, #888); font: inherit; font-size: 11px; cursor: pointer; }
.dsh-tp-assets-topic-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tp-assets-title button:hover { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.dsh-tp-assets-title :focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #568bf0); outline-offset: 2px; }
`

export function MemoryAssetsTitle({ store, scope, onSelectTopic }: {
  readonly store: SessionStore
  readonly scope?: MemoryAssetsNavigation | undefined
  readonly onSelectTopic?: ((topicId: string) => void) | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  const [pickerOpen, setPickerOpen] = react.useState(false)
  const [query, setQuery] = react.useState('')
  react.useEffect(() => store.subscribe(() => refresh(value => value + 1)), [store])
  react.useEffect(() => { setPickerOpen(false); setQuery('') },
    [scope?.ownerId, scope?.topicId, scope?.requestedTopicId, scope?.associatedSessionId, scope?.navigationRevision])
  const selection = scope ? resolveMemoryAssetsSelection(store, scope) : undefined
  const sessionName = selection?.session ? selection.session.remark || selection.session.name : '无关联会话'
  const filtered = selection?.availableTopics.filter(topic => topic.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? []
  const stopPropagation = (event: { stopPropagation(): void }) => event.stopPropagation()
  return h('span', { className: 'dsh-tp-assets-title', 'data-dsh-translation-assets-title': true, 'data-owner-id': scope?.ownerId, 'data-topic-id': selection?.topicId },
    h('style', { 'data-assets-cursor-style': true }, MEMORY_ASSETS_TITLE_CURSOR_CSS), h('style', null, titleStyles),
    h('span', { className: 'dsh-tp-assets-title-label' }, '记忆资产'),
    scope ? h('span', { className: 'dsh-tp-assets-title-session', title: sessionName }, sessionName) : null,
    scope && onSelectTopic ? h('small', { className: 'dsh-tp-assets-title-picker',
      // The native caption and docked tab both initiate drag on bubbling pointerdown.
      onPointerDown: stopPropagation, onClick: stopPropagation, onContextMenu: stopPropagation,
    }, h(Menu, { open: pickerOpen, onClose: () => setPickerOpen(false), portal: true, compact: true, listClassName: 'dsh-tp-popup',
      anchor: h('button', { type: 'button', className: 'dsh-tp-assets-topic-trigger', title: selection?.topic?.name,
        'aria-label': '选择资产主题', 'aria-haspopup': 'menu', 'aria-expanded': pickerOpen,
        onClick: () => { setPickerOpen(!pickerOpen); setQuery('') } },
      h('span', null, selection?.topic?.name ?? '选择主题'), h(IconChevronDownOutlineRegular, { size: 12 })),
    }, h('div', { className: 'dsh-tp dsh-tp-menu-content', 'aria-label': '资产主题列表' },
      h('input', { value: query, 'aria-label': '搜索资产主题', placeholder: '搜索主题', onChange: (event: { currentTarget: { value: string } }) => setQuery(event.currentTarget.value) }),
      ...filtered.map(topic => h('button', { type: 'button', role: 'menuitem', className: 'dsh-tp-session-choice', key: topic.id, 'data-topic-id': topic.id,
        'aria-current': topic.id === selection?.topicId, onClick: () => { onSelectTopic(topic.id); setPickerOpen(false); setQuery('') } }, topic.name)),
      filtered.length ? null : h('p', { className: 'dsh-tp-muted', role: 'status' }, '没有匹配的主题。')))) : null)
}
