import { BATCH_FILE_LIMIT, parseBatchView, unfinishedBatchItem, type BatchRequest, type BatchView } from '../shared/batch-processing.js'
import { imageFileFormat, MAX_IMAGE_ORIGINAL_BYTES } from '../shared/image-translation.js'
import { DIRECT_REQUIREMENTS_CODE_POINTS } from '../shared/normal-translation.js'
import { h, react } from './react.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { LocalSession } from './sessions.js'

interface SelectedImage { readonly id: string; readonly file: File }
export type BatchRemoteCall = (request: BatchRequest) => Promise<unknown>

const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
export function orderBatchImages<T extends { readonly name: string }>(files: readonly T[]): T[] {
  return [...files].sort((left, right) => names.compare(left.name, right.name))
}
const statusText = { pending: '待处理', processing: '处理中', completed: '完成', failed: '失败', skipped: '已跳过' } as const
function button(label: string, onClick: () => void, disabled = false, title?: string): unknown {
  return h('button', { type: 'button', onClick, disabled, title, 'aria-label': title ?? label }, label)
}
function unwrap(raw: unknown): BatchView {
  const response = raw as { readonly ok?: boolean; readonly value?: unknown; readonly error?: { readonly message?: string } } | undefined
  if (!response?.ok) throw new Error(response?.error?.message ?? '批量处理服务尚未就绪。')
  return parseBatchView(response.value)
}

export function BatchProcessingView({ session, ownerId, namespaceId, libraryReady, materials, remote, onOpenUnit, renderComposer }: {
  readonly session: LocalSession
  readonly ownerId: string
  readonly namespaceId: string
  readonly libraryReady: boolean
  readonly materials: MaterialSubmissionsClient
  readonly remote: BatchRemoteCall
  readonly onOpenUnit: (unitId: string) => void
  readonly renderComposer: (batchInput: unknown, batchButton: unknown) => unknown
}): unknown {
  const [open, setOpen] = react.useState(false)
  const [images, setImages] = react.useState<readonly SelectedImage[]>([])
  const [requirements, setRequirements] = react.useState('')
  const [selection, setSelection] = react.useState<string | undefined>(undefined)
  const [view, setView] = react.useState<BatchView | undefined>(undefined)
  const [busy, setBusy] = react.useState(false)
  const [registration, setRegistration] = react.useState<number | undefined>(undefined)
  const [notice, setNotice] = react.useState('')
  const [readError, setReadError] = react.useState('')
  const picker = react.useRef<HTMLInputElement | null>(null)
  const draftId = react.useRef<string | undefined>(undefined)
  const lifetime = react.useRef<AbortController | undefined>(undefined)
  const action = react.useRef<{ running: boolean; version: number }>({ running: false, version: 0 })
  const scope = { namespaceId, topicId: session.topicId, sessionId: session.id, mainSessionId: ownerId }
  const running = view?.running ?? false
  react.useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => { controller.abort() }
  }, [])
  react.useEffect(() => {
    if (!libraryReady) return
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      const version = action.current.version
      if (!action.current.running) {
        try {
          const next = unwrap(await remote({ ...scope, kind: 'read', ...(selection ? { batchId: selection } : {}) }))
          if (!closed && version === action.current.version) {
            setView(next); setReadError('')
            if (!selection && next.batch && (next.running || next.batch.items.some(unfinishedBatchItem))) setSelection(next.batch.id)
          }
        } catch (error) {
          if (!closed && version === action.current.version) setReadError(error instanceof Error ? error.message : '读取批次失败。')
        }
      }
      if ((open || running) && !closed) timer = setTimeout(() => { void refresh() }, 1500)
    }
    void refresh()
    return () => { closed = true; clearTimeout(timer) }
  }, [open, running, remote, selection, namespaceId, session.topicId, session.id, ownerId, libraryReady])

  function pick(files: FileList | null): void {
    if (!files?.length || action.current.running) return
    setOpen(true)
    if (files.length > BATCH_FILE_LIMIT) { setNotice(`一次最多选择 ${BATCH_FILE_LIMIT} 张图片。`); return }
    const selected = Array.from(files)
    const invalid = selected.find(file => !imageFileFormat(file.name) || file.size > MAX_IMAGE_ORIGINAL_BYTES)
    if (invalid) { setNotice(`无法选择「${invalid.name}」。请使用 50 MiB 以内的 PNG、JPEG 或静态 WebP。`); return }
    draftId.current = crypto.randomUUID()
    setImages(orderBatchImages(selected).map(file => ({ id: crypto.randomUUID(), file })))
    setNotice('')
  }
  function move(index: number, step: -1 | 1): void {
    setImages(current => {
      const next = [...current], other = index + step
      if (other < 0 || other >= next.length) return current
      ;[next[index], next[other]] = [next[other]!, next[index]!]
      return next
    })
  }
  async function perform(kind: 'start' | 'pause' | 'continue' | 'retry' | 'skip'): Promise<void> {
    if (action.current.running || !lifetime.current || lifetime.current.signal.aborted) return
    const signal = lifetime.current.signal
    action.current.running = true; action.current.version++; setBusy(true); setNotice('')
    try {
      let request: BatchRequest
      if (kind === 'start') {
        if (!images.length || !draftId.current) return
        if (!session.model) throw new Error('请先为普通会话选择翻译模型。')
        if (Array.from(requirements).length > DIRECT_REQUIREMENTS_CODE_POINTS) throw new Error('本次共同要求过长，请精简后再开始。')
        const unitIds: string[] = []
        for (const [index, item] of images.entries()) {
          setRegistration(index + 1)
          try { unitIds.push(await materials.prepareBatchImage(session.id, ownerId, item.id, item.file, signal)) }
          catch (error) { throw new Error(`「${item.file.name}」${error instanceof Error ? error.message : '未能登记。'}`) }
          signal.throwIfAborted()
        }
        request = { ...scope, kind, batchId: draftId.current, action: 'translate_images', unitIds, requirements }
      } else {
        if (!view?.batch) return
        request = { ...scope, kind, batchId: view.batch.id }
      }
      const next = unwrap(await remote(request))
      if (signal.aborted) return
      setView(next); setSelection(next.batch?.id)
      if (kind === 'start') { setImages([]); setRequirements(''); draftId.current = undefined }
    } catch (error) {
      if (!signal.aborted) setNotice(error instanceof Error ? error.message : '批次操作未完成。')
    } finally {
      action.current.running = false
      if (!signal.aborted) { setBusy(false); setRegistration(undefined) }
    }
  }
  const batch = selection && view?.batch?.id === selection ? view.batch : undefined
  const first = batch?.items.find(unfinishedBatchItem)
  const canManage = !!batch && batch.mainSessionId === ownerId
  const finished = !!batch && !first && !running
  const skipped = batch?.items.filter(item => item.state === 'skipped').length ?? 0
  const completed = batch?.items.filter(item => item.state === 'completed').length ?? 0
  const message = notice || readError || (batch ? view?.message : undefined) || (!running ? first?.message : undefined)
  let progress = ''
  if (registration !== undefined) progress = `正在登记 ${registration}/${images.length}`
  else if (batch && (running || !images.length)) {
    progress = `已完成 ${completed}/${batch.items.length}`
    if (skipped) progress += ` · 已跳过 ${skipped}`
    if (!running && first?.state === 'pending' && !message) progress += ' · 已暂停'
  } else if (images.length) progress = `已选 ${images.length} 张`

  let primaryAction: unknown = null
  if (finished) primaryAction = button('关闭', () => {
    action.current.version++
    setSelection(undefined); setNotice(''); setReadError('')
    if (!images.length) setOpen(false)
  }, busy)
  else if (canManage) {
    if (running) primaryAction = view?.pausing ? button('暂停中', () => {}, true) : button('暂停', () => { void perform('pause') }, busy)
    else if (first?.state === 'failed') primaryAction = button('重试本项', () => { void perform('retry') }, busy)
    else primaryAction = button('继续', () => { void perform('continue') }, busy)
  }
  const batchInput = h('input', { type: 'file', hidden: true, multiple: true, accept: '.png,.jpg,.jpeg,.webp', ref: picker, disabled: busy, 'aria-label': '选择批量图片',
    onChange: (event: { currentTarget: HTMLInputElement }) => { pick(event.currentTarget.files); event.currentTarget.value = '' } })
  const batchButton = h('button', { type: 'button', className: 'dsh-tp-attach', 'aria-label': '批量选择图片', title: '批量选择图片', disabled: busy,
    onClick: () => picker.current?.click(),
  }, h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M4 17a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2' }),
    h('path', { d: 'M9 7h7l5 5v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z' }),
    h('path', { d: 'M16 7v5h5M11 16h6m-6 3h6' }),
  ))
  const list = open ? h('div', { className: 'dsh-tp-batch-content' },
    images.length ? h('div', null,
      h('ol', { className: 'dsh-tp-batch-list' }, ...images.map((item, index) => h('li', { key: item.id },
        h('span', { title: item.file.name }, item.file.name),
        h('div', { className: 'dsh-tp-actions' },
          button('上移', () => move(index, -1), busy || index === 0, `上移 ${item.file.name}`),
          button('下移', () => move(index, 1), busy || index === images.length - 1, `下移 ${item.file.name}`),
          button('移除', () => setImages(current => current.filter(row => row.id !== item.id)), busy, `移除 ${item.file.name}`))))),
      h('textarea', { value: requirements, rows: 2, placeholder: '共同翻译要求（选填）', 'aria-label': '共同翻译要求', disabled: busy,
        onChange: (event: { currentTarget: HTMLTextAreaElement }) => setRequirements(event.currentTarget.value) }),
      button('开始翻译', () => { void perform('start') }, busy || running)) : null,
    view && view.batches.length > (first ? 1 : 0) ? h('select', { value: first ? batch?.id : '', 'aria-label': '切换待处理批次', disabled: busy || running,
      onChange: (event: { currentTarget: HTMLSelectElement }) => { action.current.version++; setSelection(event.currentTarget.value) } },
      first ? null : h('option', { value: '', disabled: true }, '切换待处理批次'),
      ...view.batches.map(item => h('option', { key: item.id, value: item.id }, `${item.name} · ${item.completed}/${item.total}`))) : null,
    batch ? h('div', null,
      h('ol', { className: 'dsh-tp-batch-list' }, ...batch.items.map(item => h('li', { key: item.unitId },
        button(item.name, () => onOpenUnit(item.unitId), false, `查看单元 ${item.name}`),
        h('small', { className: 'dsh-tp-muted' }, item.message ?? statusText[item.state])))),
      canManage && !running && (first?.state === 'failed' || first?.state === 'pending')
        ? button('跳过本项', () => { void perform('skip') }, busy) : null,
    ) : null,
  ) : null
  return h('div', null,
    images.length || batch || notice ? h('section', { className: 'dsh-tp-batch', 'aria-label': '批次状态', 'data-expanded': open },
      h('div', { className: 'dsh-tp-batch-header' },
        h('button', { type: 'button', 'aria-label': '批次清单', 'aria-expanded': open, onClick: () => setOpen(!open) },
          h('span', { 'aria-hidden': true }, open ? '▾ ' : '▸ '), '批次清单'),
        progress ? h('span', { role: 'status', className: 'dsh-tp-muted' }, progress) : null,
        primaryAction ? h('div', { className: 'dsh-tp-batch-action' }, primaryAction) : null,
      ),
      message ? h('p', { role: 'status', className: 'dsh-tp-batch-notice dsh-tp-muted', title: message }, message) : null,
      list,
    ) : null,
    renderComposer(batchInput, batchButton),
  )
}
