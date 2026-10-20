import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope, type TranslationMaterialScope } from './translation-material.js'

export interface TranslationMaterialCapability {
  readonly ready: boolean
  /** Host admission only; this does not report whether the Client submission seam is available. */
  readonly directSubmit: boolean
  readonly storage: 'runtime_only'
  readonly reason?: string
}
export type TranslationMaterialStage = 'prepared' | 'submitted' | 'attached' | 'unknown' | 'released'
export interface TranslationMaterialReceipt extends TranslationMaterialScope {
  readonly kind: TranslationMaterialEnvelope['kind']
  readonly stage: TranslationMaterialStage
  readonly mainMessageId?: string
}
export interface TranslationMaterialQuery {
  readonly receipt: TranslationMaterialReceipt
  readonly snapshot: TranslationMaterialEnvelope
  readonly workflow?: TranslationMaterialWorkflow
}
/** Actual preparation facts only; an absent analysis is explicitly waiting. */
export interface TranslationMaterialWorkflow {
  readonly phase: 'waiting' | 'frozen' | 'preparing' | 'running' | 'completed' | 'failed' | 'unknown'
  readonly message: string
}
export interface TranslationMaterialFinish extends TranslationMaterialScope {
  readonly outcome: 'submitted' | 'no_prompt' | 'failed' | 'unknown'
}
export type TranslationMaterialResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly stage: string } }
export interface TranslationMaterialsPort {
  capabilities(): Promise<TranslationMaterialResult<TranslationMaterialCapability>>
  prepare(request: TranslationMaterialEnvelope): Promise<TranslationMaterialResult<TranslationMaterialReceipt>>
  query(request: TranslationMaterialScope): Promise<TranslationMaterialResult<TranslationMaterialQuery | null>>
  finish(request: TranslationMaterialFinish): Promise<TranslationMaterialResult<TranslationMaterialReceipt>>
  release(request: TranslationMaterialScope): Promise<TranslationMaterialResult<{ readonly released: boolean }>>
  submit(request: TranslationMaterialEnvelope): Promise<TranslationMaterialResult<TranslationMaterialReceipt>>
}

type Data = Record<string, unknown>
function object(value: unknown): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected material bridge object')
}
function fields(value: Data, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected material bridge fields')
}
function text(value: unknown, maximum = 2048): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new TypeError('Invalid material bridge identity or error')
}
const scopeFields = ['mainSessionId', 'requestId', 'operationId'] as const
function scope(value: Data): TranslationMaterialScope {
  text(value.mainSessionId, 1000); text(value.requestId); text(value.operationId)
  return { mainSessionId: value.mainSessionId, requestId: value.requestId, operationId: value.operationId }
}
export function parseTranslationMaterialRequest(method: 'prepare' | 'query' | 'finish' | 'release' | 'submit', value: unknown): TranslationMaterialEnvelope | TranslationMaterialScope | TranslationMaterialFinish {
  if (method === 'prepare' || method === 'submit') return parseTranslationMaterialEnvelope(value)
  object(value); fields(value, method === 'finish' ? [...scopeFields, 'outcome'] : scopeFields)
  const request = scope(value)
  if (method !== 'finish') return request
  if (!['submitted', 'no_prompt', 'failed', 'unknown'].includes(value.outcome as string)) throw new TypeError('Invalid material submission outcome')
  return { ...request, outcome: value.outcome as TranslationMaterialFinish['outcome'] }
}
function receipt(value: unknown): TranslationMaterialReceipt {
  object(value); fields(value, [...scopeFields, 'kind', 'stage'], ['mainMessageId'])
  const request = scope(value)
  if (!['material', 'none', 'omit'].includes(value.kind as string) || !['prepared', 'submitted', 'attached', 'unknown', 'released'].includes(value.stage as string)) throw new TypeError('Invalid material bridge receipt')
  if (value.mainMessageId !== undefined) text(value.mainMessageId)
  return { ...request, kind: value.kind as TranslationMaterialReceipt['kind'], stage: value.stage as TranslationMaterialStage,
    ...(value.mainMessageId === undefined ? {} : { mainMessageId: value.mainMessageId }) }
}
const methods = ['capabilities', 'prepare', 'query', 'finish', 'release', 'submit'] as const
export function parseTranslationMaterialResult(method: typeof methods[number], value: unknown): unknown {
  object(value)
  if (value.ok === false) {
    fields(value, ['ok', 'error']); object(value.error); fields(value.error, ['code', 'message', 'stage'])
    text(value.error.code, 80); text(value.error.message, 1000); text(value.error.stage, 80)
  } else {
    if (value.ok !== true) throw new TypeError('Invalid material bridge result')
    fields(value, ['ok', 'value'])
    if (method === 'capabilities') {
      object(value.value); fields(value.value, ['ready', 'directSubmit', 'storage'], ['reason'])
      if (typeof value.value.ready !== 'boolean' || typeof value.value.directSubmit !== 'boolean' || value.value.storage !== 'runtime_only') throw new TypeError('Invalid material bridge capability')
      if (value.value.reason !== undefined) text(value.value.reason, 1000)
    } else if (method === 'release') {
      object(value.value); fields(value.value, ['released'])
      if (typeof value.value.released !== 'boolean') throw new TypeError('Invalid material release receipt')
    } else if (method === 'query') {
      if (value.value !== null) {
        object(value.value); fields(value.value, ['receipt', 'snapshot'], ['workflow'])
        const facts = receipt(value.value.receipt), snapshot = parseTranslationMaterialEnvelope(value.value.snapshot)
        if (scopeFields.some(key => facts[key] !== snapshot[key]) || facts.kind !== snapshot.kind || facts.stage === 'released') throw new TypeError('Material query identity mismatch')
        if (value.value.workflow !== undefined) {
          object(value.value.workflow); fields(value.value.workflow, ['phase', 'message'])
          if (!['waiting', 'frozen', 'preparing', 'running', 'completed', 'failed', 'unknown'].includes(value.value.workflow.phase as string)) throw new TypeError('Invalid material workflow phase')
          text(value.value.workflow.message, 1000)
        }
      }
    } else receipt(value.value)
  }
  return structuredClone(value)
}
export const TRANSLATION_MATERIAL_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: methods.map(method => ({
    id: `dsh-translation-plugin#translationMaterials/${method}`, service: 'translationMaterials', namespace: 'translationMaterials', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'capabilities' ? [] : [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#material-${method}-request`, create: () => ({ parse: (value: unknown) => parseTranslationMaterialRequest(method, value) }) } }],
    ...(method === 'submit' ? { cancellation: { parameter: 'signal' } } : {}),
    result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#material-${method}-result`, create: () => ({ parse: (value: unknown) => parseTranslationMaterialResult(method, value) }) },
  })),
}
