import type { HistoryScope } from './history-bundle.js'
import { referenceExact, referenceInteger, referenceObject, referenceString } from './reference-memory.js'

export interface RecordIndexTarget extends HistoryScope { readonly unitId: string; readonly sourceVersion: number }
export interface RecordIndexState {
  readonly phase: 'unselected' | 'submitted' | 'segmenting' | 'partial' | 'embedding' | 'indexed' | 'failed' | 'empty'
  readonly segments: number; readonly indexed: number; readonly total: number; readonly message?: string
}
export interface RecordIndexRequest extends RecordIndexTarget { readonly mainSessionId: string; readonly action: 'start' | 'resegment' | 'retry' | 'remove' }
export interface RecordIndexMark { readonly end: number; readonly kind: 'content' | 'exclude' }
export interface RecordIndexPlan { readonly sourceVersion: number; readonly sourceHash: string; readonly version: number; readonly marks: readonly RecordIndexMark[] }
export interface RecordIndexRemotePort {
  status(request: RecordIndexTarget): Promise<unknown>
  request(request: RecordIndexRequest): Promise<unknown>
}
export function parseRecordIndexTarget(value: unknown, request = false): RecordIndexTarget | RecordIndexRequest {
  referenceObject(value); referenceExact(value, ['namespaceId', 'topicId', 'sessionId', 'unitId', 'sourceVersion', ...(request ? ['mainSessionId', 'action'] : [])])
  for (const name of ['namespaceId', 'topicId', 'sessionId', 'unitId']) referenceString(value[name], 3000)
  referenceInteger(value.sourceVersion, 1)
  if (request) {
    referenceString(value.mainSessionId, 3000)
    if (!['start', 'resegment', 'retry', 'remove'].includes(String(value.action))) throw new TypeError('Invalid file index action')
  }
  return structuredClone(value) as unknown as RecordIndexTarget | RecordIndexRequest
}
export function parseRecordIndexState(value: unknown): RecordIndexState {
  referenceObject(value); referenceExact(value, ['phase', 'segments', 'indexed', 'total'], ['message'])
  if (!['unselected', 'submitted', 'segmenting', 'partial', 'embedding', 'indexed', 'failed', 'empty'].includes(String(value.phase))) throw new TypeError('Invalid file index phase')
  for (const name of ['segments', 'indexed', 'total']) referenceInteger(value[name])
  if ((value.indexed as number) > (value.total as number)) throw new TypeError('Invalid file index coverage')
  if (value.message !== undefined) referenceString(value.message, 500)
  return structuredClone(value) as unknown as RecordIndexState
}
export function parseRecordIndexPlan(value: unknown): RecordIndexPlan {
  referenceObject(value); referenceExact(value, ['sourceVersion', 'sourceHash', 'version', 'marks'])
  referenceInteger(value.sourceVersion, 1); referenceInteger(value.version, 1)
  if (typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceHash) || !Array.isArray(value.marks) || value.marks.length > 40000) throw new TypeError('Invalid file index plan')
  let previous = 0
  for (const mark of value.marks) {
    referenceObject(mark); referenceExact(mark, ['end', 'kind']); referenceInteger(mark.end, previous + 1)
    if (!['content', 'exclude'].includes(String(mark.kind)) || mark.kind === 'content' && (mark.end as number) - previous > 2000) throw new TypeError('Invalid file index boundary')
    previous = mark.end as number
  }
  return structuredClone(value) as unknown as RecordIndexPlan
}
export const RECORD_INDEX_GUIDANCE = 'This is a user-requested semantic indexing task for ONE recorded source file, not translation. Read the complete original with translation_record_segmentation_read, following next; read ahead at page edges. Submit ordered marks {endAnchor,kind:content|exclude} using translation_record_segment and the latest planVersion. Each content mark is one coherent idea or a few adjacent exchanges, usually 200–600 Unicode code points, at most 2000. Preserve speakers, pronoun context and meaningful headings. Mark export-only scene IDs, source filenames, counts and technical metadata as exclude. For Markdown reuse the file-translation distinction between natural-language content and unchanged structure: exclude code/diagram blocks, formulas and technical front matter; retain heading, list, quote, table-cell and link-label prose. The program removes inline code, markup and destinations from embedding input while preserving exact originals. Never rewrite, translate, summarize or calculate numeric offsets. Every source position must belong to content or exclude, including the final anchor; incomplete plans are never embedded. Resume existing marks after interruption; replace only for requested resegmentation. A queued embedding is not a completed index. Original and translation ranges are independent; never infer bilingual alignment.'
export const RECORD_INDEX_REMOTE = { package: 'dsh-translation-plugin', descriptors: (['status', 'request'] as const).map(method => ({
  id: `dsh-translation-plugin#translationRecordIndex/${method}`, service: 'translationRecordIndex', namespace: 'translationRecordIndex', method, invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#record-index-${method}`, create: () => ({ parse: (value: unknown) => parseRecordIndexTarget(value, method === 'request') }) } }],
  result: { mode: 'strict' as const, typeSymbol: 'dsh-translation-plugin#record-index-state', create: () => ({ parse: parseRecordIndexState }) },
})) }
