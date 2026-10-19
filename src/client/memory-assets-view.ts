import type { ReferenceStore } from './reference-store.js'
import { ReferenceFilesView } from './reference-view.js'
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
import type { DocumentViewProps } from './document-unit-view.js'
import type { ThemeMemoryClearing } from './theme-memory-clearing.js'
import { useThemeMemoryClearing } from './theme-memory-clearing-view.js'
import { FileJobAssetsView, type FileJobViewProps } from './file-job-view.js'

interface MemoryAssetsProps extends RecordObjectsProps, DocumentViewProps, FileJobViewProps {
  readonly store: SessionStore; readonly terms: TopicTermsViewPort; readonly quick: QuickTranslationClient
  readonly references?: ReferenceStore | undefined
  readonly archive: TopicArchiveStore
  readonly memoryClearing?: ThemeMemoryClearing | undefined
  readonly topics?: TopicBridgeClient | undefined; readonly ownerId: string; readonly topicId: string
  readonly onDeleteTerm: (snapshot: TopicTermSnapshot, entry: TopicTerm) => Promise<boolean>
}

/** One resource owns a fixed main conversation; topic selection only changes this asset view. */
export function MemoryAssetsView({ store, terms, archive, references, quick, topics, objects, objectAssets, viewFiles, documents, documentTasks, documentReviews, fileJobs, memoryClearing, ownerId, topicId, associatedSessionId, requestedTopicId, jobId, navigationRevision, onDeleteTerm, onSelectTopic }: MemoryAssetsProps & {
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
  react.useEffect(() => topics?.retain(ownerId), [topics, ownerId])
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
    references && topic ? h(ReferenceFilesView,{references,ownerId,topicId:selectedTopicId}) : null,
    store.getNotice() ? h('p', { role: 'alert', className: 'dsh-tp-message' }, store.getNotice()) : null,
    ...visited.map(id => {
      const visitedTopic = availableTopics.find(topic => topic.id === id)
      return visitedTopic ? h('div', { key: `${ownerId}:${id}`, className: 'dsh-tp-assets-topic', hidden: id !== selectedTopicId },
        h(MemoryAssetsTopicView, { store, terms, archive, quick, topics, objects, objectAssets, viewFiles, documents, documentTasks, documentReviews, fileJobs, memoryClearing, ownerId, topicId: id, topicName: visitedTopic.name, onDeleteTerm, jobId: id === selectedTopicId ? jobId : undefined,
          active: id === selectedTopicId, associatedSessionId: id === selectedTopicId ? associatedSessionId : undefined,
          navigationRevision: id === selectedTopicId ? navigationRevision : undefined })) : null
    }),
    topic ? null : h('p', { className: 'dsh-tp-message', role: 'status' }, '此主题不可用，请选择其他主题。'),
  )
}

function MemoryAssetsTopicView({ store, terms, archive, quick, topics, objects, objectAssets, viewFiles, documents, documentTasks, documentReviews, fileJobs, memoryClearing, ownerId, topicId, topicName, onDeleteTerm, active, associatedSessionId, jobId, navigationRevision }: MemoryAssetsProps & {
  readonly topicName: string; readonly active: boolean
  readonly associatedSessionId?: string | undefined; readonly navigationRevision?: number | undefined
  readonly jobId?: string | undefined
}): unknown {
  const [category, setCategory] = react.useState<'terms' | 'translations' | 'proposals'>(jobId ? 'proposals' : 'terms')
  const [focusedJobId, setFocusedJobId] = react.useState(jobId)
  const [, refreshJobs] = react.useState(0)
  react.useEffect(() => fileJobs?.subscribe(() => refreshJobs(value => value + 1)), [fileJobs])
  react.useEffect(() => { setFocusedJobId(jobId); if (jobId) setCategory('proposals') }, [jobId, navigationRevision])
  const proposalCount = fileJobs?.all(undefined, topicId).reduce((sum, record) => sum + fileJobs.pendingCount(record), 0) ?? 0
  const [kind, setKind] = react.useState<'terms' | 'entity' | 'fact' | 'relation'>('terms')
  const [exportNotice, setExportNotice] = react.useState<{ message: string; failure: boolean } | undefined>(undefined)
  const exportFeedback = useExportDownloadFeedback(active && category === 'terms')
  const memoryClear = useThemeMemoryClearing({ clearing: memoryClearing, ownerId, topicId, visible: active && category === 'terms' })
  const evidenceContextKey = JSON.stringify([ownerId, topicId, associatedSessionId, navigationRevision])
  function exportArchive(format: 'json' | 'markdown'): void {
    exportFeedback.clear(); setExportNotice(undefined)
    try {
      const frozen = structuredClone({ terms: terms.getSnapshot(ownerId, topicId), archive: archive.getSnapshot(ownerId, topicId) })
      function availability(snapshot: { readonly ownerId: string; readonly topicId: string; readonly entries: readonly { readonly id: string; readonly evidence: readonly TermEvidenceRef[] }[] }) {
        return snapshot.entries.flatMap(entry => entry.evidence.map((ref, evidenceIndex) => {
          if (ref.kind === 'reference') return {entryId: entry.id, evidenceIndex, sessionName: null, unitOrder: null, revisionOrder: null, readable: false, sourceLabel:'参考资料：'+ref.referenceId+' / '+ref.segmentId, readability:'not_loaded' as const}
          const candidate = store.getSession(ref.sessionId)
          const session = candidate?.topicId === topicId && !store.isSessionDeleted(candidate.id) ? candidate : undefined
          const unit = session ? store.getTranslationHistory(session.id)?.units.find(unit => unit.id === ref.unitId) : undefined
          const revision = unit && isTextUnit(unit) ? unit.revisions.find(revision => revision.id === ref.revisionId) : undefined
          return { entryId: entry.id, evidenceIndex, sessionName: session?.name ?? null, unitOrder: unit?.order ?? null, revisionOrder: revision?.order ?? null,
            readable: resolveTermEvidence(snapshot, ref, (sessionId, unitId) => terms.readEvidence(sessionId, unitId)) !== undefined }
        }))
      }
      const input: TopicArchiveExportSnapshot = { ...frozen, topicName: store.getTopics(ownerId).find(topic => topic.id === topicId)?.name ?? topicName,
        exportedAt: new Date().toISOString(), rememberHistory: store.getSettings().rememberHistory,
        termsStorageStatus: terms.getStatus(ownerId, topicId), archiveStorageStatus: archive.getStatus(ownerId, topicId),
        termEvidenceAvailability: availability(frozen.terms), archiveEvidenceAvailability: availability(frozen.archive) }
      const download = format === 'json' ? buildTopicArchiveJsonExport(input) : buildTopicArchiveMarkdownExport(input)
      downloadExport(download); exportFeedback.downloadStarted(download.fileName)
    } catch { setExportNotice({ message: '无法启动下载，请重试。', failure: true }) }
  }
  return h('div', { className: 'dsh-tp-assets-body' },
      exportFeedback.toast,
      h('nav', { className: 'dsh-tp-assets-nav', 'aria-label': '资产分类' },
        h('button', { type: 'button', 'aria-current': category === 'translations', onClick: () => setCategory('translations') }, '译文记录'),
        h('button', { type: 'button', 'aria-current': category === 'terms', onClick: () => setCategory('terms') }, '结构化档案'),
        fileJobs ? h('button', { type: 'button', 'aria-current': category === 'proposals', onClick: () => setCategory('proposals') }, `文件提案${proposalCount ? ` · ${proposalCount}` : ''}`) : null,
        h('button', { type: 'button', disabled: true }, '其他记忆 · 暂未开放'),
        h('button', { type: 'button', disabled: true }, '临时文件 · 暂未开放')),
      h('div', { className: 'dsh-tp-assets-content' },
        // Visited topics and both categories stay mounted to retain local edit drafts.
        h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'terms' },
          h('div', { className: 'dsh-tp-structured' },
            h('div', { className: 'dsh-tp-archive-toolbar' },
              h('div', { className: 'dsh-tp-unit-header' },
                h('select', { 'aria-label': '档案类型', value: kind, onChange: (event: { currentTarget: { value: string } }) => {
                  const value = event.currentTarget.value
                  if (value === 'terms' || value === 'entity' || value === 'fact' || value === 'relation') setKind(value)
                } }, h('option', { value: 'terms' }, '术语'), h('option', { value: 'entity' }, '实体'), h('option', { value: 'fact' }, '事实'), h('option', { value: 'relation' }, '关系')),
                h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', title: '导出当前主题全部档案，不受筛选影响。', onClick: () => exportArchive('json') }, '导出 JSON'),
                  h('button', { type: 'button', title: '导出当前主题全部档案，不受筛选影响。', onClick: () => exportArchive('markdown') }, '导出 Markdown'), memoryClear.menu)),
              exportNotice ? h('p', { className: 'dsh-tp-message', role: exportNotice.failure ? 'alert' : 'status' }, exportNotice.message) : null,
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
        fileJobs ? h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'proposals' }, h(FileJobAssetsView, { jobs: fileJobs, topicId, sessionId: associatedSessionId, jobId: focusedJobId, navigationRevision })) : null,
        h('div', { className: 'dsh-tp-assets-module', hidden: category !== 'translations' },
          h(MemoryTranslationRecordsView, { store, quick, objects, objectAssets, viewFiles, documents, documentTasks, documentReviews, fileJobs, ownerId, topicId, associatedSessionId, navigationRevision, visible: active && category === 'translations',
            onOpenAssets: fileJobs ? (_ownerId: string, _topicId: string, _sessionId?: string, selectedJobId?: string) => { setFocusedJobId(selectedJobId); setCategory('proposals') } : undefined }))))
}
