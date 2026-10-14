import { h, react } from './react.js'
import { currentDocumentFinalRevision, currentFinalRevision, type DocumentUnit, type TextUnit } from './translation-history.js'
import type { LocalSession } from './sessions.js'
import type { TranslationDocumentReader, DocumentReadHandle, DocumentReadBlock } from './source-reader.js'
import type { EvidenceReadResult, EvidenceUnavailableResult } from '../shared/translation-evidence.js'
import { sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import { RecordObjectText, type RecordObjectsProps } from './record-object-view.js'
import { recordObjectPlainText } from './record-object-export.js'
import { openDocumentOriginal, projectDocumentResult } from './document-open.js'
import type { DocumentTasksClient } from './document-tasks.js'
import type { DocumentReviewClient } from './document-review-client.js'
import { documentReviewVersion, documentManifestFinalEligibility } from '../memory/document-review.js'
import type { DocumentReviewTarget } from '../shared/document-review.js'
import { readDocumentText } from './document-export.js'

export interface DocumentViewProps { readonly documents?: TranslationDocumentReader | undefined; readonly documentTasks?: DocumentTasksClient | undefined; readonly documentReviews?: DocumentReviewClient | undefined }
type Failure = Pick<EvidenceUnavailableResult, 'status' | 'reason'>
function readNotice(failure: Failure): string {
  if (failure.reason === 'document_incomplete') return '结果包含缺项，完整打开尚不可用；可明确选择部分导出。'
  if (failure.reason === 'final_missing') return '尚无最终译文。'
  if (failure.status === 'missing') return '内容已缺失，原位置保留。'
  if (failure.status === 'corrupt') return '内容完整性检查失败，原位置保留。'
  if (failure.status === 'forbidden') return '此内容不属于当前授权范围。'
  return '内容尚未加载或暂时不可读取，可重试。'
}
interface OpenText { readonly text: string; readonly fileName: string; readonly mimeType: string }
interface OpenAction { readonly label: string; readonly native?: boolean; readonly run: (signal: AbortSignal) => Promise<OpenText | { readonly status: 'opened' } | Failure> }

/** Reserve the browser tab during the click, then fill only the same mounted record. */
function RecordOpenLink({ action, identity, visible = true, navigationRevision }: {
  readonly action: OpenAction; readonly identity: string; readonly visible?: boolean; readonly navigationRevision?: number | undefined
}): unknown {
  const [pending, setPending] = react.useState(false), [message, setMessage] = react.useState<string | undefined>(undefined)
  const lifetime = react.useRef({ mounted: true, identity, visible, navigationRevision, controller: null as AbortController | null, popup: null as Window | null })
  lifetime.current.identity = identity; lifetime.current.visible = visible; lifetime.current.navigationRevision = navigationRevision
  react.useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false; lifetime.current.controller?.abort(); lifetime.current.popup?.close() } }, [])
  react.useEffect(() => { lifetime.current.controller?.abort(); lifetime.current.popup?.close() }, [visible, identity, navigationRevision])
  async function open(): Promise<void> {
    if (lifetime.current.controller || !visible) return
    const controller = new AbortController(), key = identity, navigation = navigationRevision
    const popup = action.native ? null : window.open('about:blank', '_blank')
    if (!action.native && !popup) { setMessage('浏览器未能打开页面，请允许弹出窗口后重试。'); return }
    if (popup) popup.opener = null
    lifetime.current.controller = controller; lifetime.current.popup = popup; setPending(true); setMessage(undefined)
    const active = (): boolean => lifetime.current.mounted && lifetime.current.identity === key && lifetime.current.visible && lifetime.current.navigationRevision === navigation && !controller.signal.aborted
    try {
      const result = await action.run(controller.signal)
      if (!active()) { popup?.close(); return }
      if (!('text' in result)) { popup?.close(); setMessage(result.status === 'opened' ? '已请求打开原稿。' : readNotice(result)); return }
      if (!popup || popup.closed) throw new Error('Open page unavailable')
      const url = URL.createObjectURL(new Blob([result.text], { type: result.mimeType }))
      popup.location.replace(url); lifetime.current.popup = null
      setTimeout(() => URL.revokeObjectURL(url), 60_000); setMessage('已在浏览器打开。')
    } catch { popup?.close(); if (active()) setMessage('打开失败，可重试。') }
    finally { if (lifetime.current.controller === controller) { lifetime.current.controller = null; lifetime.current.popup = null; if (lifetime.current.mounted) setPending(false) } }
  }
  return h('span', { className: 'dsh-tp-record-open' }, h('button', { type: 'button', className: 'dsh-tp-object-link', disabled: pending, onClick: () => { void open() } }, pending ? '正在打开…' : action.label),
    message ? h('small', { role: 'status', className: 'dsh-tp-muted' }, message) : null)
}

export function TextUnitOpenLinks({ unit, session, objects, visible = true, navigationRevision }: RecordObjectsProps & {
  readonly unit: TextUnit; readonly session: LocalSession; readonly visible?: boolean; readonly navigationRevision?: number | undefined
}): unknown {
  const final = currentFinalRevision(unit), identity = JSON.stringify([session.ownerId, session.topicId, session.id, unit.id, unit.sourceVersion, final?.id])
  const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source' as const, revisionId: null }
  return h('span', { className: 'dsh-tp-actions dsh-tp-record-open-links' },
    h(RecordOpenLink, { identity, visible, navigationRevision, action: { label: '打开原稿', run: async () => ({ text: recordObjectPlainText(unit.source, target, objects?.getReferences(target) ?? []), fileName: `${session.name}-source.txt`, mimeType: 'text/plain;charset=utf-8' }) } }),
    h(RecordOpenLink, { identity, visible, navigationRevision, action: { label: '打开结果', run: async () => {
      if (!final) return { status: 'missing', reason: 'final_missing' }
      const revisionTarget = { ...target, side: 'revision' as const, revisionId: final.id }
      return { text: recordObjectPlainText(final.text, revisionTarget, objects?.getReferences(revisionTarget) ?? []), fileName: `${session.name}-result.txt`, mimeType: 'text/plain;charset=utf-8' }
    } } }))
}

/** One bounded page per side; changing pages never replaces the fixed chunk identity. */
function DocumentPage({ handle, block, side, session, unitId, objects, objectAssets, visible, navigationRevision, targetOffset, targetTotal }: RecordObjectsProps & {
  readonly handle: DocumentReadHandle; readonly block: DocumentReadBlock; readonly side: 'source' | 'target'; readonly session: LocalSession
  readonly unitId: string; readonly visible: boolean; readonly navigationRevision?: number | undefined; readonly targetOffset: number | null; readonly targetTotal?: number | undefined
}): unknown {
  const revision = block.revision
  const total = side === 'source' ? block.outputRange.end - block.outputRange.start : revision ? revision.content.kind === 'text' ? sourceCodePointLength(revision.content.text) : revision.content.range.end - revision.content.range.start : 0
  const [page, setPage] = react.useState<{ readonly start: number; readonly end: number; readonly text: string } | undefined>(undefined)
  const [failure, setFailure] = react.useState<Failure | undefined>(undefined), [pending, setPending] = react.useState(false)
  const element = react.useRef<HTMLElement | null>(null), previous = react.useRef<number[]>([])
  const requestedStart = react.useRef(0)
  const lifetime = react.useRef({ mounted: true, visible, navigationRevision, busy: false })
  lifetime.current.visible = visible; lifetime.current.navigationRevision = navigationRevision
  react.useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false } }, [])
  async function load(start = 0): Promise<void> {
    if (!lifetime.current.mounted || !lifetime.current.visible || lifetime.current.busy || start >= total || side === 'target' && (!revision || revision.content.kind !== 'text' && revision.status !== 'completed')) return
    lifetime.current.busy = true; setPending(true)
    requestedStart.current = start
    const navigation = navigationRevision, active = (): boolean => lifetime.current.mounted && lifetime.current.visible && lifetime.current.navigationRevision === navigation
    let size = Math.min(2000, total - start)
    try {
      let result: EvidenceReadResult
      while (true) {
        const offset = side === 'source' ? block.outputRange.start : 0
        const range: TranslationSourceRange = { start: offset + start, end: offset + start + size }
        result = side === 'source' ? await handle.readSource(range) : await handle.readChunk(revision!.id, range)
        if (!active()) return
        if (result.status === 'unloaded' && result.reason === 'range_required' && size > 1) { size = Math.max(1, Math.floor(size / 2)); continue }
        break
      }
      if (result.status !== 'ready') { setFailure(result); return }
      const changed = handle.check()
      if (changed) { setFailure(changed); return }
      if (page && start === page.end) previous.current.push(page.start)
      else if (page && start < page.start) previous.current.pop()
      setPage({ start, end: start + size, text: result.text }); setFailure(undefined)
    } catch { if (active()) setFailure({ status: 'unloaded', reason: 'transport_unavailable' }) }
    finally { lifetime.current.busy = false; if (lifetime.current.mounted) setPending(false) }
  }
  react.useEffect(() => {
    if (!visible || page || !element.current || typeof IntersectionObserver === 'undefined' || !total || side === 'target' && (!revision || revision.content.kind !== 'text' && revision.status !== 'completed')) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load() } }, { rootMargin: '200px' })
    observer.observe(element.current); return () => observer.disconnect()
  }, [visible, navigationRevision])
  const label = side === 'source' ? '原文' : '译文'
  const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId, side: side === 'source' ? 'source' as const : 'revision' as const, revisionId: side === 'source' ? null : handle.manifest?.id ?? null }
  const offset = side === 'source' ? block.outputRange.start : targetOffset
  const statusLabels = { running: '正在翻译。', paused: '已暂停。', waiting_context: '等待补充。', waiting_user: '等待讨论。', failed: '翻译失败，缺口保留。', cancelled: '已取消，缺口保留。', unknown: '执行状态未知，缺口保留。', interrupted: '执行已中断，缺口保留。', completed: '已完成' }
  return h('div', { ref: element, className: side === 'source' ? 'dsh-tp-record-source' : 'dsh-tp-record-target', 'aria-label': label }, h('h4', null, label),
    page ? h(RecordObjectText, { text: page.text, target, objects, objectAssets, range: offset === null ? { start: 0, end: 0 } : { start: offset + page.start, end: offset + page.end }, totalCodePoints: side === 'source' ? handle.totalSourceCodePoints : targetTotal, hideUnavailable: true }) : null,
    side === 'target' && !revision ? h('p', { role: 'status', className: 'dsh-tp-muted' }, '此块尚无结果，缺口保留。') : null,
    side === 'target' && revision && revision.status !== 'completed' ? h('p', { role: revision.status === 'unknown' ? 'alert' : 'status', className: 'dsh-tp-muted' }, statusLabels[revision.status]) : null,
    total === 0 && revision?.status === 'completed' ? h('p', { className: 'dsh-tp-muted' }, '此范围没有文本。') : null,
    failure ? h('p', { role: 'status', className: 'dsh-tp-muted' }, readNotice(failure)) : null,
    total > 0 && (side === 'source' || revision?.status === 'completed' || revision?.content.kind === 'text') ? h('div', { className: 'dsh-tp-actions dsh-tp-record-page-actions' },
      page ? h('small', { className: 'dsh-tp-muted' }, `${page.start + 1}–${page.end} / ${total}`) : null,
      !page || failure ? h('button', { type: 'button', disabled: pending, onClick: () => { void load(requestedStart.current) } }, pending ? '正在加载…' : failure ? '重试加载' : `加载${label}`) : null,
      page && page.start > 0 ? h('button', { type: 'button', disabled: pending, onClick: () => { void load(previous.current.at(-1) ?? 0) } }, '上一页') : null,
      page && page.end < total ? h('button', { type: 'button', disabled: pending, onClick: () => { void load(page.end) } }, '下一页') : null) : null)
}

interface ManualDraft {
  readonly target: DocumentReviewTarget; readonly reviewVersion: number; readonly chunkId: string; readonly baseRevisionId: string
  readonly original: string; readonly text: string
}
export function DocumentUnitView({ unit, session, documents, documentTasks, documentReviews, objects, objectAssets, visible = true, navigationRevision }: RecordObjectsProps & DocumentViewProps & {
  readonly unit: DocumentUnit; readonly session: LocalSession; readonly visible?: boolean; readonly navigationRevision?: number | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  react.useEffect(() => documentTasks?.subscribe(() => refresh(value => value + 1)), [documentTasks])
  react.useEffect(() => documentReviews?.subscribe(() => refresh(value => value + 1)), [documentReviews])
  const [selectedManifestId, setSelectedManifestId] = react.useState<string | undefined>(undefined)
  const followReview = react.useRef<string | undefined>(undefined)
  const [draft, setDraft] = react.useState<ManualDraft | undefined>(undefined)
  const [pending, setPending] = react.useState(false), [message, setMessage] = react.useState<string | undefined>(undefined)
  const lifetime = react.useRef({ mounted: true, visible, navigationRevision, identity: '' })
  lifetime.current.visible = visible; lifetime.current.navigationRevision = navigationRevision
  react.useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false } }, [])
  react.useEffect(() => {
    const reviewed = unit.reviewAudits?.find(audit => audit.manifestRevisionId === followReview.current && audit.reviewedRevisionId)
    if (!reviewed?.reviewedRevisionId) return
    if (selectedManifestId === followReview.current) setSelectedManifestId(reviewed.reviewedRevisionId)
    followReview.current = undefined
  }, [unit, selectedManifestId])
  const source = unit.sourceVersions.find(version => version.version === unit.sourceVersion), final = currentDocumentFinalRevision(unit)
  const task = [...unit.tasks].reverse().find(task => task.sourceVersion === unit.sourceVersion), actualStatus = task?.status
  const manifests = unit.revisions.filter(revision => revision.sourceVersion === unit.sourceVersion)
  const currentCandidate = [...manifests].reverse().find(revision => revision.taskId === task?.taskId)
  const manifest = selectedManifestId === '' ? undefined : selectedManifestId ? manifests.find(revision => revision.id === selectedManifestId) : currentCandidate
  const handle = react.useMemo(() => documents?.captureDocument({ ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, sourceVersion: unit.sourceVersion, manifestRevisionId: manifest?.id ?? null }), [documents, session.ownerId, session.topicId, session.id, unit, manifest?.id])
  const name = source?.body.kind === 'asset' ? source.body.reference.name : '长原稿'
  const identity = JSON.stringify([session.ownerId, session.topicId, session.id, unit.id, unit.sourceVersion, manifest?.id ?? null])
  lifetime.current.identity = identity
  const readable = handle && !('status' in handle) ? handle : undefined
  const missing: Failure = handle && 'status' in handle ? handle : { status: 'unloaded', reason: 'reader_unavailable' }
  const controls = task && documentTasks?.uiState(session.id, task.taskId)
  const status = actualStatus === 'unknown' ? '执行状态未知' : actualStatus === 'running' ? '正在翻译' : actualStatus === 'paused' ? '已暂停' : actualStatus === 'waiting_context' ? '等待补充' : actualStatus === 'waiting_user' ? '等待讨论' : final?.id === manifest?.id && final ? '已定稿' : actualStatus === 'interrupted' ? '已中断' : actualStatus === 'failed' ? '翻译失败' : actualStatus === 'cancelled' ? '已取消' : manifest?.review.status === 'pending' ? '待复核' : manifest ? '待定稿' : '待准备'
  const originalAction: OpenAction = { label: '打开原稿', native: source?.body.kind === 'asset' && Boolean(source.historyCommit), run: async signal => readable ? openDocumentOriginal(readable, signal) : missing }
  const resultAction: OpenAction = { label: '打开此版本', run: async () => {
    if (!readable) return missing
    const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'revision' as const, revisionId: readable.manifest?.id ?? null }
    const references = structuredClone(objects?.getReferences(target) ?? [])
    const result = await projectDocumentResult(readable, false, 'candidate')
    return result.text ? { text: recordObjectPlainText(result.text, target, references), fileName: result.fileName, mimeType: result.mimeType } : { status: 'missing', reason: result.complete ? 'result_empty' : 'document_incomplete' }
  } }
  const blocks = readable?.blocks.length ? readable.blocks : readable ? [{ chunkId: 'source', outputRange: { start: 0, end: readable.totalSourceCodePoints }, mode: 'translate' as const, contextRanges: [], revisionId: null, revision: null }] : []
  const targetTotal = readable && blocks.every(block => block.revision?.status === 'completed') ? blocks.reduce((total, block) => total + (block.revision!.content.kind === 'text' ? sourceCodePointLength(block.revision!.content.text) : block.revision!.content.range.end - block.revision!.content.range.start), 0) : undefined
  const sourceTarget = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source' as const, revisionId: null }
  const resultTarget = { ...sourceTarget, side: 'revision' as const, revisionId: manifest?.id ?? null }
  const unplacedSource = (objects?.getReferences(sourceTarget) ?? []).filter(ref => !readable || ref.offset < 0 || ref.offset > readable.totalSourceCodePoints).map(ref => ({ ...ref, offset: -1 }))
  const unplacedResult = (objects?.getReferences(resultTarget) ?? []).filter(ref => targetTotal === undefined || ref.offset < 0 || ref.offset > targetTotal).map(ref => ({ ...ref, offset: -1 }))
  const qualification = manifest ? documentManifestFinalEligibility(unit, manifest.id) : undefined
  const canMutate = Boolean(documentReviews && manifest && session.archivedAt === null && task && !['running', 'unknown', 'waiting_context', 'waiting_user'].includes(task.status))
  const editable = canMutate && manifest?.id === currentCandidate?.id
  const audit = manifest && [...(unit.reviewAudits ?? [])].reverse().find(audit => audit.manifestRevisionId === manifest.id || audit.reviewedRevisionId === manifest.id)
  const reviewIssues = audit ? [...audit.mechanical.issues, ...audit.semantic.issues, ...(audit.semantic.status === 'pending' ? audit.mechanical.suspicions : [])] : manifest?.review.issues ?? []
  const viewedTask = manifest ? unit.tasks.find(task => task.taskId === manifest.taskId) : task
  const unresolvedDependencies = (viewedTask?.executionFacts?.reviewIssues ?? []).filter(issue => !audit?.semantic.resolvedIssues.some(resolved =>
    resolved.code === issue.code && resolved.message === issue.message && resolved.range.start === issue.range.start && resolved.range.end === issue.range.end))
  const reviewTarget = manifest ? { scope: { ownerId: session.ownerId, mainSessionId: session.ownerId, topicId: session.topicId, translationSessionId: session.id }, unitId: unit.id,
    sourceVersion: unit.sourceVersion, manifestRevisionId: manifest.id } : undefined
  function operationId(): string { return `document-ui:${globalThis.crypto.randomUUID()}` }
  async function startEditing(block: DocumentReadBlock): Promise<void> {
    if (!readable || !reviewTarget || !block.revision || !editable || pending || draft) return
    const target = structuredClone(reviewTarget), revision = block.revision, reviewVersion = documentReviewVersion(unit)
    const navigation = navigationRevision
    setPending(true); setMessage(undefined)
    try {
      const length = revision.content.kind === 'text' ? sourceCodePointLength(revision.content.text) : revision.content.range.end - revision.content.range.start
      const loaded = await readDocumentText(range => readable.readChunk(revision.id, range), { start: 0, end: length })
      if (!lifetime.current.mounted || !lifetime.current.visible || lifetime.current.navigationRevision !== navigation || lifetime.current.identity !== identity) return
      if (!('text' in loaded)) { setMessage(readNotice(loaded)); return }
      setDraft({ target, reviewVersion, chunkId: block.chunkId, baseRevisionId: revision.id, original: loaded.text, text: loaded.text })
    } catch { if (lifetime.current.mounted) setMessage('未能加载编辑基准，可重试。') }
    finally { if (lifetime.current.mounted) setPending(false) }
  }
  async function saveDraft(): Promise<void> {
    if (!draft || !documentReviews || pending) return
    const fixed = draft
    setPending(true); setMessage(undefined)
    try {
      const result = await documentReviews.manual({ target: fixed.target, operationId: operationId(), expectedReviewVersion: fixed.reviewVersion,
        chunkId: fixed.chunkId, baseRevisionId: fixed.baseRevisionId, text: fixed.text })
      if (!lifetime.current.mounted) return
      if (!result.ok) { setMessage(result.error.message); return }
      setDraft(undefined); followReview.current = result.value.manifestRevisionId; setSelectedManifestId(result.value.manifestRevisionId); setMessage('已保存为新的人工候选，等待整篇复核。')
    } catch { if (lifetime.current.mounted) setMessage('保存未确认，编辑内容仍保留。') }
    finally { if (lifetime.current.mounted) setPending(false) }
  }
  async function selectFinal(): Promise<void> {
    if (!documentReviews || !reviewTarget || !qualification?.eligible || pending || draft) return
    setPending(true); setMessage(undefined)
    try {
      const result = await documentReviews.selectFinal({ target: structuredClone(reviewTarget), operationId: operationId(), expectedReviewVersion: documentReviewVersion(unit) })
      if (lifetime.current.mounted) setMessage(result.ok ? '已设为最终。' : result.error.message)
    } catch { if (lifetime.current.mounted) setMessage('最终选择未确认，请核对当前版本。') }
    finally { if (lifetime.current.mounted) setPending(false) }
  }
  let targetOffset: number | null = 0
  return h('article', { className: 'dsh-tp-record-unit', 'data-session-id': session.id, 'data-unit-id': unit.id, 'data-source-version': unit.sourceVersion, 'data-manifest-id': manifest?.id, 'aria-label': `文档 ${unit.order}` },
    h('div', { className: 'dsh-tp-record-unit-heading' }, h('h3', null, `文档 ${unit.order} · ${name} · ${status}`), h('small', { className: 'dsh-tp-muted' }, `原文版本 ${unit.sourceVersion} · 目标语言：${unit.targetLanguage}`),
      h('span', { className: 'dsh-tp-actions dsh-tp-record-open-links' }, h(RecordOpenLink, { identity, visible, navigationRevision, action: originalAction }), h(RecordOpenLink, { identity, visible, navigationRevision, action: resultAction }))),
    manifests.length ? h('div', { className: 'dsh-tp-actions' },
      h('select', { 'aria-label': `文档 ${unit.order} 清单版本`, value: manifest?.id ?? '', disabled: pending || Boolean(draft), onChange: (event: { currentTarget: { value: string } }) => { setSelectedManifestId(event.currentTarget.value); setMessage(undefined) } },
        h('option', { value: '' }, '当前任务进度'), ...manifests.map((revision, index) => h('option', { key: revision.id, value: revision.id }, `候选 ${index + 1}${final?.id === revision.id ? ` · ${unit.final?.selection === 'user_fixed' ? '用户固定最终' : '自动最终'}` : ''}${revision.review.status === 'pending' ? ' · 待复核' : revision.review.status === 'failed' ? ' · 有问题' : ' · 已复核'}`))),
      manifest && final?.id !== manifest.id ? h('button', { type: 'button', disabled: !canMutate || pending || Boolean(draft) || !qualification?.eligible, title: !qualification?.eligible ? '须完成机械检查和主模型整篇复核，且无未解决问题。' : undefined, onClick: () => { void selectFinal() } }, '设为最终') : null) : null,
    manifest ? h('p', { role: 'status', className: 'dsh-tp-muted' }, `${audit ? audit.mechanical.status === 'passed' ? '机械检查通过' : '机械检查发现问题' : manifest.eligibility.complete ? '覆盖完整，待机械检查' : '覆盖未完整'} · ${audit ? audit.semantic.status === 'passed' ? '主模型复核已完成' : audit.semantic.status === 'review_required' ? '主模型复核发现问题' : '主模型复核待完成' : '主模型复核待完成'}`) : null,
    reviewIssues.length ? h('ul', { className: 'dsh-tp-muted' }, ...reviewIssues.map((issue, index) => h('li', { key: index }, `原文 ${issue.range.start}–${issue.range.end}：${issue.message}`))) : null,
    message ? h('p', { role: 'status', className: 'dsh-tp-muted' }, message) : null,
    task && controls ? h('div', { className: 'dsh-tp-actions' },
      actualStatus === 'running' ? h('button', { type: 'button', disabled: controls.pending, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'pause') }, controls.pausing ? '正在暂停…' : '暂停') : null,
      controls.canResume ? h('button', { type: 'button', disabled: controls.pending, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'resume') }, '继续') : null,
      ['running', 'paused', 'waiting_context', 'waiting_user', 'unknown'].includes(actualStatus ?? '') ? h('button', { type: 'button', disabled: controls.cancelling || controls.pending && !controls.pausing, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'cancel') }, '取消') : null,
      ['unknown', 'interrupted'].includes(actualStatus ?? '') ? h('button', { type: 'button', disabled: controls.pending, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'status') }, '查询状态') : null) : null,
    controls?.message || controls?.recoverability ? h('p', { role: 'status', className: 'dsh-tp-muted' }, controls.message ?? controls.recoverability) : null,
    unresolvedDependencies.length ? h('p', { role: 'status', className: 'dsh-tp-muted' }, '已完成块的准备依赖有变化，整篇结果需要复核。') : null,
    !readable ? h('p', { role: 'status', className: 'dsh-tp-muted' }, readNotice(missing)) : null,
    readable && !readable.manifest ? h('p', { role: 'status', className: 'dsh-tp-muted' }, '尚无固定译文清单；原稿可查阅，结果暂不可完整打开或导出。') : null,
    ...blocks.map((block, index) => {
      const offset = targetOffset
      if (!block.revision || block.revision.status !== 'completed') targetOffset = null
      else if (targetOffset !== null) targetOffset += block.revision.content.kind === 'text' ? sourceCodePointLength(block.revision.content.text) : block.revision.content.range.end - block.revision.content.range.start
      return h('section', { key: JSON.stringify([identity, readable?.plan?.id, readable?.plan?.version, block.chunkId, block.revisionId, block.revision?.status, block.revision?.updatedAt, block.revision?.content.kind === 'text' ? block.revision.content.text.length : null]), 'data-chunk-id': block.chunkId, className: 'dsh-tp-record-block' },
        h('div', { className: 'dsh-tp-actions' }, h('small', { className: 'dsh-tp-muted dsh-tp-record-block-heading' }, `块 ${index + 1} · 原文范围 ${block.outputRange.start}–${block.outputRange.end}${block.mode === 'copy' ? ' · 保留原文' : ''}${block.revision?.kind === 'manual' ? ' · 人工版' : ''}${block.reuseRef ? ` · 复用原文版本 ${block.reuseRef.sourceVersion} 的完整结果` : ''}`),
          manifest && block.revision && block.mode === 'translate' ? h('button', { type: 'button', disabled: !editable || pending || Boolean(draft) || !['completed', 'failed', 'cancelled', 'interrupted'].includes(block.revision.status), title: !editable && canMutate ? '请先选择当前任务的最新候选。' : undefined, onClick: () => { void startEditing(block) } }, '编辑此块') : null),
        draft?.chunkId === block.chunkId ? h('div', { className: 'dsh-tp-version-editor dsh-tp-record-inline-editor' },
          h('small', { className: 'dsh-tp-muted' }, `基于当前清单的块 ${index + 1} 修订 ${unit.chunkRevisions.findIndex(revision => revision.id === draft.baseRevisionId) + 1}；保存追加人工候选，不产生翻译模型用量。`),
          h('textarea', { 'aria-label': `文档 ${unit.order} 编辑块 ${index + 1}`, rows: 8, value: draft.text, disabled: pending, onChange: (event: { currentTarget: { value: string } }) => setDraft({ ...draft, text: event.currentTarget.value }) }),
          h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending || !draft.text.trim() || draft.text === draft.original, onClick: () => { void saveDraft() } }, '保存人工版本'),
            h('button', { type: 'button', disabled: pending, onClick: () => setDraft(undefined) }, '取消编辑'))) : null,
        h('div', { className: 'dsh-tp-record-pair' }, ...(['source', 'target'] as const).map(side => h(DocumentPage, { key: side, handle: readable!, block, side, session, unitId: unit.id, objects, objectAssets, visible, navigationRevision, targetOffset: offset, targetTotal }))))
    }),
    unplacedSource.length ? h(RecordObjectText, { text: '', target: sourceTarget, references: unplacedSource, objectAssets }) : null,
    unplacedResult.length ? h(RecordObjectText, { text: '', target: resultTarget, references: unplacedResult, objectAssets }) : null)
}
