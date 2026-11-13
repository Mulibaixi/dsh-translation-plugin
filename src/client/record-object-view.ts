import { h, react } from './react.js'
import type { RecordObjectTarget, RecordObjectReferenceInput, RecordObjectReference } from '../shared/record-objects.js'
import type { TranslationSourceRange } from '../shared/translation-source-read.js'
import { OBJECT_ASSET_KINDS, type ObjectAssetKind } from '../shared/object-assets.js'
import type { RecordObjectStore } from './record-object-store.js'
import type { ObjectAssetsClient } from './object-assets-client.js'
import type { ViewFilesClient } from './view-files-client.js'
import { projectRecordObjects, recordObjectLabel } from './record-object-projection.js'
import { canEditTextRevision, type TextUnit } from './translation-history.js'
import type { LocalSession } from './sessions.js'
import { MarkdownText } from './native-ui.js'

export interface RecordObjectsProps { readonly executionOwner?: string | undefined; readonly objects?: RecordObjectStore | undefined; readonly objectAssets?: ObjectAssetsClient | undefined; readonly viewFiles?: ViewFilesClient | undefined }
function RecordObjectFormula({ source }: { readonly source: string }): unknown {
  return h('span', { className: 'dsh-tp-object-formula' },
    h('span', { className: 'dsh-tp-object-formula-preview' }, h(MarkdownText, { text: `$$\n${source}\n$$`, variant: 'compact' })),
    h('details', null, h('summary', null, '公式源'), h('pre', null, source)),
    h('small', { className: 'dsh-tp-muted' }, '公式源和原件可查看。'))
}
export function RecordObjectText({ text, target, objects, objectAssets, references, range, totalCodePoints, hideUnavailable = false, className, renderText, quoteSource }: RecordObjectsProps & {
  readonly text: string; readonly target: RecordObjectTarget; readonly references?: readonly RecordObjectReference[] | undefined
  readonly range?: TranslationSourceRange | undefined; readonly totalCodePoints?: number | undefined; readonly hideUnavailable?: boolean
  readonly className?: string | undefined
  readonly quoteSource?: string | undefined
  readonly renderText?: ((text: string, offset: number) => unknown) | undefined
}): unknown {
  const [failures, setFailures] = react.useState<ReadonlyMap<string, string>>(() => new Map())
  const refs = references ?? objects?.getReferences(target) ?? []
  const pageRefs = range ? refs.filter(ref => ref.offset >= range.start && (ref.offset < range.end || ref.offset === range.end && range.end === totalCodePoints)).map(ref => ({ ...ref, offset: ref.offset - range.start })) : refs
  const projected = projectRecordObjects(text, target, pageRefs)
  function object(reference: typeof projected.unavailableRefs[number], unavailable = false): unknown {
    const refId = reference.refId, label = recordObjectLabel(reference)
    return h('span', { key: refId, 'data-object-ref-id': refId }, h('button', {
      type: 'button', className: 'dsh-tp-object-link', 'aria-label': `打开${label}：${reference.asset.name}`,
      title: reference.asset.name, disabled: !objectAssets, onClick: () => {
        setFailures(current => { const next = new Map(current); next.delete(refId); return next })
        void objectAssets?.open(target.ownerId, target.topicId, reference.asset).catch(error => setFailures(current => new Map(current).set(refId, error instanceof Error ? error.message : '无法打开原件，请重试。')))
      },
    }, `[${label}]`),
    unavailable ? h('small', { className: 'dsh-tp-muted' }, '关联位置不可用') : null,
    failures.get(refId) ? h('small', { role: 'alert', className: 'dsh-tp-object-failure' }, failures.get(refId)) : null,
    reference.asset.kind === 'formula' && reference.formulaSource ? h(RecordObjectFormula, { source: reference.formulaSource }) : null)
  }
  let offset = 0
  return h('div', { className: className ? `dsh-tp-translation-text ${className}` : 'dsh-tp-translation-text', 'data-translation-quote': quoteSource }, ...projected.segments.map(segment => {
    if (segment.kind !== 'text') return object(segment.reference)
    const start = offset
    for (const _ of segment.text) offset++
    return renderText ? renderText(segment.text, start) : segment.text
  }),
    !hideUnavailable && projected.unavailableRefs.length ? h('div', { className: 'dsh-tp-object-unavailable', 'aria-label': '关联位置不可用' }, ...projected.unavailableRefs.map(reference => object(reference, true))) : null)
}

export function RecordObjectEditor({ session, unit, objects, objectAssets, executionOwner }: RecordObjectsProps & { readonly session: LocalSession; readonly unit: TextUnit }): unknown {
  const [targetId, setTargetId] = react.useState('source')
  const [kind, setKind] = react.useState<ObjectAssetKind>('image')
  const [offset, setOffset] = react.useState<string>('')
  const [file, setFile] = react.useState<File | undefined>(undefined)
  const [sourceRefId, setSourceRefId] = react.useState('')
  const [action, setAction] = react.useState<'file' | 'reuse' | 'result'>('file')
  const [pending, setPending] = react.useState(false)
  const [message, setMessage] = react.useState<string | undefined>(undefined)
  const [retry, setRetry] = react.useState<RecordObjectReferenceInput | undefined>(undefined)
  const [formulaSource, setFormulaSource] = react.useState('')
  const fileInput = react.useRef<{ value: string } | null>(null)
  const lifetime = react.useRef({ mounted: true, busy: false })
  react.useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false } }, [])
  const sourceTarget: RecordObjectTarget = { ownerId: objects?.scopeFor(session.id) ?? session.topicId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'source', revisionId: null }
  const sourceRefs = objects?.getReferences(sourceTarget) ?? []
  const selectedRef = sourceRefs.find(ref => ref.refId === sourceRefId)
  const revision = unit.revisions.find(revision => revision.id === targetId)
  const target: RecordObjectTarget = targetId === 'source' ? sourceTarget : { ...sourceTarget, side: 'revision', revisionId: targetId }
  const body = targetId === 'source' ? unit.source : revision?.text
  const position = offset === '' ? Array.from(body ?? '').length : Number(offset)
  const invalidPosition = body === undefined || !Number.isSafeInteger(position) || position < 0 || position > Array.from(body).length
  const controlsDisabled = pending || !!retry || session.archivedAt !== null
  async function associate(): Promise<void> {
    if (!objectAssets || !objects || lifetime.current.busy || session.archivedAt !== null) return
    lifetime.current.busy = true; setPending(true); setMessage(undefined)
    try {
      let input: RecordObjectReferenceInput
      let result
      if (retry) { input = retry; result = await objectAssets.bind(input) }
      else if (action === 'reuse') {
        if (!selectedRef || target.side !== 'revision') throw new Error('请选择原件和译文版本。')
        input = { ...target, offset: position, asset: selectedRef.asset, ...(selectedRef.formulaSource ? { formulaSource: selectedRef.formulaSource } : {}) }; result = await objectAssets.bind(input)
      } else {
        if (!file || action === 'result' && (!selectedRef || target.side !== 'revision')) throw new Error('请选择文件、原件及译文版本。')
        const attached = await objectAssets.attachFile(target, position, action === 'result' ? selectedRef!.asset.kind : kind, file, action === 'result' ? selectedRef!.asset.objectId : undefined, formulaSource, executionOwner)
        input = attached.input; result = attached.result
      }
      if (!lifetime.current.mounted) return
      if (result.status === 'updated' || result.status === 'unchanged') { setRetry(undefined); setFile(undefined); setFormulaSource(''); if (fileInput.current) fileInput.current.value = ''; setMessage('已关联。') }
      else { setRetry(input); setMessage(result.status === 'save_failed' ? '原件已登记，关联位置尚未保存。可重试保存关联。' : '关联位置未保存，请核对记录后重试。') }
    } catch (error) { if (lifetime.current.mounted) setMessage(error instanceof Error ? error.message : '关联未完成，请重试。') }
    finally { lifetime.current.busy = false; if (lifetime.current.mounted) setPending(false) }
  }
  const labels = { image: '图片', table: '表格', code: '代码', formula: '公式', document: '文档' }
  return objects && objectAssets ? h('div', { className: 'dsh-tp-object-editor', 'aria-label': '关联原件' },
    h('h4', null, '关联原件'),
    h('fieldset', { className: 'dsh-tp-object-controls', disabled: session.archivedAt !== null },
      h('select', { 'aria-label': '关联到', value: targetId, disabled: controlsDisabled, onChange: (event: { currentTarget: { value: string } }) => { setTargetId(event.currentTarget.value); setOffset(''); setFormulaSource(''); setMessage(undefined) } },
        h('option', { value: 'source' }, '原文'), ...unit.revisions.filter(canEditTextRevision).map(revision => h('option', { key: revision.id, value: revision.id }, `译文版本 ${revision.order}`))),
      h('select', { 'aria-label': '关联方式', value: action, disabled: controlsDisabled, onChange: (event: { currentTarget: { value: string } }) => { setAction(event.currentTarget.value as typeof action); setFormulaSource(''); setMessage(undefined) } },
        h('option', { value: 'file' }, '新原件'), h('option', { value: 'reuse', disabled: target.side !== 'revision' || !sourceRefs.length }, '沿用原件'), h('option', { value: 'result', disabled: target.side !== 'revision' || !sourceRefs.length }, '结果新文件')),
      action === 'file' ? h('select', { 'aria-label': '原件类型', value: kind, disabled: controlsDisabled, onChange: (event: { currentTarget: { value: string } }) => { setKind(event.currentTarget.value as ObjectAssetKind); setFormulaSource('') } }, ...OBJECT_ASSET_KINDS.map(kind => h('option', { key: kind, value: kind }, labels[kind]))) : h('select', { 'aria-label': '选择原件', value: sourceRefId, disabled: controlsDisabled, onChange: (event: { currentTarget: { value: string } }) => { setSourceRefId(event.currentTarget.value); setFormulaSource('') } }, h('option', { value: '' }, '选择原件'), ...sourceRefs.map(ref => h('option', { key: ref.refId, value: ref.refId }, `${recordObjectLabel(ref)} · ${ref.asset.name}`))),
      h('label', null, '第 ', h('input', { type: 'number', min: 0, max: Array.from(body ?? '').length, 'aria-label': '关联位置', placeholder: String(Array.from(body ?? '').length), value: offset, disabled: controlsDisabled, onChange: (event: { currentTarget: { value: string } }) => setOffset(event.currentTarget.value) }), ' 个字符后'),
      action !== 'reuse' ? h('input', { type: 'file', ref: fileInput, 'aria-label': '选择原件文件', disabled: controlsDisabled, onChange: (event: { currentTarget: { files: FileList | null } }) => { setFile(event.currentTarget.files?.[0]); setFormulaSource('') } }) : null,
      h('button', { type: 'button', disabled: pending || session.archivedAt !== null || (!retry && (invalidPosition || (action === 'reuse' ? !selectedRef || target.side !== 'revision' : !file || action === 'result' && (!selectedRef || target.side !== 'revision')))), onClick: () => { void associate() } }, pending ? '正在关联…' : retry ? '重试保存关联' : '关联'),
      retry ? h('button', { type: 'button', disabled: pending, onClick: () => { setRetry(undefined); setMessage(undefined) } }, '取消重试') : null),
    action !== 'reuse' && (action === 'result' ? selectedRef?.asset.kind : kind) === 'formula' ? h('label', { className: 'dsh-tp-field' }, '公式源（TeX，可选）', h('textarea', { 'aria-label': '公式源', value: formulaSource, rows: 2, disabled: controlsDisabled, onChange: (event: { currentTarget: { value: string } }) => setFormulaSource(event.currentTarget.value) })) : null,
    h('small', { className: 'dsh-tp-muted' }, '默认置于正文末尾；已有位置只读。原件及打开索引留存在 DSH；记录中的关联位置自动保存。'),
    message ? h('p', { role: retry ? 'alert' : 'status', className: 'dsh-tp-muted' }, message) : null) : null
}
