import { h, react } from './react.js'
import { currentDocumentFinalRevision, currentResultRevision, type DocumentUnit, type TextUnit } from './translation-history.js'
import type { LocalSession } from './sessions.js'
import type { TranslationDocumentReader, DocumentReadHandle, DocumentReadBlock } from './source-reader.js'
import type { EvidenceReadResult, EvidenceUnavailableResult } from '../shared/translation-evidence.js'
import { sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import { RecordObjectText, type RecordObjectsProps } from './record-object-view.js'
import type { ViewFilesClient } from './view-files-client.js'
import { recordObjectPlainText } from './record-object-export.js'
import { openDocumentOriginal, projectDocumentResult } from './document-open.js'
import type { DocumentTasksClient } from './document-tasks.js'
import type { DocumentReviewClient } from './document-review-client.js'
import { documentReviewVersion, documentManifestFinalEligibility } from '../memory/document-review.js'
import type { DocumentReviewTarget } from '../shared/document-review.js'
import { readDocumentText } from './document-export.js'
import type { TopicBridgeClient } from './topic-bridge.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { SessionStore, TextUnitDeletionPlan } from './session-store.js'
import { Menu, MenuItemButton } from './native-ui.js'

export interface DocumentViewProps { readonly documents?: TranslationDocumentReader | undefined; readonly documentTasks?: DocumentTasksClient | undefined; readonly documentReviews?: DocumentReviewClient | undefined }
type Failure = Pick<EvidenceUnavailableResult, 'status' | 'reason'>
function readNotice(failure: Failure): string {
  if (failure.reason === 'document_incomplete') return '此版本包含缺项，尚无可打开的译文。请在详情中核对处理状态。'
  if (failure.reason === 'final_missing') return '尚无最终译文。'
  if (failure.status === 'missing') return '内容已缺失，原位置保留。'
  if (failure.status === 'corrupt') return '内容完整性检查失败，原位置保留。'
  if (failure.status === 'forbidden') return '此内容不属于当前授权范围。'
  return '内容尚未加载或暂时不可读取，可重试。'
}
interface OpenText { readonly text: string; readonly fileName: string; readonly mimeType: string }
interface OpenAction { readonly label: string; readonly display?: string | undefined; readonly native?: boolean; readonly run: (signal: AbortSignal) => Promise<OpenText | { readonly status: 'opened' } | Failure> }
interface OpenSlot { readonly ownerId: string; readonly sessionId: string; readonly unitId: string; readonly kind: 'source' | 'result'; readonly title: string; readonly revisionId?: string; readonly fileName?: string; readonly format?: 'txt' | 'html' }

/** Build the text, then let the Host write one stable page and open the system browser; the link itself stays quiet. */
function RecordOpenLink({ action, slot, viewFiles, identity, visible = true, navigationRevision }: {
  readonly action: OpenAction; readonly slot: OpenSlot; readonly viewFiles?: ViewFilesClient | undefined
  readonly identity: string; readonly visible?: boolean; readonly navigationRevision?: number | undefined
}): unknown {
  const [pending, setPending] = react.useState(false)
  const [message, setMessage] = react.useState<string | undefined>(undefined)
  const lifetime = react.useRef({ mounted: true, identity, visible, navigationRevision, controller: null as AbortController | null })
  lifetime.current.identity = identity; lifetime.current.visible = visible; lifetime.current.navigationRevision = navigationRevision
  react.useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false; lifetime.current.controller?.abort() } }, [])
  react.useEffect(() => { lifetime.current.controller?.abort() }, [visible, identity, navigationRevision])
  async function open(): Promise<void> {
    if (lifetime.current.controller || !visible) return
    const controller = new AbortController(), key = identity, navigation = navigationRevision
    lifetime.current.controller = controller; setPending(true); setMessage(undefined)
    const active = (): boolean => lifetime.current.mounted && lifetime.current.identity === key && lifetime.current.visible && lifetime.current.navigationRevision === navigation && !controller.signal.aborted
    try {
      const result = await action.run(controller.signal)
      if (!active() || 'status' in result && result.status === 'opened') return
      if (!('text' in result)) { setMessage(readNotice(result)); return }
      if (!viewFiles) { setMessage('打开服务尚未就绪，可重试。'); return }
      const opened = await viewFiles.open({ ...slot, text: result.text })
      if (active() && !opened.ok) setMessage(opened.message ?? '打开未完成，可重试。')
    } catch { if (active()) setMessage('打开未完成，可重试。') }
    finally { if (lifetime.current.controller === controller) { lifetime.current.controller = null; if (lifetime.current.mounted) setPending(false) } }
  }
  return h('span', { className: 'dsh-tp-record-open' }, h('button', { type: 'button', className: 'dsh-tp-object-link', 'aria-label': action.label, disabled: pending, onClick: () => { void open() } }, pending ? '正在打开…' : action.display ?? action.label), message ? h('small', { role: 'status', className: 'dsh-tp-muted' }, message) : null)
}

function recordOpenSlot(session: LocalSession, unit: TextUnit, kind: 'source' | 'result', label: string): OpenSlot {
  return { ownerId: session.ownerId, sessionId: session.id, unitId: unit.id, kind, title: `${session.name} · 文本 ${unit.order} · ${label}` }
}
/** Quiet link for the unit source; it renders on the source row. */
export function SourceOpenLink({ unit, session, objects, viewFiles, visible = true, navigationRevision }: RecordObjectsProps & {
  readonly unit: TextUnit; readonly session: LocalSession; readonly visible?: boolean; readonly navigationRevision?: number | undefined
}): unknown {
  const identity = JSON.stringify([session.ownerId, session.topicId, session.id, unit.id, unit.sourceVersion])
  const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source' as const, revisionId: null }
  return h(RecordOpenLink, { identity, visible, navigationRevision, viewFiles, slot: recordOpenSlot(session, unit, 'source', '原稿'),
    action: { label: '打开原稿', display: '打开', run: async () => ({ text: recordObjectPlainText(unit.source, target, objects?.getReferences(target) ?? []), fileName: `${session.name}-source.txt`, mimeType: 'text/plain;charset=utf-8' }) } })
}
/** Quiet link for the frozen final result, falling back to the latest complete revision when the unit has no effective final; it renders on the latest translation row. */
export function ResultOpenLink({ unit, session, objects, viewFiles, visible = true, navigationRevision }: RecordObjectsProps & {
  readonly unit: TextUnit; readonly session: LocalSession; readonly visible?: boolean; readonly navigationRevision?: number | undefined
}): unknown {
  const result = currentResultRevision(unit), identity = JSON.stringify([session.ownerId, session.topicId, session.id, unit.id, unit.sourceVersion, result?.id])
  const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source' as const, revisionId: null }
  return h(RecordOpenLink, { identity, visible, navigationRevision, viewFiles, slot: recordOpenSlot(session, unit, 'result', '结果'),
    action: { label: '打开结果', display: '打开', run: async () => {
      if (!result) return { status: 'missing', reason: 'final_missing' }
      const revisionTarget = { ...target, side: 'revision' as const, revisionId: result.id }
      return { text: recordObjectPlainText(result.text, revisionTarget, objects?.getReferences(revisionTarget) ?? []), fileName: `${session.name}-result.txt`, mimeType: 'text/plain;charset=utf-8' }
    } } })
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
function DocumentUnitDeletionControl({ store, unit, session, documentTasks, materials, topics }: {
  readonly store: SessionStore; readonly unit: DocumentUnit; readonly session: LocalSession
  readonly documentTasks?: DocumentTasksClient | undefined; readonly materials?: MaterialSubmissionsClient | undefined
  readonly topics?: TopicBridgeClient | undefined
}): unknown {
  const [open, setOpen] = react.useState(false)
  const [plan, setPlan] = react.useState<TextUnitDeletionPlan | undefined>(undefined)
  const [pending, setPending] = react.useState(false)
  const [message, setMessage] = react.useState<string | undefined>(undefined)
  const lifetime = react.useRef({ mounted: true, busy: false })
  react.useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false } }, [])
  const operationId = store.getPendingTextUnitDeletion(session.id, unit.id)
  const externalBlocked = (): string | undefined => {
    if (documentTasks?.getRetranslationStatus(session.id, unit.id)?.pending) return '正在发送整篇重译意图，请稍候。'
    if (materials?.getStatus(session.id, session.ownerId).busy || materials?.getStatus(session.id, session.ownerId).unknown) return '此会话仍有未结算的材料提交，请先结束或查询。'
    return undefined
  }
  const blocked = store.getTextUnitDeletionBlockedReason(session.id, unit.id) ?? externalBlocked()
  async function execute(query = false): Promise<void> {
    if (lifetime.current.busy) return
    lifetime.current.busy = true; setPending(true)
    try {
      const result = query && operationId ? await store.observeTextUnitDeletionAsync(operationId) : await store.deleteTextUnitAsync(plan, { blockedReason: externalBlocked })
      if (result.status === 'deleted') topics?.revokeUnit(session.ownerId, session.id, unit.id)
      if (lifetime.current.mounted) { setMessage(result.message); if (result.status === 'deleted') setPlan(undefined) }
    } finally { lifetime.current.busy = false; if (lifetime.current.mounted) setPending(false) }
  }
  if (unit.deletion) return null
  return h('div', null,
    h(Menu, { open, onClose: () => setOpen(false), portal: true, align: 'end', compact: true, listClassName: 'dsh-tp-popup',
      anchor: h('button', { type: 'button', 'aria-label': `文件 ${unit.order}单元操作`, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value) }, '操作'),
    }, h(MenuItemButton, { danger: true, disabled: pending || !!blocked, title: blocked, onSelect: () => {
      setOpen(false); setMessage(undefined); setPlan(store.captureTextUnitDeletion(session.id, unit.id))
    } }, '删除此单元')),
    plan ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '删除文件单元确认', 'aria-busy': pending },
      h('p', null, `删除文件 ${unit.order} 及其全部版本？`),
      h('p', null, '将清除原稿、各版译文、准备与任务记录；编号保留但不再可用，引用此单元的记忆依据需复核。已导出文件和主模型已经收到的内容无法撤回。'),
      h('div', { className: 'dsh-tp-actions' },
        operationId ? h('button', { type: 'button', disabled: pending, onClick: () => { void execute(true) } }, '查询本次删除结果')
          : h('button', { type: 'button', disabled: pending, onClick: () => { void execute() } }, pending ? '正在删除…' : '确认删除文件单元'),
        h('button', { type: 'button', disabled: pending || !!operationId, onClick: () => setPlan(undefined) }, '取消')),
    ) : operationId ? h('button', { type: 'button', disabled: pending, onClick: () => { void execute(true) } }, '查询本次删除结果') : null,
    message ? h('p', { className: 'dsh-tp-muted', role: 'status' }, message) : null)
}

export function DocumentUnitView({ unit, session, store, documents, documentTasks, documentReviews, objects, objectAssets, viewFiles, topics, materials, visible = true, navigationRevision }: RecordObjectsProps & DocumentViewProps & {
  readonly unit: DocumentUnit; readonly session: LocalSession; readonly store?: SessionStore | undefined; readonly topics?: TopicBridgeClient | undefined; readonly materials?: MaterialSubmissionsClient | undefined; readonly visible?: boolean; readonly navigationRevision?: number | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  react.useEffect(() => documentTasks?.subscribe(() => refresh(value => value + 1)), [documentTasks])
  react.useEffect(() => documentReviews?.subscribe(() => refresh(value => value + 1)), [documentReviews])
  const [selectedManifestId, setSelectedManifestId] = react.useState<string | undefined>(undefined)
  const [details, setDetails] = react.useState(false), [versionsExpanded, setVersionsExpanded] = react.useState(false)
  const [removeRequested, setRemoveRequested] = react.useState(false)
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
  react.useEffect(() => { if (!draft) setSelectedManifestId(undefined) }, [task?.taskId, unit.sourceVersion])
  const manifests = unit.revisions.filter(revision => revision.sourceVersion === unit.sourceVersion)
  const currentCandidate = task ? [...manifests].reverse().find(revision => revision.taskId === task.taskId) : manifests.at(-1)
  const manifest = selectedManifestId === '' ? undefined : selectedManifestId ? manifests.find(revision => revision.id === selectedManifestId) : currentCandidate
  const handle = react.useMemo(() => unit.deletion ? undefined : documents?.captureDocument({ ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, sourceVersion: unit.sourceVersion, manifestRevisionId: manifest?.id ?? null }), [documents, session.ownerId, session.topicId, session.id, unit, manifest?.id])
  if (unit.deletion) return h('article', { className: 'dsh-tp-record-unit dsh-tp-file-unit', 'data-session-id': session.id, 'data-unit-id': unit.id, 'aria-label': `文件 ${unit.order}` },
    h('div', { className: 'dsh-tp-unit-header' },
      h('span', { className: 'dsh-tp-muted', role: 'status' }, `文件 ${unit.order} · 已删除`),
      h('time', { dateTime: unit.deletion.at, className: 'dsh-tp-muted' }, new Date(unit.deletion.at).toLocaleString())),
    h('p', { className: 'dsh-tp-muted' }, unit.deletion.calls
      ? `正文已清除；保留 ${unit.deletion.calls} 次实际调用事实。编号保留，不再参与导出或记忆依据。`
      : '正文已清除；编号保留，不再参与导出或记忆依据。'))
  const name = source?.body.kind === 'asset' ? source.body.reference.name : '长原稿'
  const identity = JSON.stringify([session.ownerId, session.topicId, session.id, unit.id, unit.sourceVersion, manifest?.id ?? null])
  lifetime.current.identity = identity
  const readable = handle && !('status' in handle) ? handle : undefined
  const missing: Failure = handle && 'status' in handle ? handle : { status: 'unloaded', reason: 'reader_unavailable' }
  const controls = task && documentTasks?.uiState(session.id, task.taskId)
  const retranslation = documentTasks?.getRetranslationStatus(session.id, unit.id)
  const recoveryMessage = materials?.getFileRecoveryMessage(session.id, unit.id)
  const retranslationBlocked = documentTasks?.retranslationBlockedReason(session.id, unit.id) ?? (documentTasks ? undefined : '整篇重译服务尚未就绪。')
  const status = actualStatus === 'unknown' ? '执行状态未知' : actualStatus === 'running' ? '正在翻译' : actualStatus === 'paused' ? '已暂停' : actualStatus === 'waiting_context' ? '等待补充' : actualStatus === 'waiting_user' ? '等待讨论' : final?.id === manifest?.id && final ? '已定稿' : actualStatus === 'interrupted' ? '已中断' : actualStatus === 'failed' ? '翻译失败' : actualStatus === 'cancelled' ? '已取消' : manifest && documentManifestFinalEligibility(unit, manifest.id).eligible ? '待定稿' : manifest ? '待复核' : '原稿已冻结'
  const versionNumber = manifest ? manifests.findIndex(revision => revision.id === manifest.id) + 1 : 0
  const resultFileName = `${name.replace(/\.[^./\\]+$/u, '')}.${unit.targetLanguage.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_') || '译文'}.v${versionNumber}${manifest && !manifest.eligibility.complete ? '.部分结果' : ''}.txt`
  const originalSlot: OpenSlot = { ownerId: session.ownerId, sessionId: session.id, unitId: unit.id, kind: 'source', title: `${name} · 文档 ${unit.order} · 原稿`, revisionId: `source:${unit.sourceVersion}`, fileName: name, format: 'txt' }
  const resultSlot: OpenSlot = { ownerId: session.ownerId, sessionId: session.id, unitId: unit.id, kind: 'result', title: `${name} · 版本 ${versionNumber} · ${manifest?.eligibility.complete ? '译文' : '部分结果'}`, revisionId: `source:${manifest?.sourceVersion ?? unit.sourceVersion}:manifest:${manifest?.id ?? 'none'}`, fileName: resultFileName, format: 'txt' }
  const originalAction: OpenAction = { label: '打开原稿', native: source?.body.kind === 'asset' && Boolean(source.historyCommit), run: async signal => {
    if (unit.sourceVersion === 1 && materials && viewFiles) {
      const snapshot = await materials.resolveFileSource(session.id, unit.id)
      signal.throwIfAborted()
      if (snapshot) {
        const opened = await viewFiles.openSource(originalSlot, snapshot, signal)
        if (!opened.ok) throw new Error(opened.message ?? '原稿打开未完成。')
        return { status: 'opened' }
      }
    }
    return readable ? openDocumentOriginal(readable, signal) : missing
  } }
  const resultAction: OpenAction = { label: '打开此版本', run: async () => {
    if (!readable) return missing
    const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'revision' as const, revisionId: readable.manifest?.id ?? null }
    const references = structuredClone(objects?.getReferences(target) ?? [])
    const result = await projectDocumentResult(readable, true, 'candidate')
    return result.text && result.hasTranslation ? { text: recordObjectPlainText(result.text, target, references), fileName: resultFileName, mimeType: result.mimeType } : { status: 'missing', reason: result.complete ? 'result_empty' : 'document_incomplete' }
  } }
  const blocks = readable?.blocks.length ? readable.blocks : readable ? [{ chunkId: 'source', outputRange: { start: 0, end: readable.totalSourceCodePoints }, mode: 'translate' as const, contextRanges: [], revisionId: null, revision: null }] : []
  const targetTotal = readable && blocks.every(block => block.revision?.status === 'completed') ? blocks.reduce((total, block) => total + (block.revision!.content.kind === 'text' ? sourceCodePointLength(block.revision!.content.text) : block.revision!.content.range.end - block.revision!.content.range.start), 0) : undefined
  const sourceTarget = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source' as const, revisionId: null }
  const resultTarget = { ...sourceTarget, side: 'revision' as const, revisionId: manifest?.id ?? null }
  const unplacedSource = (objects?.getReferences(sourceTarget) ?? []).filter(ref => !readable || ref.offset < 0 || ref.offset > readable.totalSourceCodePoints).map(ref => ({ ...ref, offset: -1 }))
  const unplacedResult = (objects?.getReferences(resultTarget) ?? []).filter(ref => targetTotal === undefined || ref.offset < 0 || ref.offset > targetTotal).map(ref => ({ ...ref, offset: -1 }))
  const qualification = manifest ? documentManifestFinalEligibility(unit, manifest.id) : undefined
  const published = topics?.isPublished(session.ownerId, session.id, unit.id) ?? false
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
  const referenceControl = topics ? h('button', { type: 'button', 'aria-pressed': published, 'aria-label': published ? `取消文件 ${unit.order}参考` : `文件 ${unit.order}供主模型参考`,
    title: published ? '撤回此文档单元的参考授权。' : '授权当前主会话读取此文档单元及其当前原文；不发送翻译命令。',
    onClick: () => { if (published) topics.revokeUnit(session.ownerId, session.id, unit.id); else if (!topics.publishDocumentUnit(session.ownerId, session.id, unit.id, unit.sourceVersion)) setMessage('未能提供此参考，请核对会话与原文版本。') } }, published ? '取消参考' : '参考') : null
  const detailsControl = h('button', { type: 'button', 'aria-expanded': details || Boolean(draft), 'aria-label': `文件 ${unit.order}详情`, onClick: () => setDetails(value => !value) }, details ? '收起详情' : '详情')
  const oldVersionCount = manifests.length - (currentCandidate ? 1 : 0)
  const versionsControl = oldVersionCount > 0 ? h('button', { type: 'button', 'aria-expanded': versionsExpanded, 'aria-label': `文件 ${unit.order}旧版本`, onClick: () => setVersionsExpanded(value => !value) }, `旧版本（${oldVersionCount}）`) : null
  let targetOffset: number | null = 0
  return h('article', { className: 'dsh-tp-record-unit dsh-tp-file-unit', 'data-session-id': session.id, 'data-unit-id': unit.id, 'data-source-version': unit.sourceVersion, 'data-manifest-id': manifest?.id, 'aria-label': `文件 ${unit.order}：${name}` },
    h('div', { className: 'dsh-tp-unit-header' },
      h('span', { role: 'status', className: 'dsh-tp-muted' }, `原文 · ${status}`),
      h('div', { className: 'dsh-tp-actions' },
        store ? h(DocumentUnitDeletionControl, { store, unit, session, documentTasks, materials, topics }) : null,
        h('button', { type: 'button', disabled: Boolean(retranslationBlocked) || Boolean(draft) || pending, title: retranslationBlocked ?? '沿用此原稿、目标语言与翻译要求，交由主模型准备新的整篇任务。', onClick: () => { void documentTasks?.requestRetranslation(session.id, unit.id) } }, '重译'),
        retranslation?.unknown ? h('button', { type: 'button', disabled: retranslation.pending, onClick: () => { void documentTasks?.queryRetranslation(session.id, unit.id) } }, '检查重译状态') : null,
        task && controls && ['failed', 'cancelled', 'interrupted', 'unknown'].includes(actualStatus ?? '') ?
          actualStatus === 'unknown' ? h('button', { type: 'button', disabled: controls.pending, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'status') }, '检查状态')
            : h('button', { type: 'button', disabled: controls.pending || !controls.canResume, title: controls.recoverability ?? '保留已完成块，只继续尚未完成的部分。', onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'resume') }, '重新发送') : null,
        task && controls && ['failed', 'cancelled', 'interrupted'].includes(actualStatus ?? '') && materials && !final ? h('button', { type: 'button', disabled: controls.pending || pending || Boolean(draft), onClick: () => setRemoveRequested(true) }, '移除') : null,
        !manifest ? referenceControl : null,
        !manifest ? detailsControl : null,
        !manifest ? versionsControl : null,
        h(RecordOpenLink, { identity: `${identity}:source`, visible, navigationRevision, viewFiles, slot: originalSlot, action: { ...originalAction, display: '打开' } }))),
    h('div', { className: 'dsh-tp-file-name' }, h(RecordOpenLink, { identity: `${identity}:source-name`, visible, navigationRevision, viewFiles, slot: originalSlot, action: { ...originalAction, display: name } })),
    manifest ? h('div', { className: 'dsh-tp-version-header' },
      h('span', { className: 'dsh-tp-muted', role: 'status' }, `版本 ${versionNumber} · ${manifest.eligibility.complete ? '译文' : '部分结果 · 存在缺项'} · ${unit.targetLanguage}${final?.id === manifest.id ? ' · 已定稿' : qualification?.eligible ? ' · 待定稿' : ' · 待复核'}`),
      h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
        manifest ? h('button', { type: 'button', disabled: !canMutate || pending || Boolean(draft) || !qualification?.eligible || final?.id === manifest.id, title: !qualification?.eligible ? '须完成机械检查和主模型整篇复核，且无未解决问题。' : undefined, onClick: () => { void selectFinal() } }, final?.id === manifest.id ? '已定稿' : '设为最终') : null,
        referenceControl, detailsControl, versionsControl,
        h(RecordOpenLink, { identity: `${identity}:result`, visible, navigationRevision, viewFiles, slot: resultSlot, action: { ...resultAction, display: '打开' } }))) : null,
    manifest ? h('div', { className: 'dsh-tp-file-name' }, h(RecordOpenLink, { identity: `${identity}:result-name`, visible, navigationRevision, viewFiles, slot: resultSlot, action: { ...resultAction, display: resultFileName } })) : null,
    final && final.id !== manifest?.id ? h('p', { className: 'dsh-tp-muted', role: 'status' }, `原最终保留：版本 ${manifests.findIndex(revision => revision.id === final.id) + 1}；当前候选尚未替换最终。`) : null,
    versionsExpanded ? h('div', { className: 'dsh-tp-actions dsh-tp-file-versions' },
      h('select', { 'aria-label': `文档 ${unit.order} 清单版本`, value: manifest?.id ?? '', disabled: pending || Boolean(draft), onChange: (event: { currentTarget: { value: string } }) => { setSelectedManifestId(event.currentTarget.value); setMessage(undefined) } },
        h('option', { value: '' }, '当前任务进度'), ...manifests.map((revision, index) => h('option', { key: revision.id, value: revision.id }, `版本 ${index + 1}${final?.id === revision.id ? ' · 最终' : ''}${revision.eligibility.complete ? '' : ' · 部分结果'}${revision.review.status === 'pending' ? ' · 待复核' : revision.review.status === 'failed' ? ' · 有问题' : ' · 已复核'}`)))) : null,
    message ? h('p', { role: 'status', className: 'dsh-tp-muted' }, message) : null,
    recoveryMessage ? h('p', { role: 'status', className: 'dsh-tp-muted' }, recoveryMessage) : null,
    retranslation ? h('p', { role: retranslation.unknown ? 'alert' : 'status', className: 'dsh-tp-muted' }, retranslation.message) : null,
    removeRequested && materials ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '移除失败文件单元' },
      h('p', null, '移除本单元，已有调用记录和主题记忆保留。'),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: pending, onClick: () => { setPending(true); void materials.recoverFile(session.id, unit.id, 'remove').finally(() => { if (lifetime.current.mounted) { setPending(false); setRemoveRequested(false) } }) } }, pending ? '正在移除…' : '确认移除'),
        h('button', { type: 'button', disabled: pending, onClick: () => setRemoveRequested(false) }, '取消'))) : null,
    controls?.message || controls?.recoverability ? h('p', { role: 'status', className: 'dsh-tp-muted' }, controls.message ?? controls.recoverability) : null,
    details || draft ? h('div', { className: 'dsh-tp-file-details', 'aria-label': `文件 ${unit.order}详情内容` },
    h('p', { className: 'dsh-tp-muted' }, `原文版本 ${unit.sourceVersion} · ${manifest ? `译文版本 ${versionNumber}` : '尚无译文版本'}`),
    manifest ? h('p', { role: 'status', className: 'dsh-tp-muted' }, `${audit ? audit.mechanical.status === 'passed' ? '机械检查通过' : '机械检查发现问题' : manifest.eligibility.complete ? '覆盖完整，待机械检查' : '覆盖未完整'} · ${audit ? audit.semantic.status === 'passed' ? '主模型复核已完成' : audit.semantic.status === 'review_required' ? '主模型复核发现问题' : '主模型复核待完成' : '主模型复核待完成'}`) : null,
    reviewIssues.length ? h('ul', { className: 'dsh-tp-muted' }, ...reviewIssues.map((issue, index) => h('li', { key: index }, `原文 ${issue.range.start}–${issue.range.end}：${issue.message}`))) : null,
    task && controls ? h('div', { className: 'dsh-tp-actions' },
      actualStatus === 'running' ? h('button', { type: 'button', disabled: controls.pending, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'pause') }, controls.pausing ? '正在暂停…' : '暂停') : null,
      controls.canResume ? h('button', { type: 'button', disabled: controls.pending, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'resume') }, '继续') : null,
      ['running', 'paused', 'waiting_context', 'waiting_user', 'unknown'].includes(actualStatus ?? '') ? h('button', { type: 'button', disabled: controls.cancelling || controls.pending && !controls.pausing, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'cancel') }, '取消') : null,
      ['unknown', 'interrupted'].includes(actualStatus ?? '') ? h('button', { type: 'button', disabled: controls.pending, onClick: () => void documentTasks!.requestControl(session.id, task.taskId, 'status') }, '查询状态') : null) : null,
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
    unplacedResult.length ? h(RecordObjectText, { text: '', target: resultTarget, references: unplacedResult, objectAssets }) : null) : null)
}
