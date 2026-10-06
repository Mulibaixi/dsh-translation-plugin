import { h, react } from './react.js'
import { styles } from './view-styles.js'
import { downloadExport } from './browser-download.js'
import { TopicTermsView, type TopicTermsViewPort } from './topic-terms-view.js'
import { MemoryTranslationRecordsView } from './memory-translation-records-view.js'
import type { SessionStore } from './session-store.js'
import type { QuickTranslationClient } from './quick-translation.js'
import type { TopicBridgeClient } from './topic-bridge.js'
import type { TopicTerm, TopicTermSnapshot } from '../memory/topic-terms.js'
import type { TopicTermsExport } from './topic-terms-export.js'

/** One resource owns a fixed owner/topic. Selection in the translator is unrelated. */
export function MemoryAssetsView({ store, terms, quick, topics, ownerId, topicId, onDeleteTerm }: {
  readonly store: SessionStore; readonly terms: TopicTermsViewPort; readonly quick: QuickTranslationClient
  readonly topics?: TopicBridgeClient | undefined; readonly ownerId: string; readonly topicId: string
  readonly onDeleteTerm: (snapshot: TopicTermSnapshot, entry: TopicTerm) => Promise<boolean>
}): unknown {
  const [, refresh] = react.useState(0)
  const [category, setCategory] = react.useState<'terms' | 'translations'>('terms')
  const [exportNotice, setExportNotice] = react.useState<{ message: string; failure: boolean } | undefined>(undefined)
  react.useEffect(() => store.subscribe(() => refresh(value => value + 1)), [store])
  react.useEffect(() => topics?.retain(ownerId), [topics, ownerId])
  react.useEffect(() => topics?.subscribe(() => refresh(value => value + 1)), [topics])
  const topic = store.getTopics(ownerId).find(topic => topic.id === topicId)
  function deliver(result: TopicTermsExport): void {
    try { downloadExport(result); setExportNotice({ message: '已向浏览器发起下载。', failure: false }) }
    catch { setExportNotice({ message: '无法启动下载，请重试。', failure: true }) }
  }
  return h('section', { className: 'dsh-tp dsh-tp-assets', 'aria-label': '记忆资产', 'data-owner-id': ownerId, 'data-topic-id': topicId },
    h('style', null, styles),
    h('header', { className: 'dsh-tp-assets-header' },
      h('div', { className: 'dsh-tp-assets-heading' }, h('h2', null, topic ? `${topic.name} · 记忆资产` : '记忆资产'),
        h('small', { className: 'dsh-tp-muted', title: ownerId }, `所属主会话：${ownerId}`))),
    store.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-message' }, store.getNotice()) : null,
    topic ? h('div', { className: 'dsh-tp-assets-body' },
      h('nav', { className: 'dsh-tp-assets-nav', 'aria-label': '资产分类' },
        h('button', { type: 'button', 'aria-current': category === 'translations', onClick: () => setCategory('translations') }, '译文记录'),
        h('button', { type: 'button', 'aria-current': category === 'terms', onClick: () => setCategory('terms') }, '结构化档案'),
        h('button', { type: 'button', disabled: true }, '其他记忆 · 暂未开放'),
        h('button', { type: 'button', disabled: true }, '临时文件 · 暂未开放')),
      h('div', { className: 'dsh-tp-assets-content' },
        // Both bodies remain mounted so switching categories retains local edit drafts.
        h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'terms' },
          h(TopicTermsView, { key: JSON.stringify([ownerId, topicId]), sessions: store, terms, ownerId, topicId, topicName: topic.name,
            onDelete: onDeleteTerm, onExport: deliver, bridgeReason: topics?.getStatus(ownerId).reason,
            onReconnect: topics ? () => { void topics.reset(ownerId) } : undefined }),
          exportNotice ? h('p', { className: 'dsh-tp-message', role: exportNotice.failure ? 'alert' : 'status' }, exportNotice.message) : null),
        h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'translations' },
          h(MemoryTranslationRecordsView, { key: JSON.stringify([ownerId, topicId]), store, quick, ownerId, topicId }))))
      : h('p', { className: 'dsh-tp-message', role: 'status' }, '此主题不可用，请从所属主会话打开记忆资产。'),
  )
}
