import { h, react } from './react.js'
import { styles } from './view-styles.js'
import { downloadExport } from './browser-download.js'
import { Menu, IconChevronDownOutlineRegular } from './native-ui.js'
import { TopicTermsView, type TopicTermsViewPort } from './topic-terms-view.js'
import { MemoryTranslationRecordsView } from './memory-translation-records-view.js'
import type { SessionStore } from './session-store.js'
import type { QuickTranslationClient } from './quick-translation.js'
import type { TopicBridgeClient } from './topic-bridge.js'
import type { TopicTerm, TopicTermSnapshot } from '../memory/topic-terms.js'
import type { TopicTermsExport } from './topic-terms-export.js'

interface MemoryAssetsProps {
  readonly store: SessionStore; readonly terms: TopicTermsViewPort; readonly quick: QuickTranslationClient
  readonly topics?: TopicBridgeClient | undefined; readonly ownerId: string; readonly topicId: string
  readonly onDeleteTerm: (snapshot: TopicTermSnapshot, entry: TopicTerm) => Promise<boolean>
}

/** One resource owns a fixed main conversation; topic selection only changes this asset view. */
export function MemoryAssetsView({ store, terms, quick, topics, ownerId, topicId, associatedSessionId, requestedTopicId, navigationRevision, onDeleteTerm }: MemoryAssetsProps & {
  readonly associatedSessionId?: string | undefined; readonly requestedTopicId?: string | undefined; readonly navigationRevision?: number | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  const availableTopics = store.getTopics(ownerId)
  const initialTopicId = availableTopics.some(topic => topic.id === requestedTopicId) ? requestedTopicId! : topicId
  const [selection, setSelection] = react.useState(() => ({ topicId: initialTopicId, sessionId: associatedSessionId }))
  const [visited, setVisited] = react.useState<readonly string[]>(() => [initialTopicId])
  const [pickerOpen, setPickerOpen] = react.useState(false)
  const [query, setQuery] = react.useState('')
  react.useEffect(() => store.subscribe(() => refresh(value => value + 1)), [store])
  react.useEffect(() => topics?.retain(ownerId), [topics, ownerId])
  react.useEffect(() => topics?.subscribe(() => refresh(value => value + 1)), [topics])
  react.useEffect(() => {
    const nextTopicId = requestedTopicId ?? topicId
    if (!store.getTopics(ownerId).some(topic => topic.id === nextTopicId)) return
    setSelection({ topicId: nextTopicId, sessionId: associatedSessionId })
    setVisited(current => current.includes(nextTopicId) ? current : [...current, nextTopicId])
    setPickerOpen(false)
  }, [store, ownerId, topicId, requestedTopicId, associatedSessionId, navigationRevision])
  const topic = availableTopics.find(topic => topic.id === selection.topicId)
  const requested = selection.sessionId ? store.getSession(selection.sessionId) : undefined
  const current = store.getActiveSession(ownerId)
  const session = requested?.ownerId === ownerId && requested.topicId === selection.topicId ? requested
    : current?.topicId === selection.topicId ? current : store.getAvailableSessions(ownerId).find(session => session.topicId === selection.topicId)
  const filtered = availableTopics.filter(topic => topic.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  function selectTopic(id: string): void {
    setSelection({ topicId: id, sessionId: undefined })
    setVisited(current => current.includes(id) ? current : [...current, id])
    setPickerOpen(false); setQuery('')
  }
  return h('section', { className: 'dsh-tp dsh-tp-assets', 'aria-label': '记忆资产', 'data-owner-id': ownerId, 'data-topic-id': selection.topicId },
    h('style', null, styles),
    h('header', { className: 'dsh-tp-assets-header' },
      h('div', { className: 'dsh-tp-assets-heading' },
        h('h2', { title: session ? session.remark || session.name : undefined }, session ? session.remark || session.name : '无关联会话'),
        h('small', { className: 'dsh-tp-muted dsh-tp-assets-topic-picker' }, h(Menu, {
          open: pickerOpen, onClose: () => setPickerOpen(false), portal: true, compact: true, listClassName: 'dsh-tp-popup',
          anchor: h('button', { type: 'button', className: 'dsh-tp-assets-topic-trigger', title: topic?.name,
            'aria-label': '选择资产主题', 'aria-haspopup': 'menu', 'aria-expanded': pickerOpen,
            onClick: () => { setPickerOpen(!pickerOpen); setQuery('') } },
          h('span', null, topic?.name ?? '选择主题'), h(IconChevronDownOutlineRegular, { size: 12 })),
        }, h('div', { className: 'dsh-tp dsh-tp-menu-content', 'aria-label': '资产主题列表' },
          h('input', { value: query, 'aria-label': '搜索资产主题', placeholder: '搜索主题', onChange: (event: { currentTarget: { value: string } }) => setQuery(event.currentTarget.value) }),
          ...filtered.map(topic => h('button', { type: 'button', role: 'menuitem', className: 'dsh-tp-session-choice', key: topic.id, 'data-topic-id': topic.id,
            'aria-current': topic.id === selection.topicId, onClick: () => selectTopic(topic.id) }, topic.name)),
          filtered.length ? null : h('p', { className: 'dsh-tp-muted', role: 'status' }, '没有匹配的主题。')))))),
    store.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-message' }, store.getNotice()) : null,
    ...visited.map(id => {
      const visitedTopic = availableTopics.find(topic => topic.id === id)
      return visitedTopic ? h('div', { key: id, className: 'dsh-tp-assets-topic', hidden: id !== selection.topicId },
        h(MemoryAssetsTopicView, { store, terms, quick, topics, ownerId, topicId: id, topicName: visitedTopic.name, onDeleteTerm })) : null
    }),
    topic ? null : h('p', { className: 'dsh-tp-message', role: 'status' }, '此主题不可用，请选择其他主题。'),
  )
}

function MemoryAssetsTopicView({ store, terms, quick, topics, ownerId, topicId, topicName, onDeleteTerm }: MemoryAssetsProps & { readonly topicName: string }): unknown {
  const [category, setCategory] = react.useState<'terms' | 'translations'>('terms')
  const [exportNotice, setExportNotice] = react.useState<{ message: string; failure: boolean } | undefined>(undefined)
  function deliver(result: TopicTermsExport): void {
    try { downloadExport(result); setExportNotice({ message: '已向浏览器发起下载。', failure: false }) }
    catch { setExportNotice({ message: '无法启动下载，请重试。', failure: true }) }
  }
  return h('div', { className: 'dsh-tp-assets-body' },
      h('nav', { className: 'dsh-tp-assets-nav', 'aria-label': '资产分类' },
        h('button', { type: 'button', 'aria-current': category === 'translations', onClick: () => setCategory('translations') }, '译文记录'),
        h('button', { type: 'button', 'aria-current': category === 'terms', onClick: () => setCategory('terms') }, '结构化档案'),
        h('button', { type: 'button', disabled: true }, '其他记忆 · 暂未开放'),
        h('button', { type: 'button', disabled: true }, '临时文件 · 暂未开放')),
      h('div', { className: 'dsh-tp-assets-content' },
        // Visited topics and both categories stay mounted to retain local edit drafts.
        h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'terms' },
          h(TopicTermsView, { sessions: store, terms, ownerId, topicId, topicName,
            onDelete: onDeleteTerm, onExport: deliver, bridgeReason: topics?.getStatus(ownerId).reason,
            onReconnect: topics ? () => { void topics.reset(ownerId) } : undefined }),
          exportNotice ? h('p', { className: 'dsh-tp-message', role: exportNotice.failure ? 'alert' : 'status' }, exportNotice.message) : null),
        h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'translations' },
          h(MemoryTranslationRecordsView, { store, quick, ownerId, topicId }))))
}
