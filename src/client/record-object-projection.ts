import { recordObjectTargetMatches, type RecordObjectReference, type RecordObjectTarget } from '../shared/record-objects.js'

export type RecordObjectSegment = { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'object'; readonly reference: RecordObjectReference; readonly label: string }
export interface RecordObjectProjection { readonly segments: readonly RecordObjectSegment[]; readonly unavailableRefs: readonly RecordObjectReference[] }
const labels = { image: '图片', table: '表格', code: '代码', formula: '公式', document: '文档' } as const
export function recordObjectLabel(reference: RecordObjectReference): string { return `${labels[reference.asset.kind]}${reference.objectOrdinal}` }

/** Object markers come only from immutable metadata, never from characters such as “[图片1]”. */
export function projectRecordObjects(text: string, scope: RecordObjectTarget, references: readonly RecordObjectReference[]): RecordObjectProjection {
  const points = Array.from(text), matching = references.filter(ref => recordObjectTargetMatches(ref, scope))
  const unavailableRefs = matching.filter(ref => !Number.isSafeInteger(ref.offset) || ref.offset < 0 || ref.offset > points.length)
  const valid = matching.filter(ref => !unavailableRefs.includes(ref)).map((ref, index) => ({ ref, index })).sort((a, b) => a.ref.offset - b.ref.offset || a.index - b.index)
  const segments: RecordObjectSegment[] = []
  let position = 0
  for (const { ref } of valid) {
    if (ref.offset > position) segments.push({ kind: 'text', text: points.slice(position, ref.offset).join('') })
    segments.push({ kind: 'object', reference: ref, label: recordObjectLabel(ref) }); position = ref.offset
  }
  if (position < points.length) segments.push({ kind: 'text', text: points.slice(position).join('') })
  return { segments, unavailableRefs }
}
