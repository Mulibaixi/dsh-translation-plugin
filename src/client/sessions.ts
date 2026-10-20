import { decodeDraft, decodeSettings } from './legacy-state.js'
import { MAX_TRANSLATION_SOURCE_BYTES } from '../shared/translation-sources.js'

export type Mode = 'normal' | 'quick'
export interface SessionSettings {
  readonly schemaVersion: 2
  readonly defaultMode: Mode
  readonly targetLanguage: string
  readonly defaultInstruction: string
  readonly maxInputChars: number
  readonly rememberHistory: boolean
}
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}
export interface LocalSession {
  readonly schemaVersion: 4
  readonly id: string
  readonly topicId: string
  readonly sequenceNamespaceId: string
  readonly topicName: string
  readonly sequence: number
  readonly name: string
  readonly remark: string
  readonly legacyName: string | null
  readonly parentId: string | null
  readonly childSequence: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly archivedAt: string | null
  readonly mode: Mode
  readonly targetLanguage: string
  readonly instruction: string
  readonly maxInputChars: number
  readonly model: ModelRoute | null
  readonly input: string
  readonly legacyManualText: string
  readonly legacyKey: string | null
}
export const DEFAULT_SESSION_SETTINGS: SessionSettings = Object.freeze({
  schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文',
  defaultInstruction: '', maxInputChars: 20000, rememberHistory: false,
})
export const SETTINGS_KEY = 'dsh-translation-plugin:settings:v2'
export const HISTORY_PREFIX = 'dsh-translation-plugin:history:v2:'
export const LEGACY_SETTINGS_KEY = 'dsh-translation-plugin:settings:v1'
export const LEGACY_DRAFT_PREFIX = 'dsh-translation-plugin:draft:v1:'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown, max: number, required = false): value is string {
  if (typeof value !== 'string' || (required && !value.trim())) return false
  let count = 0
  for (const _ of value) if (++count > max) return false
  return true
}
function mode(value: unknown): value is Mode { return value === 'normal' || value === 'quick' }
function limit(value: unknown): value is number { return Number.isInteger(value) && typeof value === 'number' && value >= 1 && value <= 200000 }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function validateSessionSettings(value: unknown): readonly string[] {
  if (!record(value)) return ['设置格式无效。']
  const errors: string[] = []
  if (!exact(value, ['schemaVersion', 'defaultMode', 'targetLanguage', 'defaultInstruction', 'maxInputChars', 'rememberHistory']) || value.schemaVersion !== 2) errors.push('设置版本或字段无效。')
  if (!mode(value.defaultMode)) errors.push('翻译模式无效。')
  if (!text(value.targetLanguage, 80, true)) errors.push('目标语言不能为空，且最多 80 个字符。')
  if (!text(value.defaultInstruction, 4000)) errors.push('翻译要求最多 4000 个字符。')
  if (!limit(value.maxInputChars)) errors.push('单次上限须为 1–200000 的整数。')
  if (typeof value.rememberHistory !== 'boolean') errors.push('会话历史保存选项无效。')
  return errors
}

export function parseSettings(raw: string | null, legacyRaw: string | null = null): SessionSettings | undefined {
  if (raw !== null) {
    try {
      const value: unknown = JSON.parse(raw)
      return validateSessionSettings(value).length ? undefined : value as SessionSettings
    } catch { return undefined }
  }
  if (legacyRaw !== null) {
    try {
      const old = decodeSettings(JSON.parse(legacyRaw))
      return old ? {
        schemaVersion: 2, defaultMode: old.defaultMode, targetLanguage: old.targetLanguage,
        defaultInstruction: old.defaultInstruction, maxInputChars: old.maxInputChars, rememberHistory: false,
      } : undefined
    } catch { return undefined }
  }
  return DEFAULT_SESSION_SETTINGS
}

export function decodeRoute(value: unknown): ModelRoute | null | undefined {
  if (value === null) return null
  if (!record(value) || !text(value.provider, 300, true) || !text(value.model, 300, true)) return undefined
  if (Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) return undefined
  if (value.reasoningEffort !== undefined && !text(value.reasoningEffort, 200, true)) return undefined
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }
}

export function decodeSession(value: unknown): LocalSession | undefined {
  const keys = ['schemaVersion', 'id', 'name', 'parentId', 'childSequence', 'createdAt', 'updatedAt', 'mode', 'targetLanguage', 'instruction', 'maxInputChars', 'model', 'input', 'legacyManualText', 'legacyKey']
  if (!record(value) || ![2, 3, 4].includes(value.schemaVersion as number)) return undefined
  const base = value.schemaVersion === 4 ? keys : [...keys, 'ownerId']
  const expected = value.schemaVersion !== 2 ? [...base, 'archivedAt', 'topicId', 'sequenceNamespaceId', 'topicName', 'sequence', 'remark', 'legacyName'] : Object.hasOwn(value, 'archivedAt') ? [...base, 'archivedAt'] : base
  if (!exact(value, expected)) return undefined
  if (!text(value.id, 2048, true) || (value.schemaVersion !== 4 && !text(value.ownerId, 1000, true)) || !text(value.name, value.schemaVersion !== 2 ? 150 : 120, true)) return undefined
  if (!(value.parentId === null || text(value.parentId, 2048, true)) || !Number.isSafeInteger(value.childSequence) || (value.childSequence as number) < 0) return undefined
  if (!text(value.createdAt, 40, true) || !Number.isFinite(Date.parse(value.createdAt)) || !text(value.updatedAt, 40, true) || !Number.isFinite(Date.parse(value.updatedAt))) return undefined
  if (!(value.archivedAt === undefined || value.archivedAt === null || (text(value.archivedAt, 40, true) && Number.isFinite(Date.parse(value.archivedAt))))) return undefined
  if (!mode(value.mode) || !text(value.targetLanguage, 80) || !text(value.instruction, 4000) || !limit(value.maxInputChars)) return undefined
  const route = decodeRoute(value.model)
  if (route === undefined || !text(value.input, value.mode === 'normal' ? MAX_TRANSLATION_SOURCE_BYTES : 200000) || !text(value.legacyManualText, 200000)) return undefined
  if (!(value.legacyKey === null || (text(value.legacyKey, 2000) && value.legacyKey.startsWith(LEGACY_DRAFT_PREFIX)))) return undefined
  const { ownerId: _legacyOwner, ...content } = value
  if (value.schemaVersion !== 2) {
    if (!text(value.topicId, 3000, true) || !text(value.sequenceNamespaceId, 3000, true) || !text(value.topicName, 120, true) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || (value.sequence as number) >= Number.MAX_SAFE_INTEGER || !text(value.remark, 1000) || !(value.legacyName === null || text(value.legacyName, 120, true))) return undefined
    if (value.name !== sessionName(value.topicName, value.sequence as number)) return undefined
    return { ...content, schemaVersion: 4, model: route } as unknown as LocalSession
  }
  // ID 及父边的归并由 SessionStore 在读完全部记录后完成，不依据旧名称。
  return {
    ...content, schemaVersion: 4, archivedAt: value.archivedAt ?? null, model: route,
    topicId: `legacy-pending:${value.id}`, sequenceNamespaceId: `legacy-pending:${value.id}`,
    topicName: value.name, sequence: 0, remark: '', legacyName: value.name,
  } as unknown as LocalSession
}

export function sessionName(topicName: string, sequence: number): string { return sequence === 0 ? topicName : `${topicName}-${String(sequence).padStart(2, '0')}` }

export function newSession(settings: SessionSettings, _entryId: string, id: string, name = '新翻译会话', parentId: string | null = null, topicId = `topic:${id}`, sequenceNamespaceId = `sequence:${id}`, sequence = 0): LocalSession {
  const time = new Date().toISOString()
  return {
    schemaVersion: 4, id, topicId, sequenceNamespaceId, topicName: name, sequence, name: sessionName(name, sequence), remark: '', legacyName: null,
    parentId, childSequence: 0, createdAt: time, updatedAt: time, archivedAt: null,
    mode: settings.defaultMode, targetLanguage: settings.targetLanguage, instruction: settings.defaultInstruction,
    maxInputChars: settings.maxInputChars, model: null, input: '', legacyManualText: '', legacyKey: null,
  }
}

export function historyKey(id: string): string { return `${HISTORY_PREFIX}${encodeURIComponent(id)}` }

export function legacySession(key: string, raw: string): LocalSession | undefined {
  if (!key.startsWith(LEGACY_DRAFT_PREFIX)) return undefined
  try {
    const rest = key.slice(LEGACY_DRAFT_PREFIX.length)
    const split = rest.lastIndexOf(':')
    const ownerId = decodeURIComponent(rest.slice(0, split))
    const envelope: unknown = JSON.parse(raw)
    if (!record(envelope) || envelope.schemaVersion !== 1 || typeof envelope.token !== 'string') return undefined
    const draft = decodeDraft(envelope.draft)
    if (!draft || draft.mode !== rest.slice(split + 1) || !ownerId.trim()) return undefined
    return {
      ...newSession(DEFAULT_SESSION_SETTINGS, ownerId, `legacy:${key}`, draft.mode === 'quick' ? '旧版快译会话' : '旧版翻译会话'),
      topicId: `legacy-pending:legacy:${key}`, sequenceNamespaceId: `legacy-pending:legacy:${key}`,
      legacyName: draft.mode === 'quick' ? '旧版快译会话' : '旧版翻译会话',
      mode: draft.mode, targetLanguage: draft.targetLanguage, instruction: draft.instruction, input: draft.sourceText,
      model: draft.providerId && draft.modelId ? { provider: draft.providerId, model: draft.modelId } : null,
      legacyManualText: draft.manualTranslation, legacyKey: key,
    }
  } catch { return undefined }
}
