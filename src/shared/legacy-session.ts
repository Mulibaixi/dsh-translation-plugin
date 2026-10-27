// v1 草稿格式只用于兼容读取和迁移，不是当前设置或会话模型。
export type TranslationMode = 'normal' | 'quick'

export interface PluginSettings {
  readonly schemaVersion: 1
  readonly providerId: string
  readonly modelId: string
  readonly defaultMode: TranslationMode
  readonly targetLanguage: string
  readonly defaultInstruction: string
  readonly maxInputChars: number
  readonly rememberDrafts: boolean
}

export interface WorkspaceDraft {
  readonly schemaVersion: 1
  readonly mode: TranslationMode
  readonly sourceText: string
  readonly instruction: string
  readonly targetLanguage: string
  readonly providerId: string
  readonly modelId: string
  readonly modelSource: 'default' | 'override'
  readonly manualTranslation: string
}

export const DEFAULT_SETTINGS: PluginSettings = Object.freeze({
  schemaVersion: 1,
  providerId: '',
  modelId: '',
  defaultMode: 'quick',
  targetLanguage: '中文',
  defaultInstruction: '',
  maxInputChars: 20000,
  rememberDrafts: false,
})

const MAX_TEXT_CHARS = 200000
const SETTINGS_KEYS = [
  'schemaVersion', 'providerId', 'modelId', 'defaultMode', 'targetLanguage',
  'defaultInstruction', 'maxInputChars', 'rememberDrafts',
] as const
const DRAFT_KEYS = [
  'schemaVersion', 'mode', 'sourceText', 'instruction', 'targetLanguage',
  'providerId', 'modelId', 'modelSource', 'manualTranslation',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(input)
  return ownKeys.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(input, key))
}

function isMode(value: unknown): value is TranslationMode {
  return value === 'normal' || value === 'quick'
}

function exceedsLimit(text: string, limit: number): boolean {
  let count = 0
  for (const _character of text) {
    count += 1
    if (count > limit) return true
  }
  return false
}

function validateText(
  errors: string[],
  value: unknown,
  label: string,
  maximum: number,
  requireContent = false,
): void {
  if (typeof value !== 'string') {
    errors.push(`${label}必须是文本。`)
    return
  }
  if (requireContent && value.trim().length === 0) errors.push(`${label}不能为空。`)
  if (exceedsLimit(value, maximum)) errors.push(`${label}不能超过 ${maximum} 个字符。`)
}

export function createDraft(
  settings: PluginSettings,
  mode: TranslationMode = settings.defaultMode,
): WorkspaceDraft {
  return {
    schemaVersion: 1,
    mode,
    sourceText: '',
    instruction: settings.defaultInstruction,
    targetLanguage: settings.targetLanguage,
    providerId: settings.providerId,
    modelId: settings.modelId,
    modelSource: 'default',
    manualTranslation: '',
  }
}

export function applyDefaultModel(
  draft: WorkspaceDraft,
  settings: PluginSettings,
): WorkspaceDraft {
  return {
    ...draft,
    providerId: settings.providerId,
    modelId: settings.modelId,
    modelSource: 'default',
  }
}

export function validateSettings(input: unknown): readonly string[] {
  const errors: string[] = []
  if (!isRecord(input)) return ['插件设置格式无效。']
  if (!hasExactKeys(input, SETTINGS_KEYS)) errors.push('插件设置字段不完整或包含未知字段。')
  if (input.schemaVersion !== 1) errors.push('插件设置版本不受支持。')
  if (!isMode(input.defaultMode)) errors.push('默认模式必须是普通模式或快译模式。')
  validateText(errors, input.providerId, 'Provider ID', 200)
  validateText(errors, input.modelId, 'Model ID', 200)
  validateText(errors, input.targetLanguage, '目标语言', 80, true)
  validateText(errors, input.defaultInstruction, '默认翻译要求', 4000)
  if (!Number.isInteger(input.maxInputChars) ||
    typeof input.maxInputChars !== 'number' ||
    input.maxInputChars < 1 || input.maxInputChars > MAX_TEXT_CHARS) {
    errors.push(`输入上限必须是 1 至 ${MAX_TEXT_CHARS} 的整数。`)
  }
  if (typeof input.rememberDrafts !== 'boolean') errors.push('本地草稿保存选项必须是布尔值。')
  return errors
}

export function decodeSettings(value: unknown): PluginSettings | undefined {
  if (validateSettings(value).length > 0 || !isRecord(value)) return undefined
  return {
    schemaVersion: 1,
    providerId: value.providerId as string,
    modelId: value.modelId as string,
    defaultMode: value.defaultMode as TranslationMode,
    targetLanguage: value.targetLanguage as string,
    defaultInstruction: value.defaultInstruction as string,
    maxInputChars: value.maxInputChars as number,
    rememberDrafts: value.rememberDrafts as boolean,
  }
}

export function decodeDraft(value: unknown): WorkspaceDraft | undefined {
  if (!isRecord(value) || !hasExactKeys(value, DRAFT_KEYS)) return undefined
  if (value.schemaVersion !== 1 || !isMode(value.mode)) return undefined
  if (value.modelSource !== 'default' && value.modelSource !== 'override') return undefined
  const errors: string[] = []
  validateText(errors, value.sourceText, '原文', MAX_TEXT_CHARS)
  validateText(errors, value.manualTranslation, '人工译文草稿', MAX_TEXT_CHARS)
  validateText(errors, value.instruction, '翻译要求', 4000)
  validateText(errors, value.targetLanguage, '目标语言', 80)
  validateText(errors, value.providerId, 'Provider ID', 200)
  validateText(errors, value.modelId, 'Model ID', 200)
  if (errors.length > 0) return undefined
  return {
    schemaVersion: 1,
    mode: value.mode,
    sourceText: value.sourceText as string,
    instruction: value.instruction as string,
    targetLanguage: value.targetLanguage as string,
    providerId: value.providerId as string,
    modelId: value.modelId as string,
    modelSource: value.modelSource,
    manualTranslation: value.manualTranslation as string,
  }
}

export function validateDraft(
  draft: WorkspaceDraft,
  settings: PluginSettings,
): readonly string[] {
  const errors: string[] = []
  validateText(errors, draft.sourceText, '原文', settings.maxInputChars, true)
  validateText(errors, draft.instruction, '翻译要求', 4000)
  validateText(errors, draft.targetLanguage, '目标语言', 80, true)
  validateText(errors, draft.providerId, '独立翻译 Provider ID', 200, true)
  validateText(errors, draft.modelId, '独立翻译 Model ID', 200, true)
  return errors
}

export function draftStorageKey(sessionId: string, mode: TranslationMode): string {
  if (sessionId.trim().length === 0) throw new Error('保存草稿需要明确的会话标识。')
  if (!isMode(mode)) throw new Error('保存草稿的模式无效。')
  return `dsh-translation-plugin:draft:v1:${encodeURIComponent(sessionId)}:${mode}`
}
