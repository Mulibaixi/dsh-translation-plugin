import type { ModelSelection } from './contracts.js'
import type { DomainResult } from './domain-contracts.js'
import { parseTranslationCallMetadata, type TranslationCallMetadata } from './translation-call.js'

export interface QuickTranslationCapability {
  readonly ready: boolean
  readonly reason?: string
  readonly storage: 'runtime_only'
  readonly mode: 'quick'
}

export interface QuickTranslationOpen {
  readonly localSessionId: string
  readonly maxSourceCodePoints: number
}

export interface QuickTranslationBinding {
  /** Unpredictable capability for this isolated Host context; never persisted. */
  readonly sessionKey: string
  readonly localSessionId: string
  readonly maxSourceCodePoints: number
}

export interface QuickTranslationSubmit {
  readonly sessionKey: string
  readonly operationId: string
  /** Stable browser-owned unit identity; never a Host capability or persisted execution handle. */
  readonly unitId?: string
  readonly draftVersion: number
  readonly sourceText: string
  readonly targetLanguage: string
  readonly instruction: string
  readonly model: ModelSelection
}

export interface QuickTranslationQuery {
  readonly sessionKey: string
  readonly operationId: string
}

export interface QuickTranslationJob extends QuickTranslationQuery {
  readonly draftVersion: number
  readonly accepted: boolean
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  /** Translation or incomplete output only. Source material is not returned. */
  readonly text: string
  readonly metadata?: TranslationCallMetadata
  readonly error?: { readonly code: string; readonly message: string; readonly stage?: string }
}

export interface QuickTranslationPort {
  capabilities(): Promise<DomainResult<QuickTranslationCapability>>
  open(request: QuickTranslationOpen): Promise<DomainResult<QuickTranslationBinding>>
  submit(request: QuickTranslationSubmit): Promise<DomainResult<QuickTranslationJob>>
  status(request: QuickTranslationQuery): Promise<DomainResult<QuickTranslationJob>>
  cancel(request: QuickTranslationQuery): Promise<DomainResult<QuickTranslationJob>>
}

type Data = Record<string, unknown>
function record(value: unknown): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object')
}
function exact(value: Data, fields: readonly string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new TypeError('Unexpected request field')
}
function bounded(value: unknown, limit: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new TypeError('Invalid text field')
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new TypeError('Invalid numeric field')
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new TypeError('Invalid identity')
}

/** Strict browser-safe parsers consumed by the actual Typert Gateway codec boundary. */
export function parseQuickRequest(method: 'open' | 'submit' | 'status' | 'cancel', value: unknown): QuickTranslationOpen | QuickTranslationSubmit | QuickTranslationQuery {
  record(value)
  if (method === 'open') {
    exact(value, ['localSessionId', 'maxSourceCodePoints'])
    bounded(value.localSessionId, 2048)
    integer(value.maxSourceCodePoints, 1, 1_000_000)
  } else {
    exact(value, method === 'submit'
      ? ['sessionKey', 'operationId', 'unitId', 'draftVersion', 'sourceText', 'targetLanguage', 'instruction', 'model']
      : ['sessionKey', 'operationId'])
    identity(value.sessionKey); identity(value.operationId)
    if (method === 'submit') {
      if (value.unitId !== undefined) bounded(value.unitId, 2048)
      integer(value.draftVersion, 1, Number.MAX_SAFE_INTEGER)
      bounded(value.sourceText, 2_000_000)
      bounded(value.targetLanguage, 200)
      bounded(value.instruction, 20_000, true)
      record(value.model)
      exact(value.model, ['providerId', 'modelId', 'configVersion', 'reasoningEffort'])
      bounded(value.model.providerId, 512); bounded(value.model.modelId, 512)
      integer(value.model.configVersion, 0, Number.MAX_SAFE_INTEGER)
      if (value.model.reasoningEffort !== undefined) bounded(value.model.reasoningEffort, 64)
    }
  }
  return structuredClone(value) as unknown as QuickTranslationOpen | QuickTranslationSubmit | QuickTranslationQuery
}

const packageName = 'dsh-translation-plugin'
const methods = ['capabilities', 'open', 'submit', 'status', 'cancel'] as const

export function parseQuickResult(method: typeof methods[number], value: unknown): unknown {
  record(value)
  if (value.ok === false) {
    exact(value, ['ok', 'error']); record(value.error); exact(value.error, ['code', 'message'])
    bounded(value.error.code, 80); bounded(value.error.message, 1000)
    return structuredClone(value)
  }
  if (value.ok !== true) throw new TypeError('Invalid result envelope')
  exact(value, ['ok', 'value']); record(value.value)
  const result = value.value
  if (method === 'capabilities') {
    exact(result, ['ready', 'reason', 'storage', 'mode'])
    if (typeof result.ready !== 'boolean' || result.storage !== 'runtime_only' || result.mode !== 'quick') throw new TypeError('Invalid capability')
    if (result.reason !== undefined) bounded(result.reason, 1000)
  } else if (method === 'open') {
    exact(result, ['sessionKey', 'localSessionId', 'maxSourceCodePoints'])
    identity(result.sessionKey); bounded(result.localSessionId, 2048); integer(result.maxSourceCodePoints, 1, 1_000_000)
  } else {
    exact(result, ['sessionKey', 'operationId', 'draftVersion', 'accepted', 'status', 'text', 'metadata', 'error'])
    identity(result.sessionKey); identity(result.operationId); integer(result.draftVersion, 0, Number.MAX_SAFE_INTEGER)
    if (typeof result.accepted !== 'boolean' || typeof result.status !== 'string' || !['running', 'completed', 'failed', 'cancelled', 'unknown'].includes(result.status)) throw new TypeError('Invalid job state')
    bounded(result.text, 2_000_000, true)
    if (result.draftVersion === 0 && (result.accepted || result.status !== 'cancelled')) throw new TypeError('Invalid cancellation intent')
    if (!result.accepted && (result.text !== '' || result.status === 'completed' || result.status === 'unknown')) throw new TypeError('Invalid unaccepted state')
    if (result.status === 'completed' && (result.accepted !== true || !result.text.trim())) throw new TypeError('Invalid completion')
    if (result.metadata !== undefined) {
      if (!result.accepted) throw new TypeError('Unaccepted translation cannot have call metadata')
      parseTranslationCallMetadata(result.metadata)
    }
    if (result.error !== undefined) {
      record(result.error); exact(result.error, ['code', 'message', 'stage'])
      bounded(result.error.code, 80); bounded(result.error.message, 1000)
      if (result.error.stage !== undefined) bounded(result.error.stage, 80)
    }
  }
  return structuredClone(value)
}

/** Public InvocationDescriptor contribution, mounted by Client and registered by Host. */
export const QUICK_TRANSLATION_REMOTE = {
  package: packageName,
  descriptors: methods.map(method => ({
    id: `${packageName}#translationQuick/${method}`,
    service: 'translationQuick', namespace: 'translationQuick', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'capabilities' ? [] : [{
      name: 'request', wire: 'request', source: 'json' as const,
      codec: {
        mode: 'strict' as const, typeSymbol: `${packageName}#${method}Request`,
        create: () => ({ parse: (value: unknown) => parseQuickRequest(method as 'open' | 'submit' | 'status' | 'cancel', value) }),
      },
    }],
    result: { mode: 'strict' as const, typeSymbol: `${packageName}#${method}Result`, create: () => ({ parse: (value: unknown) => parseQuickResult(method, value) }) },
  })),
}
