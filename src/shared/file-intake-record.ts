import { parseTranslationSourceScope, parseSourceIdentity, type SourceIdentity, type TranslationSourceScope } from './translation-sources.js'
import { parseTranslationSourceReference } from './translation-source-storage.js'
import type { DocumentSourceHistoryCommit as TranslationSourceHistoryCommit } from './translation-batch.js'
import type { TranslationMaterialScope } from './translation-material.js'
import { decodeRoute, type ModelRoute } from './sessions.js'
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export interface FileIntakeConfig {
  readonly targetLanguage: string
  readonly instruction: string
  readonly model: ModelRoute | null
  readonly maxInputChars: number
  readonly draftVersion: number
}
export type FileIntakeStage = 'freezing' | 'frozen' | 'failed' | 'unknown' | 'accepted' | 'removed'
/** No File, original body, or subsequent composer draft is serialized here. */
export interface FileIntakeRecord {
  readonly schemaVersion: 1
  readonly scope: TranslationSourceScope
  readonly unitId: string
  readonly materialId: string
  readonly name: string
  readonly createdAt: string
  readonly config: FileIntakeConfig
  /** The main Session that actually submits this file. It differs from `scope` when the Session was opened from another main Session. */
  readonly submission: TranslationMaterialScope
  readonly stage: FileIntakeStage
  readonly hostStarted: boolean
  readonly message?: string
  readonly source?: SourceIdentity
  readonly historyCommit?: TranslationSourceHistoryCommit
  readonly documentUnitId?: string
}
export function parseFileIntakeRecord(value: unknown): FileIntakeRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件记录格式无法读取。')
  const item = value as FileIntakeRecord, scope = parseTranslationSourceScope(item.scope), config = item.config
  if (item.schemaVersion !== 1 || typeof item.materialId !== 'string' || !item.materialId.trim() || item.unitId !== `unit:${item.materialId}` ||
    typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || !Number.isFinite(Date.parse(item.createdAt)) ||
    !['freezing', 'frozen', 'failed', 'unknown', 'accepted', 'removed'].includes(item.stage) || typeof item.hostStarted !== 'boolean' ||
    !config || typeof config.targetLanguage !== 'string' || typeof config.instruction !== 'string' || decodeRoute(config.model) === undefined ||
    !Number.isSafeInteger(config.maxInputChars) || config.maxInputChars < 1 || !Number.isSafeInteger(config.draftVersion) || config.draftVersion < 1 ||
    !item.submission || typeof item.submission.mainSessionId !== 'string' || !item.submission.mainSessionId.trim() ||
    typeof item.submission.requestId !== 'string' || !item.submission.requestId.trim() || typeof item.submission.operationId !== 'string' || !item.submission.operationId.trim() ||
    item.message !== undefined && typeof item.message !== 'string' || item.documentUnitId !== undefined && item.documentUnitId !== item.unitId) throw new Error('文件记录身份或配置无效。')
  const source = item.source ? parseSourceIdentity(item.source) : undefined
  let historyCommit: TranslationSourceHistoryCommit | undefined
  if (item.historyCommit) {
    const reference = parseTranslationSourceReference(item.historyCommit.reference)
    if (!source || !same(reference.scope, scope) || !same(reference.source, source) || reference.state !== 'prepared' ||
      typeof item.historyCommit.historyToken !== 'string' || !item.historyCommit.historyToken.trim() ||
      typeof item.historyCommit.confirmOperationId !== 'string' || !item.historyCommit.confirmOperationId.trim()) throw new Error('文件原稿保存引用无效。')
    historyCommit = { reference, historyToken: item.historyCommit.historyToken, confirmOperationId: item.historyCommit.confirmOperationId }
  }
  return { schemaVersion: 1, scope, unitId: item.unitId, materialId: item.materialId, name: item.name, createdAt: item.createdAt,
    config: { targetLanguage: config.targetLanguage, instruction: config.instruction, model: config.model, maxInputChars: config.maxInputChars, draftVersion: config.draftVersion },
    submission: {  mainSessionId: item.submission.mainSessionId, requestId: item.submission.requestId, operationId: item.submission.operationId },
    stage: item.stage, hostStarted: item.hostStarted, ...(item.message ? { message: item.message } : {}), ...(source ? { source } : {}),
    ...(historyCommit ? { historyCommit } : {}), ...(item.documentUnitId ? { documentUnitId: item.documentUnitId } : {}) }
}
