import { parseRequestContextInput, type RequestContextInput } from './request-context.js'

/** A new direct operation answers one completed question operation. */
export interface DirectContextResponse {
  readonly operationId: string
  readonly answerText: string
}
export interface DirectContextAnswer extends DirectContextResponse {
  readonly questions: RequestContextInput['questions']
}
/** Frozen by the Host from the parent question and included in the actual call record. */
export interface DirectContextSupplement extends DirectContextAnswer {
  readonly originalUserRequirements: string
  readonly previous?: readonly DirectContextAnswer[]
}
export const DIRECT_CONTEXT_ANSWER_BYTES = 32768

function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
    fields.some(field => !Object.hasOwn(value, field))) throw new TypeError('Invalid direct context response')
}
function text(value: unknown, maximum: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || !empty && !value.trim() || Array.from(value).length > maximum || /[\u0000\ud800-\udfff]/u.test(value)) throw new TypeError('Invalid direct context text')
}
function response(value: Record<string, unknown>): DirectContextResponse {
  text(value.operationId, 2048); text(value.answerText, DIRECT_CONTEXT_ANSWER_BYTES)
  if (new TextEncoder().encode(value.answerText).byteLength > DIRECT_CONTEXT_ANSWER_BYTES) throw new TypeError('Direct context answer exceeds 32 KiB')
  return { operationId: value.operationId, answerText: value.answerText }
}
export function parseDirectContextResponse(value: unknown): DirectContextResponse {
  object(value, ['operationId', 'answerText'])
  return response(value)
}
export function parseDirectContextAnswer(value: unknown, sourceCodePointLength = Number.MAX_SAFE_INTEGER): DirectContextAnswer {
  object(value, ['operationId', 'questions', 'answerText'])
  return { ...response(value), questions: parseRequestContextInput({ questions: value.questions }, sourceCodePointLength).questions }
}
export function parseDirectContextSupplement(value: unknown, sourceCodePointLength = Number.MAX_SAFE_INTEGER): DirectContextSupplement {
  const hasPrevious = !!value && typeof value === 'object' && Object.hasOwn(value, 'previous')
  object(value, ['operationId', 'questions', 'answerText', 'originalUserRequirements', ...(hasPrevious ? ['previous'] : [])])
  const parsed = response(value)
  text(value.originalUserRequirements, 4000, true)
  let previous: readonly DirectContextAnswer[] | undefined
  if (hasPrevious) {
    if (!Array.isArray(value.previous)) throw new TypeError('Invalid previous direct context answers')
    const operations = new Set([parsed.operationId])
    previous = value.previous.map(answer => {
      const item = parseDirectContextAnswer(answer, sourceCodePointLength)
      if (operations.has(item.operationId)) throw new TypeError('Duplicate direct context operation')
      operations.add(item.operationId); return item
    })
  }
  return { ...parsed, questions: parseRequestContextInput({ questions: value.questions }, sourceCodePointLength).questions,
    originalUserRequirements: value.originalUserRequirements, ...(previous === undefined ? {} : { previous }) }
}
