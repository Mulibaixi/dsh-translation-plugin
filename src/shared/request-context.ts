export type RequestContextQuestionType = 'missing_context' | 'term_ambiguity' | 'requirement_conflict'

export interface RequestContextQuestion {
  readonly type: RequestContextQuestionType
  readonly range: null | { readonly start: number; readonly end: number }
  readonly question: string
  readonly reason: string
}

export interface RequestContextInput {
  readonly questions: readonly RequestContextQuestion[]
}

type Data = Record<string, unknown>
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength }

function object(value: unknown): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected object')
}

function exact(value: Data, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new TypeError('Unexpected fields')
}

function text(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || byteLength(value) > maxBytes || !wellFormed(value) || value.includes('\0')) {
    throw new TypeError('Invalid request-context text')
  }
}

function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

export function parseRequestContextInput(value: unknown, sourceCodePointLength: number): RequestContextInput {
  if (!Number.isSafeInteger(sourceCodePointLength) || sourceCodePointLength < 0) throw new TypeError('Invalid source length')
  object(value); exact(value, ['questions'])
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) throw new TypeError('Expected one to three questions')

  let textBytes = 0
  const questions = value.questions.map(item => {
    object(item); exact(item, ['type', 'range', 'question', 'reason'])
    if (!['missing_context', 'term_ambiguity', 'requirement_conflict'].includes(item.type as string)) throw new TypeError('Invalid question type')
    if (item.range !== null) {
      object(item.range); exact(item.range, ['start', 'end'])
      if (!Number.isSafeInteger(item.range.start) || !Number.isSafeInteger(item.range.end) || (item.range.start as number) < 0 ||
        (item.range.end as number) <= (item.range.start as number) || (item.range.end as number) > sourceCodePointLength) throw new TypeError('Invalid source range')
    }
    text(item.question, 8192); text(item.reason, 8192)
    textBytes += byteLength(item.question) + byteLength(item.reason)
    return { type: item.type as RequestContextQuestionType, range: item.range === null ? null : { start: item.range.start as number, end: item.range.end as number },
      question: item.question, reason: item.reason }
  })
  if (textBytes > 8192) throw new TypeError('Question text exceeds 8 KiB')
  return { questions }
}
