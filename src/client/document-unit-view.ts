import { h, react } from './react.js'
import { currentDocumentFinalRevision, currentFinalRevision, type DocumentUnit, type TextUnit } from './translation-history.js'
import type { LocalSession } from './sessions.js'
import type { TranslationDocumentReader, DocumentReadHandle, DocumentReadBlock } from './source-reader.js'
import type { EvidenceReadResult, EvidenceUnavailableResult } from '../shared/translation-evidence.js'
import { sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import { RecordObjectText, type RecordObjectsProps } from './record-object-view.js'
import { recordObjectPlainText } from './record-object-export.js'
import { openDocumentOriginal, projectDocumentResult } from './document-open.js'

export interface DocumentViewProps { readonly documents?: TranslationDocumentReader | undefined }
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
  const statusLabels = { running: '正在翻译。', failed: '翻译失败，缺口保留。', cancelled: '已取消，缺口保留。', unknown: '执行状态未知，缺口保留。', interrupted: '执行已中断，缺口保留。', completed: '已完成' }
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

export function DocumentUnitView({ unit, session, documents, objects, objectAssets, visible = true, navigationRevision }: RecordObjectsProps & DocumentViewProps & {
  readonly unit: DocumentUnit; readonly session: LocalSession; readonly visible?: boolean; readonly navigationRevision?: number | undefined
}): unknown {
  const source = unit.sourceVersions.find(version => version.version === unit.sourceVersion), final = currentDocumentFinalRevision(unit)
  const manifest = final ?? [...unit.revisions].reverse().find(revision => revision.sourceVersion === unit.sourceVersion)
  const handle = react.useMemo(() => documents?.captureDocument({ ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, sourceVersion: unit.sourceVersion, manifestRevisionId: manifest?.id ?? null }), [documents, session.ownerId, session.topicId, session.id, unit])
  const name = source?.body.kind === 'asset' ? source.body.reference.name : '长原稿'
  const identity = JSON.stringify([session.ownerId, session.topicId, session.id, unit.id, unit.sourceVersion, manifest?.id ?? null])
  const readable = handle && !('status' in handle) ? handle : undefined
  const missing: Failure = handle && 'status' in handle ? handle : { status: 'unloaded', reason: 'reader_unavailable' }
  const actualStatus = [...unit.tasks].reverse().find(task => task.sourceVersion === unit.sourceVersion)?.status
  const status = final ? '已定稿' : actualStatus === 'unknown' ? '执行状态未知' : actualStatus === 'running' ? '正在翻译' : actualStatus === 'interrupted' ? '已中断' : actualStatus === 'failed' ? '翻译失败' : actualStatus === 'cancelled' ? '已取消' : manifest ? '待定稿' : '待准备'
  const originalAction: OpenAction = { label: '打开原稿', native: source?.body.kind === 'asset' && Boolean(source.historyCommit), run: async signal => readable ? openDocumentOriginal(readable, signal) : missing }
  const resultAction: OpenAction = { label: '打开结果', run: async () => {
    if (!readable) return missing
    const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'revision' as const, revisionId: readable.manifest?.id ?? null }
    const references = structuredClone(objects?.getReferences(target) ?? [])
    const result = await projectDocumentResult(readable)
    return result.text ? { text: recordObjectPlainText(result.text, target, references), fileName: result.fileName, mimeType: result.mimeType } : { status: 'missing', reason: result.complete ? 'result_empty' : 'document_incomplete' }
  } }
  const blocks = readable?.blocks.length ? readable.blocks : readable ? [{ chunkId: 'source', outputRange: { start: 0, end: readable.totalSourceCodePoints }, mode: 'translate' as const, contextRanges: [], revisionId: null, revision: null }] : []
  const targetTotal = readable && blocks.every(block => block.revision?.status === 'completed') ? blocks.reduce((total, block) => total + (block.revision!.content.kind === 'text' ? sourceCodePointLength(block.revision!.content.text) : block.revision!.content.range.end - block.revision!.content.range.start), 0) : undefined
  const sourceTarget = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source' as const, revisionId: null }
  const resultTarget = { ...sourceTarget, side: 'revision' as const, revisionId: manifest?.id ?? null }
  const unplacedSource = (objects?.getReferences(sourceTarget) ?? []).filter(ref => !readable || ref.offset < 0 || ref.offset > readable.totalSourceCodePoints).map(ref => ({ ...ref, offset: -1 }))
  const unplacedResult = (objects?.getReferences(resultTarget) ?? []).filter(ref => targetTotal === undefined || ref.offset < 0 || ref.offset > targetTotal).map(ref => ({ ...ref, offset: -1 }))
  let targetOffset: number | null = 0
  return h('article', { className: 'dsh-tp-record-unit', 'data-session-id': session.id, 'data-unit-id': unit.id, 'data-source-version': unit.sourceVersion, 'data-manifest-id': manifest?.id, 'aria-label': `文档 ${unit.order}` },
    h('div', { className: 'dsh-tp-record-unit-heading' }, h('h3', null, `文档 ${unit.order} · ${name} · ${status}`), h('small', { className: 'dsh-tp-muted' }, `原文版本 ${unit.sourceVersion} · 目标语言：${unit.targetLanguage}`),
      h('span', { className: 'dsh-tp-actions dsh-tp-record-open-links' }, h(RecordOpenLink, { identity, visible, navigationRevision, action: originalAction }), h(RecordOpenLink, { identity, visible, navigationRevision, action: resultAction }))),
    !readable ? h('p', { role: 'status', className: 'dsh-tp-muted' }, readNotice(missing)) : null,
    readable && !readable.manifest ? h('p', { role: 'status', className: 'dsh-tp-muted' }, '尚无固定译文清单；原稿可查阅，结果暂不可完整打开或导出。') : null,
    ...blocks.map((block, index) => {
      const offset = targetOffset
      if (!block.revision || block.revision.status !== 'completed') targetOffset = null
      else if (targetOffset !== null) targetOffset += block.revision.content.kind === 'text' ? sourceCodePointLength(block.revision.content.text) : block.revision.content.range.end - block.revision.content.range.start
      return h('section', { key: JSON.stringify([identity, readable?.plan?.id, readable?.plan?.version, block.chunkId, block.revisionId, block.revision?.status, block.revision?.updatedAt, block.revision?.content.kind === 'text' ? block.revision.content.text.length : null]), 'data-chunk-id': block.chunkId, className: 'dsh-tp-record-block' },
        h('small', { className: 'dsh-tp-muted dsh-tp-record-block-heading' }, `块 ${index + 1} · 原文范围 ${block.outputRange.start}–${block.outputRange.end}${block.mode === 'copy' ? ' · 保留原文' : ''}`),
        h('div', { className: 'dsh-tp-record-pair' }, ...(['source', 'target'] as const).map(side => h(DocumentPage, { key: side, handle: readable!, block, side, session, unitId: unit.id, objects, objectAssets, visible, navigationRevision, targetOffset: offset, targetTotal }))))
    }),
    unplacedSource.length ? h(RecordObjectText, { text: '', target: sourceTarget, references: unplacedSource, objectAssets }) : null,
    unplacedResult.length ? h(RecordObjectText, { text: '', target: resultTarget, references: unplacedResult, objectAssets }) : null)
}
