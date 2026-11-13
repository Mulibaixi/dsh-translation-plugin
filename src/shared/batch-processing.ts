import type { HistoryScope } from './history-bundle.js'
import { parseHistoryScope } from './history-remote.js'
import { referenceExact, referenceObject, referenceString } from './reference-memory.js'
import { DIRECT_REQUIREMENTS_CODE_POINTS } from './normal-translation.js'
import type { DirectContextSupplement } from './direct-context.js'

export const BATCH_FILE_LIMIT = 100
export const BATCH_OPERATION_PREFIX = 'translation-batch-item:'

export function batchOperationId(operationId: string, context?: DirectContextSupplement): string | undefined {
  return [operationId, context?.operationId, ...context?.previous?.map(answer => answer.operationId) ?? []]
    .find(id => id?.startsWith(BATCH_OPERATION_PREFIX))
}

export interface BatchItem {
  readonly unitId: string
  readonly name: string
  readonly state: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
  readonly operationId?: string
  readonly revisionId?: string
  readonly message?: string
}

export interface ProcessingBatch {
  readonly id: string
  readonly mainSessionId: string
  readonly action: 'translate_images'
  readonly requirements: string
  readonly items: readonly BatchItem[]
}

export function unfinishedBatchItem(item: BatchItem): boolean {
  return item.state !== 'completed' && item.state !== 'skipped'
}

export type BatchRequest = HistoryScope & { readonly mainSessionId: string } & (
  | { readonly kind: 'read'; readonly batchId?: string }
  | { readonly kind: 'start'; readonly batchId: string; readonly action: ProcessingBatch['action']; readonly unitIds: readonly string[]; readonly requirements: string }
  | { readonly kind: 'pause' | 'continue' | 'retry' | 'skip'; readonly batchId: string }
)
export interface BatchView {
  readonly batches: readonly { readonly id: string; readonly name: string; readonly completed: number; readonly total: number }[]
  readonly batch: ProcessingBatch | null
  readonly running: boolean
  readonly pausing?: boolean
  readonly message?: string
}

export interface BatchProcessingRemote {
  batch(request: BatchRequest): Promise<unknown>
}

function requirements(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Array.from(value).length > DIRECT_REQUIREMENTS_CODE_POINTS || /[\u0000\ud800-\udfff]/u.test(value)) throw new TypeError('批次共同要求无效或过长。')
}

export function parseBatchRequest(value: unknown): BatchRequest {
  parseHistoryScope(value)
  referenceString(value.mainSessionId)
  const base = ['namespaceId', 'topicId', 'sessionId', 'mainSessionId', 'kind']
  if (value.kind === 'read') referenceExact(value, base, ['batchId'])
  else if (value.kind === 'start') {
    referenceExact(value, [...base, 'batchId', 'action', 'unitIds', 'requirements'])
    if (value.action !== 'translate_images' || !Array.isArray(value.unitIds) || !value.unitIds.length || value.unitIds.length > BATCH_FILE_LIMIT ||
      new Set(value.unitIds).size !== value.unitIds.length) throw new TypeError('批次动作或目标清单无效。')
    for (const id of value.unitIds) referenceString(id)
    requirements(value.requirements)
  } else {
    referenceExact(value, [...base, 'batchId'])
    if (!['pause', 'continue', 'retry', 'skip'].includes(String(value.kind))) throw new TypeError('批次操作无效。')
  }
  if (value.kind !== 'read' || value.batchId !== undefined) referenceString(value.batchId)
  return value as unknown as BatchRequest
}

export function parseProcessingBatch(value: unknown): ProcessingBatch {
  referenceObject(value)
  referenceExact(value, ['id', 'mainSessionId', 'action', 'requirements', 'items'])
  referenceString(value.id); referenceString(value.mainSessionId); requirements(value.requirements)
  if (value.action !== 'translate_images' || !Array.isArray(value.items) || !value.items.length || value.items.length > BATCH_FILE_LIMIT) throw new TypeError('批次记录无效。')
  const unitIds = new Set<unknown>()
  for (const item of value.items) {
    referenceObject(item)
    referenceExact(item, ['unitId', 'name', 'state'], ['operationId', 'revisionId', 'message'])
    referenceString(item.unitId); referenceString(item.name, 255)
    if (unitIds.has(item.unitId) || !['pending', 'processing', 'completed', 'failed', 'skipped'].includes(String(item.state))) throw new TypeError('批次处理项无效。')
    unitIds.add(item.unitId)
    for (const field of ['operationId', 'revisionId', 'message']) if (item[field] !== undefined) referenceString(item[field], 1000)
    if (item.state === 'processing' && (typeof item.operationId !== 'string' || !item.operationId.startsWith(BATCH_OPERATION_PREFIX))) throw new TypeError('批次操作 ID 无效。')
  }
  return value as unknown as ProcessingBatch
}

export function parseBatchView(value: unknown): BatchView {
  referenceObject(value)
  referenceExact(value, ['batches', 'batch', 'running'], ['message', 'pausing'])
  if (!Array.isArray(value.batches) || typeof value.running !== 'boolean') throw new TypeError('批次回执无效。')
  if (value.pausing !== undefined && (typeof value.pausing !== 'boolean' || (value.pausing && !value.running))) throw new TypeError('批次暂停状态无效。')
  for (const entry of value.batches) {
    referenceObject(entry); referenceExact(entry, ['id', 'name', 'completed', 'total'])
    referenceString(entry.id); referenceString(entry.name, 255)
    if (typeof entry.completed !== 'number' || typeof entry.total !== 'number' || !Number.isInteger(entry.completed) || !Number.isInteger(entry.total) ||
      entry.completed < 0 || entry.total < entry.completed || entry.total > BATCH_FILE_LIMIT) throw new TypeError('批次进度无效。')
  }
  if (value.batch !== null) parseProcessingBatch(value.batch)
  if (value.message !== undefined) referenceString(value.message, 1000)
  return value as unknown as BatchView
}

const codec = (name: string, parse: (value: unknown) => unknown) => ({
  mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#${name}`, create: () => ({ parse }),
})
export const BATCH_PROCESSING_REMOTE = { descriptors: [{
  id: 'dsh-translation-plugin#translationBatchProcessing/batch', service: 'translationBatchProcessing', namespace: 'translationBatchProcessing',
  method: 'batch', invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('batch-processing-request', parseBatchRequest) }],
  result: codec('batch-processing-view', parseBatchView),
}] }
