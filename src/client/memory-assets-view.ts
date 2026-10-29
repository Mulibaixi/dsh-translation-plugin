import { OtherMemoryView } from './other-memory-view.js'
import type { OtherMemoryClient } from './other-memory-client.js'
import { h, react } from './react.js'
import { styles } from './view-styles.js'
import { downloadExport } from './browser-download.js'
import { useExportDownloadFeedback } from './export-download-feedback.js'
import { TopicTermsView, type TopicTermsViewPort } from './topic-terms-view.js'
import { MemoryTranslationRecordsView } from './memory-translation-records-view.js'
import type { SessionStore } from './session-store.js'
import type { QuickTranslationClient } from './quick-translation.js'
import type { TopicBridgeClient } from './topic-bridge.js'
import type { TopicTerm, TopicTermSnapshot } from '../memory/topic-terms.js'
import { resolveTermEvidence, type TermEvidenceRef } from '../memory/topic-terms.js'
import { isTextUnit } from './translation-history.js'
import { buildTopicArchiveJsonExport, buildTopicArchiveMarkdownExport, type TopicArchiveExportSnapshot } from './topic-archive-export.js'
import type { TopicArchiveStore } from './topic-archive-store.js'
import { TopicArchiveView } from './topic-archive-view.js'
import { resolveMemoryAssetsSelection } from './memory-assets-window.js'
import { Menu, IconChevronDownOutlineRegular } from './native-ui.js'
import type { RecordObjectsProps } from './record-object-view.js'

/** One row of peer choices: the archive kind is picked directly instead of through a dropdown. */
const archiveKinds = [
  { value: 'terms', label: '术语' },
  { value: 'entity', label: '实体' },
  { value: 'fact', label: '事实' },
  { value: 'relation', label: '关系' },
] as const
import type { DocumentViewProps } from './document-unit-view.js'
import type { ThemeMemoryClearing } from './theme-memory-clearing.js'
import { useThemeMemoryClearing } from './theme-memory-clearing-view.js'
import type { FileJobViewProps } from './file-job-view.js'
import { adoptTopicAssets, type TopicAssetKind } from './topic-asset-actions.js'
import { MemoryIndexView } from './memory-index-view.js'
import type { MemoryIndexClient } from './memory-index-client.js'

interface MemoryAssetsProps extends RecordObjectsProps, DocumentViewProps, FileJobViewProps {
  readonly memoryIndex?: MemoryIndexClient | undefined
  readonly store: SessionStore; readonly terms: TopicTermsViewPort; readonly quick: QuickTranslationClient
  readonly otherMemory?: OtherMemoryClient | undefined
  readonly mainSessionId?: string | undefined
  readonly archive: TopicArchiveStore
  readonly memoryClearing?: ThemeMemoryClearing | undefined
  readonly topics?: TopicBridgeClient | undefined; readonly ownerId: string; readonly topicId: string
  readonly onDeleteTerm: (snapshot: TopicTermSnapshot, entry: TopicTerm) => Promise<boolean>
}

/** One resource owns a fixed main conversation; topic selection only changes this asset view. */
export function MemoryAssetsView({ store, terms, archive, otherMemory, memoryIndex, mainSessionId, quick, topics, objects, objectAssets, viewFiles, documents, documentTasks, documentReviews, fileJobs, memoryClearing, ownerId, topicId, associatedSessionId, requestedTopicId, jobId, navigationRevision, onDeleteTerm, onSelectTopic }: MemoryAssetsProps & {
  readonly associatedSessionId?: string | undefined; readonly requestedTopicId?: string | undefined; readonly navigationRevision?: number | undefined
  readonly jobId?: string | undefined
  readonly onSelectTopic?: ((topicId: string) => void) | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  const { availableTopics, topicId: selectedTopicId, topic } = resolveMemoryAssetsSelection(store, { ownerId, topicId, requestedTopicId, associatedSessionId })
  const [visited, setVisited] = react.useState<readonly string[]>(() => [selectedTopicId])
  const [pickerOpen, setPickerOpen] = react.useState(false)
  const [query, setQuery] = react.useState('')
  react.useEffect(() => store.subscribe(() => refresh(value => value + 1)), [store])
  react.useEffect(() => ownerId === store.getNamespaceId() ? undefined : topics?.retain(ownerId), [topics, ownerId, store])
  react.useEffect(() => topics?.subscribe(() => refresh(value => value + 1)), [topics])
  react.useEffect(() => {
    if (!pickerOpen) return
    const closeForNativeTab = (event: PointerEvent): void => { if ((event.target as Element | null)?.closest?.('[data-dockkit-tab]')) setPickerOpen(false) }
    document.addEventListener('pointerdown', closeForNativeTab, true)
    return () => document.removeEventListener('pointerdown', closeForNativeTab, true)
  }, [pickerOpen])
  react.useEffect(() => {
    setVisited(current => current.includes(selectedTopicId) ? current : [...current, selectedTopicId])
    setPickerOpen(false); setQuery('')
  }, [ownerId, selectedTopicId, navigationRevision])
  return h('section', { className: 'dsh-tp dsh-tp-assets', 'aria-label': '记忆资产', 'data-owner-id': ownerId, 'data-topic-id': selectedTopicId },
    h('style', null, styles),
    // Docked tabs show a compact host title; their topic navigation lives in the Body.
    onSelectTopic ? h('div', { className: 'dsh-tp-assets-topic-toolbar' }, h(Menu, {
      open: pickerOpen, onClose: () => setPickerOpen(false), portal: true, compact: true, listClassName: 'dsh-tp-popup',
      anchor: h('button', { type: 'button', className: 'dsh-tp-assets-topic-trigger', title: topic?.name,
        'aria-label': '选择资产主题', 'aria-haspopup': 'menu', 'aria-expanded': pickerOpen,
        onClick: () => { setPickerOpen(!pickerOpen); setQuery('') } }, h('span', null, topic?.name ?? '选择主题'), h(IconChevronDownOutlineRegular, { size: 12 })),
    }, h('div', { className: 'dsh-tp dsh-tp-menu-content', 'aria-label': '资产主题列表' },
      h('input', { value: query, 'aria-label': '搜索资产主题', placeholder: '搜索主题', onChange: (event: { currentTarget: { value: string } }) => setQuery(event.currentTarget.value) }),
      ...availableTopics.filter(topic => topic.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(topic => h('button', {
        type: 'button', role: 'menuitem', className: 'dsh-tp-session-choice', key: topic.id, 'data-topic-id': topic.id, 'aria-current': topic.id === selectedTopicId,
        onClick: () => { onSelectTopic(topic.id); setPickerOpen(false); setQuery('') },
      }, topic.name))))) : null,
    store.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-message' }, store.getNotice()) : null,
    ...visited.map(id => {
      const visitedTopic = availableTopics.find(topic => topic.id === id)
      return visitedTopic ? h('div', { key: `${ownerId}:${id}`, className: 'dsh-tp-assets-topic', hidden: id !== selectedTopicId },
        h(MemoryAssetsTopicView, { store, terms, archive, otherMemory, memoryIndex, mainSessionId, quick, topics, objects, objectAssets, viewFiles, documents, documentTasks, documentReviews, fileJobs, memoryClearing, ownerId, topicId: id, topicName: visitedTopic.name, onDeleteTerm, jobId: id === selectedTopicId ? jobId : undefined,
          active: id === selectedTopicId, associatedSessionId: id === selectedTopicId ? associatedSessionId : undefined,
          navigationRevision: id === selectedTopicId ? navigationRevision : undefined })) : null
    }),
    topic ? null : h('p', { className: 'dsh-tp-message', role: 'status' }, '此主题不可用，请选择其他主题。'),
  )
}

function AssetAdoptionControl({ terms, archive, ownerId, topicId, kind, active, memoryIndex }: {
  readonly terms: TopicTermsViewPort; readonly archive: TopicArchiveStore; readonly ownerId: string; readonly topicId: string
  readonly kind: TopicAssetKind; readonly active: boolean; readonly memoryIndex?: MemoryIndexClient | undefined
}): unknown {
  const assets = kind === 'terms' ? terms : archive
  const [, refresh] = react.useState(0), [adopting, setAdopting] = react.useState(false), [notice, setNotice] = react.useState<string | undefined>(undefined)
  const busy = react.useRef(false), alive = react.useRef(true)
  react.useEffect(() => assets.subscribe(() => refresh(value => value + 1)), [assets])
  react.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const state = assets.getReadState(ownerId, topicId), ready = state.status === 'ready' && !state.retired
  const count = ready ? state.snapshot!.entries.filter(e => ['proposal', 'review_required'].includes(e.status) && (kind === 'terms' || ('kind' in e && e.kind === kind))).length : 0
  async function adopt(): Promise<void> {
    if (busy.current || !active || !ready || !count) return
    busy.current = true; setAdopting(true); setNotice(undefined)
    // A page switch may release its view, but must not evict a batch still being saved.
    const release = assets.retain(ownerId, topicId)
    try {
      const result = await adoptTopicAssets(terms, archive, ownerId, topicId, kind)
      if (alive.current) setNotice(`已采用 ${result.adopted} 条${result.remaining ? `，${result.remaining} 条仍待处理${kind === 'fact' || kind === 'relation' ? '，请核对条目及关联实体状态' : ''}` : ''}。`)
      void memoryIndex?.refresh(topicId)
    } catch (error) { if (alive.current) setNotice((error as Error).message) }
    finally { release(); busy.current = false; if (alive.current) setAdopting(false) }
  }
  if (!active) return null
  return h('div', { className: 'dsh-tp-actions' },
    h('button', { type: 'button', disabled: adopting || !ready || !count,
      title: '仅采用当前主题本类别的全部待确认和待复核条目，不受页内筛选影响；其他类别不变。事实和关系的关联实体须先采用。已停用和冲突条目保留。',
      onClick: () => { void adopt() } }, adopting ? '正在采用…' : `一键采用${count ? `（${count}）` : ''}`),
    notice ? h('span', { role: 'status', className: 'dsh-tp-message' }, notice) : null)
}

function MemoryAssetsTopicView({ store, terms, archive, otherMemory, memoryIndex, mainSessionId, quick, topics, objects, objectAssets, viewFiles, documents, documentTasks, documentReviews, fileJobs, memoryClearing, ownerId, topicId, topicName, onDeleteTerm, active, associatedSessionId, jobId, navigationRevision }: MemoryAssetsProps & {
  readonly topicName: string; readonly active: boolean
  readonly associatedSessionId?: string | undefined; readonly navigationRevision?: number | undefined
  readonly jobId?: string | undefined
}): unknown {
  const [category, setCategory] = react.useState<'terms' | 'translations' | 'other'>('terms')
  const [otherVisited, setOtherVisited] = react.useState(false)
  const [indexOpen, setIndexOpen] = react.useState(false)
  const [, refreshJobs] = react.useState(0)
  react.useEffect(() => fileJobs?.subscribe(() => refreshJobs(value => value + 1)), [fileJobs])
  react.useEffect(() => { if (jobId) setCategory('terms') }, [jobId, navigationRevision])
  const [kind, setKind] = react.useState<'terms' | 'entity' | 'fact' | 'relation'>('terms')
  react.useEffect(() => {
    if (!active) return
    // The four pages share this topic window's lifetime, rather than evicting each other on tab changes.
    const releaseTerms = terms.retain(ownerId, topicId), releaseArchive = archive.retain(ownerId, topicId)
    return () => { releaseTerms(); releaseArchive() }
  }, [terms, archive, ownerId, topicId, active])
  const [exportNotice, setExportNotice] = react.useState<{ message: string; failure: boolean } | undefined>(undefined)
  const exportFeedback = useExportDownloadFeedback(active && category === 'terms')
  const memoryClear = useThemeMemoryClearing({ clearing: memoryClearing, ownerId, topicId, visible: active && category === 'terms' })
  const evidenceContextKey = JSON.stringify([ownerId, topicId, associatedSessionId, navigationRevision])
  async function exportArchive(format: 'json' | 'markdown'): Promise<void> {
    exportFeedback.clear(); setExportNotice(undefined)
    try {
      const termState = terms.getReadState(ownerId, topicId)
      const archiveState = archive.getReadState(ownerId, topicId)
      // Freeze each already loaded category before awaiting the other category.
      const termRead = termState.status === 'ready' && termState.snapshot
        ? structuredClone(termState.snapshot) : terms.ensureLoaded(ownerId, topicId).then(value => structuredClone(value))
      const archiveRead = archiveState.status === 'ready' && archiveState.snapshot
        ? structuredClone(archiveState.snapshot) : archive.ensureLoaded(ownerId, topicId).then(value => structuredClone(value))
      const [frozenTerms, frozenArchive] = await Promise.all([termRead, archiveRead])
      const frozen = { terms: frozenTerms, archive: frozenArchive }
      function availability(snapshot: { readonly ownerId: string; readonly topicId: string; readonly entries: readonly { readonly id: string; readonly evidence: readonly TermEvidenceRef[] }[] }) {
        return snapshot.entries.flatMap(entry => entry.evidence.map((ref, evidenceIndex) => {
          const candidate = store.getSession(ref.sessionId)
          const session = candidate?.topicId === topicId && !store.isSessionDeleted(candidate.id) ? candidate : undefined
          const unit = session ? store.getTranslationHistory(session.id)?.units.find(unit => unit.id === ref.unitId) : undefined
          const revision = unit && isTextUnit(unit) ? unit.revisions.find(revision => revision.id === ref.revisionId) : undefined
          return { entryId: entry.id, evidenceIndex, sessionName: session?.name ?? null, unitOrder: unit?.order ?? null, revisionOrder: revision?.order ?? null,
            readable: resolveTermEvidence(snapshot, ref, (sessionId, unitId) => terms.readEvidence(sessionId, unitId)) !== undefined }
        }))
      }
      const input: TopicArchiveExportSnapshot = { ...frozen, topicName: store.getTopics(ownerId).find(topic => topic.id === topicId)?.name ?? topicName,
        exportedAt: new Date().toISOString(),
        termsStorageStatus: terms.getStatus(ownerId, topicId), archiveStorageStatus: archive.getStatus(ownerId, topicId),
        termEvidenceAvailability: availability(frozen.terms), archiveEvidenceAvailability: availability(frozen.archive) }
      const download = format === 'json' ? buildTopicArchiveJsonExport(input) : buildTopicArchiveMarkdownExport(input)
      downloadExport(download); exportFeedback.downloadStarted(download.fileName)
    } catch (error) { setExportNotice({ message: `档案导出未完成：${error instanceof Error ? error.message : '请重试。'}`, failure: true }) }
  }
  return h('div', { className: 'dsh-tp-assets-body' },
      exportFeedback.toast,
      h('nav', { className: 'dsh-tp-assets-nav', 'aria-label': '资产分类' },
        h('button', { type: 'button', 'aria-current': category === 'translations', onClick: () => setCategory('translations') }, '译文记录'),
        h('button', { type: 'button', 'aria-current': category === 'terms', onClick: () => setCategory('terms') }, '结构化档案'),
        h('button', { type: 'button', 'aria-current': category === 'other', onClick: () => { setOtherVisited(true); setCategory('other') } }, '其他记忆'),
        h('button', { type: 'button', disabled: true }, '临时文件 · 暂未开放')),
      h('div', { className: 'dsh-tp-assets-content' },
        // Visited topics and both categories stay mounted to retain local edit drafts.
        h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'terms' },
          h('div', { className: 'dsh-tp-structured' },
            h('div', { className: 'dsh-tp-archive-toolbar' },
              h('div', { className: 'dsh-tp-unit-header' },
                h('div', { className: 'dsh-tp-segmented', role: 'radiogroup', 'aria-label': '档案类型' },
                  ...archiveKinds.map(option => h('button', { key: option.value, type: 'button', role: 'radio', 'aria-label': option.label,
                    'aria-checked': kind === option.value, onClick: () => setKind(option.value) }, option.label))),
                h('div', { className: 'dsh-tp-actions' }, ...archiveKinds.map(option => h(AssetAdoptionControl, { key: option.value, terms, archive, ownerId, topicId, kind: option.value, active: active && category === 'terms' && kind === option.value, memoryIndex })),
                  memoryIndex ? h('button', { type: 'button', 'aria-expanded': indexOpen, onClick: () => setIndexOpen(value => !value) }, '语义索引') : null,
                  h('button', { type: 'button', title: '导出当前主题全部档案，不受筛选影响。', onClick: () => exportArchive('json') }, '导出 JSON'),
                  h('button', { type: 'button', title: '导出当前主题全部档案，不受筛选影响。', onClick: () => exportArchive('markdown') }, '导出 Markdown'), memoryClear.menu)),
              exportNotice ? h('p', { className: 'dsh-tp-message', role: exportNotice.failure ? 'alert' : 'status' }, exportNotice.message) : null,
              active && memoryIndex && indexOpen ? h(MemoryIndexView, { client: memoryIndex, topicId }) : null,
              memoryClear.feedback, memoryClear.dialog),
            h('div', { className: 'dsh-tp-assets-module', hidden: kind !== 'terms' },
              h(TopicTermsView, { sessions: store, terms, ownerId, topicId, topicName, hideExport: true,
                active: active && category === 'terms' && kind === 'terms', evidenceContextKey,
                targetLanguage: associatedSessionId && store.getSession(associatedSessionId)?.topicId === topicId ? store.getSession(associatedSessionId)?.targetLanguage : undefined,
                onDelete: onDeleteTerm, onExport: () => {}, bridgeReason: topics?.getStatus(ownerId).reason,
                onReconnect: topics ? () => { void topics.reset(ownerId) } : undefined })),
            ...(['entity', 'fact', 'relation'] as const).map(type => h('div', { key: type, className: 'dsh-tp-assets-module', hidden: kind !== type },
              h(TopicArchiveView, { sessions: store, terms, archive, ownerId, topicId, kind: type,
                active: active && category === 'terms' && kind === type, evidenceContextKey }))))),
        otherVisited ? h('div', { className: 'dsh-tp-assets-module dsh-tp-other-memory-module', hidden: category !== 'other' },
          otherMemory ? h(OtherMemoryView, { client: otherMemory, store, topicId, mainSessionId, active: active && category === 'other' }) : h('p', { className: 'dsh-tp-message', role: 'status' }, '其他记忆服务暂不可用。')) : null,
        h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'translations' },
          h(MemoryTranslationRecordsView, { store, quick, objects, objectAssets, viewFiles, documents, documentTasks, documentReviews, fileJobs, ownerId, topicId, associatedSessionId, navigationRevision, visible: active && category === 'translations',
            onOpenAssets: fileJobs ? () => { setCategory('terms') } : undefined }))))
}
