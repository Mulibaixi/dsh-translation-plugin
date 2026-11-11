import { decodeSession, type LocalSession } from './sessions.js'
import { decodeTranslationHistory, emptyTranslationHistory, persistedTranslationHistory, isTextUnit, isDocumentUnit, isDeletedUnit, type TranslationHistory } from '../memory/translation-history.js'
import { parseFileJobRecord, type FileJobRecord } from './file-job-record.js'
import { parseFileIntakeRecord, type FileIntakeRecord } from './file-intake-record.js'
import { parsePreparationRecord, type StoredPreparation } from './preparation-record.js'
import { referenceExact, referenceObject } from './reference-memory.js'
import { eraseFileSource } from '../memory/file-job-deletion.js'
import { fileResultSourceVersion } from '../memory/file-job-current.js'

/** A migration boundary includes every owned audit, not only the visible translation rows. */
export interface HistoryBundle {
  readonly schemaVersion: 1; readonly session: LocalSession; readonly history: TranslationHistory
  readonly fileJobs: readonly FileJobRecord[]; readonly intakes: readonly FileIntakeRecord[]; readonly preparations: readonly StoredPreparation[]
}
export interface HistoryScope { readonly namespaceId: string; readonly topicId: string; readonly sessionId: string }
export function encodeLegacySessionSnapshot(session: LocalSession, token: string, history?: TranslationHistory): string {
  return JSON.stringify({ schemaVersion: history ? history.schemaVersion + 3 : 3, token, session,
    ...(history ? { translationHistory: persistedTranslationHistory(history) } : {}) })
}
export function readLegacySessionSnapshot(raw: string): { readonly session: LocalSession; readonly translationHistory: TranslationHistory } | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || ![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(value.schemaVersion as number) || typeof value.token !== 'string') return undefined
    const hasHistory = (value.schemaVersion as number) >= 4
    referenceExact(value, ['schemaVersion', 'token', 'session', ...(hasHistory ? ['translationHistory'] : [])])
    const historyVersion = (value.translationHistory as { schemaVersion?: unknown })?.schemaVersion
    // Development builds wrote v12 history inside the previous v14 snapshot wrapper.
    if (hasHistory && historyVersion !== (value.schemaVersion as number) - 3 && !(value.schemaVersion === 14 && historyVersion === 12)) return undefined
    const session = decodeSession(value.session), translationHistory = hasHistory ? decodeTranslationHistory(value.translationHistory) : emptyTranslationHistory()
    return session && translationHistory ? { session, translationHistory } : undefined
  } catch { return undefined }
}
export function parseHistoryBundle(raw: unknown, scope?: Pick<HistoryScope, 'topicId' | 'sessionId'> & Partial<Pick<HistoryScope, 'namespaceId'>>, layer: 'current' | 'saved' = 'current'): HistoryBundle {
  referenceObject(raw); referenceExact(raw, ['schemaVersion', 'session', 'history', 'fileJobs', 'intakes', 'preparations'])
  const session = decodeSession(raw.session), history = decodeTranslationHistory(raw.history)
  if (raw.schemaVersion !== 1 || !session || !history || !Array.isArray(raw.fileJobs) || !Array.isArray(raw.intakes) || !Array.isArray(raw.preparations) ||
    scope && (session.id !== scope.sessionId || session.topicId !== scope.topicId)) throw new TypeError('会话历史格式或范围无效。')
  const fileJobs = raw.fileJobs.map(item => parseFileJobRecord(JSON.stringify(item))), intakes = raw.intakes.map(parseFileIntakeRecord), preparations = raw.preparations.map(item => parsePreparationRecord(JSON.stringify(item), layer === 'current'))
  const own = (value: { readonly translationSessionId: string; readonly topicId: string }): boolean => value.translationSessionId === session.id && value.topicId === session.topicId
  const namespaceMatches = (value: { readonly namespaceId?: string }): boolean => scope?.namespaceId === undefined || value.namespaceId === undefined || value.namespaceId === scope.namespaceId
  if (fileJobs.some(job => !own(job.summary) || !namespaceMatches(job.summary)) || intakes.some(item => !own(item.scope) || !namespaceMatches(item.scope)) || preparations.some(item => item.versions.some(version => !own(version.scope) || !namespaceMatches(version.scope))) ||
    new Set(fileJobs.map(job => job.summary.jobId)).size !== fileJobs.length || new Set(intakes.map(item => item.materialId)).size !== intakes.length ||
    new Set(preparations.map(item => item.versions[0]!.id)).size !== preparations.length) throw new TypeError('会话从属记录重复或属于其他范围。')
  if (intakes.some(item => history.units.some(unit => unit.id === item.unitId && isDeletedUnit(unit)))) throw new TypeError('已删除单元不能恢复文件受理记录。')
  for (const job of fileJobs) {
    const unit = history.units.find(unit => unit.id === job.summary.unitId)
    if (!unit || isDeletedUnit(unit) || !('kind' in unit) || unit.kind !== 'file_job') throw new TypeError('文件正文缺少有效的所属单元。')
    for (const result of job.results) if (result.deletion && !history.events.some(event => event.unitId === unit.id && event.id === result.deletion!.eventId && event.at === result.deletion!.at && (event.type === 'file_result.deleted' && event.resultVersion === result.version || event.type === 'source.deleted' && event.sourceVersion === fileResultSourceVersion(job, result)))) throw new TypeError('文件版本删除缺少准确事件。')
    for (const source of job.sources) if (source.deletion && !history.events.some(event => event.type === 'source.deleted' && event.unitId === unit.id && event.sourceVersion === source.version && event.id === source.deletion!.eventId && event.at === source.deletion!.at)) throw new TypeError('文件原稿删除缺少准确事件。')
  }
  for (const event of history.events) if (event.type === 'source.deleted') {
    const unit = history.units.find(unit => unit.id === event.unitId)
    if (!unit || unit.deletion || !('kind' in unit) || unit.kind !== 'file_job') continue
    const records = fileJobs.filter(record => record.summary.unitId === unit.id), sources = records.flatMap(record => record.sources.filter(source => source.version === event.sourceVersion))
    if (unit.sourceVersion === event.sourceVersion || !sources.length || sources.some(source => source.deletion?.eventId !== event.id || source.deletion.at !== event.at) || records.some(record => JSON.stringify(eraseFileSource(record, event.sourceVersion!, { eventId: event.id, at: event.at })) !== JSON.stringify(record))) throw new TypeError('已删文件原稿仍含正文或从属请求。')
    if (event.sourceVersion === 1 && intakes.some(intake => intake.unitId === unit.id) || preparations.some(record => record.versions.some(version => version.sourceVersion === event.sourceVersion && (version.target.kind === 'unit' ? version.target.unitId === unit.id : `unit:${version.target.materialId}` === unit.id)))) throw new TypeError('已删文件原稿仍含受理或准备正文。')
  }
  for (const event of history.events) if (event.type === 'file_result.deleted' && !history.units.find(unit => unit.id === event.unitId)?.deletion && !fileJobs.some(job => job.summary.unitId === event.unitId && job.results.some(result => result.version === event.resultVersion && result.deletion?.eventId === event.id))) throw new TypeError('文件版本删除事件与正文身份不一致。')
  for (const unit of history.units) {
    if (isDeletedUnit(unit)) continue
    if (isDocumentUnit(unit)) {
      for (const source of unit.sourceVersions) if (source.deletion && !history.events.some(event => event.type === 'source.deleted' && event.unitId === unit.id && event.sourceVersion === source.version && event.id === source.deletion!.eventId && event.at === source.deletion!.at)) throw new TypeError('旧原稿删除缺少准确事件。')
      for (const item of [...unit.revisions, ...unit.chunkRevisions, ...unit.reviewAudits ?? []]) if (item.deletion && !history.events.some(event => event.unitId === unit.id && event.id === item.deletion!.eventId && event.at === item.deletion!.at && (event.type === 'manifest.deleted' && unit.revisions.some(revision => revision.id === event.revisionId && revision.deletion?.eventId === event.id) || event.type === 'chunks.deleted' && unit.chunkRevisions.includes(item as any) && event.chunkRevisionIds?.includes(item.id) || event.type === 'source.deleted' && event.sourceVersion === item.sourceVersion))) throw new TypeError('文档删除缺少准确事件。')
      for (const source of unit.sourceVersions.filter(source => source.deletion)) {
        const ids = new Set(unit.preparations.filter(ref => ref.sourceVersion === source.version).map(ref => ref.id))
        if (preparations.some(record => ids.has(record.versions[0]!.id) && record.prepareSignature !== '' || record.versions.some(version => version.sourceVersion === source.version && (ids.has(version.id) || version.target.kind === 'unit' && version.target.unitId === unit.id)))) throw new TypeError('已删原稿仍含从属准备或请求正文。')
      }
      if (unit.sourceVersions.some(source => source.version === 1 && source.deletion) && intakes.some(intake => intake.unitId === unit.id)) throw new TypeError('已删原稿仍含旧受理引用。')
    }
    if ('kind' in unit && unit.kind === 'file_job' && !fileJobs.some(job => job.summary.unitId === unit.id)) throw new TypeError('文件单元的从属正文尚未完整取得。')
    if (isDocumentUnit(unit)) for (const ref of unit.preparations) if (!unit.sourceVersions.find(source => source.version === ref.sourceVersion)?.deletion && !preparations.some(record => record.versions.some(version => version.id === ref.id && version.version === ref.version && version.sourceVersion === ref.sourceVersion)))
      throw new TypeError('文档引用的准备记录尚未完整取得。')
  }
  return { schemaVersion: 1, session, history, fileJobs, intakes, preparations }
}
export function encodeHistoryBundle(bundle: HistoryBundle): string { return JSON.stringify({ ...bundle, history: persistedTranslationHistory(bundle.history) }) }
export function persistableHistoryBundle(bundle: HistoryBundle): HistoryBundle {
  return { ...bundle, preparations: bundle.preparations.map(record => ({ ...record, versions: record.versions.map(version => ({ ...version, storage: 'saved', storageError: null })) })) }
}
export function historyUnsettled(bundle: HistoryBundle): boolean {
  return bundle.history.units.some(unit => isTextUnit(unit) ? unit.revisions.some(revision => ['submitting', 'running', 'unknown'].includes(revision.status))
    : isDocumentUnit(unit) && unit.tasks.some(task => ['running', 'unknown', 'paused', 'waiting_context', 'waiting_user'].includes(task.status))) ||
    bundle.history.exchanges.some(exchange => ['open', 'waiting_user', 'resuming', 'unknown'].includes(exchange.status)) ||
    bundle.fileJobs.some(record => !['completed', 'failed', 'cancelled'].includes(record.summary.phase) || record.workers.some(worker => ['queued', 'running', 'unknown'].includes(worker.status))) ||
    bundle.intakes.some(record => ['freezing', 'unknown'].includes(record.stage))
}
/** Record arrays are stored separately, preserving versions, order and final pointers. */
export interface HistoryPart { readonly kind: string; readonly parent: string; readonly id: string; readonly position: number; readonly payload: string }
const unitArrays = ['sourceVersions', 'revisions', 'preparations', 'plans', 'tasks', 'chunkRevisions', 'corrections', 'reuseApprovals', 'reviewAudits'] as const
const fileArrays = ['sources', 'results', 'proposals', 'cards', 'workers', 'constraints', 'plan', 'checks', 'contexts', 'reviews', 'revisionOperations'] as const
export function splitHistoryBundle(bundle: HistoryBundle): { readonly header: string; readonly parts: readonly HistoryPart[] } {
  const parsed = JSON.parse(encodeHistoryBundle(bundle)) as Record<string, any>, parts: HistoryPart[] = []
  const add = (kind: string, parent: string, values: any[]): void => { values.forEach((value, position) => parts.push({ kind, parent, id: JSON.stringify([value.id ?? value.candidateId ?? value.jobId ?? value.materialId ?? position, value.version ?? null]), position, payload: JSON.stringify(value) })) }
  parsed.history.units.forEach((unit: any, position: number) => {
    const header = { ...unit }
    for (const field of unitArrays) if (Array.isArray(unit[field])) { add(`unit:${field}`, unit.id, unit[field]); header[field] = [] }
    parts.push({ kind: 'unit', parent: '', id: unit.id, position, payload: JSON.stringify(header) })
  })
  add('event', '', parsed.history.events); add('exchange', '', parsed.history.exchanges)
  parsed.fileJobs.forEach((job: any, position: number) => {
    const header = { ...job }
    for (const field of fileArrays) if (Array.isArray(job[field])) { add(`file:${field}`, job.summary.jobId, job[field]); header[field] = [] }
    parts.push({ kind: 'file', parent: '', id: job.summary.jobId, position, payload: JSON.stringify(header) })
  })
  add('intake', '', parsed.intakes)
  parsed.preparations.forEach((record: any, position: number) => {
    const id = record.versions[0].id; add('preparation:versions', id, record.versions)
    parts.push({ kind: 'preparation', parent: '', id, position, payload: JSON.stringify({ ...record, versions: [] }) })
  })
  return { header: JSON.stringify({ ...parsed, history: { ...parsed.history, units: [], events: [], exchanges: [] }, fileJobs: [], intakes: [], preparations: [] }), parts }
}
export function joinHistoryBundle(header: string, parts: readonly HistoryPart[], scope: HistoryScope, layer: 'current' | 'saved' = 'saved'): HistoryBundle {
  const kinds = new Set(['unit', 'event', 'exchange', 'file', 'intake', 'preparation', 'preparation:versions', ...unitArrays.map(field => `unit:${field}`), ...fileArrays.map(field => `file:${field}`)])
  if (parts.some(part => !kinds.has(part.kind))) throw new TypeError('未知会话历史记录，未忽略原数据。')
  const bundle = JSON.parse(header), values = (kind: string, parent = ''): any[] => parts.filter(part => part.kind === kind && part.parent === parent).sort((a, b) => a.position - b.position).map(part => JSON.parse(part.payload))
  bundle.history.units = values('unit').map(unit => { for (const field of unitArrays) if (Array.isArray(unit[field])) unit[field] = values(`unit:${field}`, unit.id); return unit })
  bundle.history.events = values('event'); bundle.history.exchanges = values('exchange')
  bundle.fileJobs = values('file').map(job => { for (const field of fileArrays) if (Array.isArray(job[field])) job[field] = values(`file:${field}`, job.summary.jobId); return job })
  bundle.intakes = values('intake')
  bundle.preparations = parts.filter(part => part.kind === 'preparation').sort((a, b) => a.position - b.position).map(part => ({ ...JSON.parse(part.payload), versions: values('preparation:versions', part.id) }))
  if (parts.some(part => part.kind.startsWith('unit:') ? !bundle.history.units.some((unit: { id: string }) => unit.id === part.parent) : part.kind.startsWith('file:') ? !bundle.fileJobs.some((job: FileJobRecord) => job.summary.jobId === part.parent) : part.kind === 'preparation:versions' ? !parts.some(parent => parent.kind === 'preparation' && parent.id === part.parent) : part.parent !== '')) throw new TypeError('会话历史记录缺少所属对象，原副本保留。')
  return parseHistoryBundle(bundle, scope, layer)
}
