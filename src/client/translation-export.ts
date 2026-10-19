import type { LocalSession } from './sessions.js'
import { persistedTranslationHistory, currentDocumentCandidateRevision, currentDocumentFinalRevision, currentFinalRevision, isTextUnit, type TextRevisionStatus, type TranslationHistory } from './translation-history.js'
import { QUICK_SYSTEM_PROMPT, TRANSLATION_PROMPT_VERSION, NORMAL_SYSTEM_PROMPT, NORMAL_TRANSLATION_PROMPT_VERSION, LEGACY_NORMAL_SYSTEM_PROMPT } from '../shared/translation-call.js'
import type { RecordObjectReference } from '../shared/record-objects.js'
import type { DocumentRevision, DocumentSourceVersion } from '../shared/translation-batch.js'
import type { EvidenceUnavailableResult } from '../shared/translation-evidence.js'
import { projectRecordObjects } from './record-object-projection.js'
import { recordObjectLabel } from './record-object-projection.js'
import { sourceCodePointLength } from '../shared/translation-source-read.js'
import { projectDocument, type DocumentMissingRange } from './document-export.js'
import type { DocumentReadSnapshot, TranslationDocumentReader } from './source-reader.js'

export interface MissingTextUnit {
  readonly unitId: string
  readonly order: number
  readonly latestStatus: TextRevisionStatus | null
  readonly reason?: string
}
export interface TranslationExport {
  readonly content: string | null
  readonly fileName: string
  readonly mimeType: string
  readonly complete: boolean
  readonly missingUnits: readonly MissingTextUnit[]
  readonly exportedUnitIds: readonly string[]
  readonly missingRanges?: readonly MissingTranslationRange[]
}
export interface MissingTranslationRange extends DocumentMissingRange {
  readonly sessionId: string; readonly sessionName: string; readonly sessionSequence: number
  readonly unitId: string; readonly order: number; readonly sourceVersion: number
}
export interface TranslationExportTopic {
  readonly ownerId: string
  readonly topicId: string
  readonly topicName: string
}
export interface TranslationExportSession {
  readonly session: LocalSession
  readonly history: TranslationHistory
}
export interface MissingTopicTextUnit extends MissingTextUnit {
  readonly sessionId: string
  readonly sessionName: string
  readonly sessionSequence: number
}
export interface TopicTranslationExport extends TranslationExport {
  readonly missingUnits: readonly MissingTopicTextUnit[]
}
export interface FinalExportOptions { readonly allowPartial?: boolean }
export interface FileJobExportUnit {
  readonly sessionId: string; readonly topicId: string; readonly unitId: string; readonly createdAt: string; readonly sourceVersion: number
  readonly targetLanguage: string; readonly source: string | null; readonly translation: string | null; readonly resultVersion: number | null
  readonly selection: 'automatic' | 'user_fixed' | null
}
export interface TranslationExportRequest {
  readonly topic: TranslationExportTopic
  readonly entries: readonly TranslationExportSession[]
  readonly scope: 'session' | 'topic'
  readonly format: 'txt' | 'json'
  readonly exportedAt: string
  readonly references?: readonly RecordObjectReference[]
  readonly fileJobs?: readonly FileJobExportUnit[] | undefined
}
export interface AsyncTranslationExport extends TopicTranslationExport {
  readonly missingRanges: readonly MissingTranslationRange[]
}
const partialExports = new WeakMap<TranslationExport, { readonly content: string | null; readonly check: () => boolean }>()
/** Partial confirmation uses the already fixed projection and rechecks its authorization without fetching it again. */
export function allowPartialTranslationExport<T extends TranslationExport>(result: T): T {
  const prepared = partialExports.get(result)
  if (!prepared) throw new Error('部分导出没有固定的读取结果，请重新导出。')
  if (!prepared.check()) throw new Error('原导出范围已不可读取，请重新导出。')
  const partial = { ...result, content: prepared.content }
  partialExports.set(partial, prepared)
  return partial
}

interface BilingualTextUnit {
  readonly unitId: string
  readonly order: number
  readonly source: string
  readonly targetLanguage: string
  readonly status: 'final' | 'missing'
  readonly translation: string | null
}
interface UnsupportedDocumentUnit {
  readonly kind: 'document'; readonly unitId: string; readonly order: number; readonly sourceVersion: number
  readonly targetLanguage: string; readonly status: 'unsupported'; readonly reason: 'document_not_supported'
}

function finalSummary(history: TranslationHistory): { texts: string[]; units: (BilingualTextUnit | UnsupportedDocumentUnit)[]; missingUnits: MissingTextUnit[]; exportedUnitIds: string[] } {
  const texts: string[] = [], units: (BilingualTextUnit | UnsupportedDocumentUnit)[] = [], missingUnits: MissingTextUnit[] = [], exportedUnitIds: string[] = []
  for (const unit of [...history.units].sort((a, b) => a.order - b.order)) {
    if (!isTextUnit(unit)) {
      if (unit.deletion) { missingUnits.push({ unitId: unit.id, order: unit.order, latestStatus: null, reason: 'unit_deleted' }); continue }
      units.push({ kind: 'document', unitId: unit.id, order: unit.order, sourceVersion: unit.sourceVersion,
        targetLanguage: unit.targetLanguage, status: 'unsupported', reason: 'document_not_supported' })
      missingUnits.push({ unitId: unit.id, order: unit.order, latestStatus: null, reason: 'document_not_supported' })
      continue
    }
    const revision = currentFinalRevision(unit)
    const translation = revision?.text ?? null
    units.push({ unitId: unit.id, order: unit.order, source: unit.source, targetLanguage: unit.targetLanguage,
      status: translation === null ? 'missing' : 'final', translation })
    if (translation !== null) {
      texts.push(translation); exportedUnitIds.push(unit.id)
    } else missingUnits.push({ unitId: unit.id, order: unit.order, latestStatus: unit.revisions.at(-1)?.status ?? null,
      ...(unit.deletion ? { reason: 'unit_deleted' } : {}) })
  }
  return { texts, units, missingUnits, exportedUnitIds }
}
function namedFileBase(rawName: string, exportedAt: string): string {
  const name = rawName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'translation'
  const stamp = exportedAt.replace(/[^0-9TZ]/g, '')
  return `${name}-${stamp}`
}
function fileBase(session: LocalSession, exportedAt: string): string { return namedFileBase(session.name, exportedAt) }
function topicOf(session: LocalSession): TranslationExportTopic { return { ownerId: session.ownerId, topicId: session.topicId, topicName: session.topicName } }

/** Check the frozen identities before combining content; names never decide scope. */
function scopedSessions(topic: TranslationExportTopic, entries: readonly TranslationExportSession[]): TranslationExportSession[] {
  const ids = new Set<string>()
  for (const { session } of entries) {
    if (session.topicId !== topic.topicId) throw new Error('Translation export session is outside the topic scope')
    if (ids.has(session.id)) throw new Error('Duplicate translation export session')
    ids.add(session.id)
  }
  return [...entries].sort((a, b) => a.session.sequence - b.session.sequence || (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0))
}
function topicSummary(topic: TranslationExportTopic, entries: readonly TranslationExportSession[]) {
  const sessions = scopedSessions(topic, entries).map(({ session, history }) => ({ session, ...finalSummary(history) }))
  const missingUnits: MissingTopicTextUnit[] = sessions.flatMap(({ session, missingUnits }) => missingUnits.map(unit => ({ ...unit,
    sessionId: session.id, sessionName: session.name, sessionSequence: session.sequence })))
  const exportedUnitIds = sessions.flatMap(session => session.exportedUnitIds)
  return { sessions, missingUnits, exportedUnitIds, complete: missingUnits.length === 0 }
}

/** Pure projection: final pointers are the sole source; missing units never fall back. */
export function buildFinalTextExport(session: LocalSession, history: TranslationHistory, exportedAt: string, options: FinalExportOptions = {}): TranslationExport {
  const { texts, missingUnits, exportedUnitIds } = finalSummary(history), complete = missingUnits.length === 0
  return { content: texts.length && (complete || options.allowPartial) ? texts.join('\n\n') : null,
    fileName: `${fileBase(session, exportedAt)}${complete ? '' : '-partial'}.txt`, mimeType: 'text/plain;charset=utf-8', complete, missingUnits, exportedUnitIds }
}

/** Topic TXT contains final text only, in fixed session and text-unit order. */
export function buildTopicFinalTextExport(topic: TranslationExportTopic, entries: readonly TranslationExportSession[], exportedAt: string, options: FinalExportOptions = {}): TopicTranslationExport {
  const { sessions, missingUnits, exportedUnitIds, complete } = topicSummary(topic, entries)
  const texts = sessions.flatMap(session => session.texts)
  return { content: texts.length && (complete || options.allowPartial) ? texts.join('\n\n') : null,
    fileName: `${namedFileBase(topic.topicName, exportedAt)}-topic${complete ? '' : '-partial'}.txt`,
    mimeType: 'text/plain;charset=utf-8', complete, missingUnits, exportedUnitIds }
}

function bilingualExport(topic: TranslationExportTopic, entries: readonly TranslationExportSession[], scope: 'session' | 'topic', exportedAt: string, options: FinalExportOptions): TopicTranslationExport {
  const { sessions, missingUnits, exportedUnitIds, complete } = topicSummary(topic, entries)
  const content = exportedUnitIds.length && (complete || options.allowPartial) ? JSON.stringify({
    format: 'dsh-translation-bilingual', schemaVersion: 1, exportedAt, scope,
    topic: { ownerId: topic.ownerId, topicId: topic.topicId, topicName: topic.topicName },
    sessions: sessions.map(({ session, units }) => ({ id: session.id, ownerId: session.ownerId, name: session.name, remark: session.remark, sequence: session.sequence, units })),
    summary: { complete, missingUnits, exportedUnitIds },
  }, null, 2) : null
  const name = scope === 'session' ? sessions[0]!.session.name : topic.topicName
  return { content, fileName: `${namedFileBase(name, exportedAt)}${scope === 'topic' ? '-topic' : ''}-bilingual${complete ? '' : '-partial'}.json`,
    mimeType: 'application/json;charset=utf-8', complete, missingUnits, exportedUnitIds }
}

/** Source/final pairs only: no drafts, revision history, execution metadata or prompts. */
export function buildBilingualExport(session: LocalSession, history: TranslationHistory, exportedAt: string, options: FinalExportOptions = {}): TopicTranslationExport {
  return bilingualExport(topicOf(session), [{ session, history }], 'session', exportedAt, options)
}

/** Missing final entries stay explicit after the user permits a partial export. */
export function buildTopicBilingualExport(topic: TranslationExportTopic, entries: readonly TranslationExportSession[], exportedAt: string, options: FinalExportOptions = {}): TopicTranslationExport {
  return bilingualExport(topic, entries, 'topic', exportedAt, options)
}

/** Browser facts and safe call fields, not Host capabilities or full provider configuration. */
export function buildFullRecordExport(session: LocalSession, history: TranslationHistory, exportedAt: string): TranslationExport {
  const { missingUnits, exportedUnitIds } = finalSummary(history), complete = missingUnits.length === 0
  const hasKnownPrompt = history.units.some(unit => isTextUnit(unit) && unit.revisions.some(revision => revision.callRecord?.promptVersion === TRANSLATION_PROMPT_VERSION))
  const normalVersions = ['normal-text-v1', NORMAL_TRANSLATION_PROMPT_VERSION].filter(version => history.units.some(unit => isTextUnit(unit) && unit.revisions.some(revision => revision.callRecord?.promptVersion === version)))
  const promptDefinitions = [...(hasKnownPrompt ? [{ promptVersion: TRANSLATION_PROMPT_VERSION, systemPrompt: QUICK_SYSTEM_PROMPT,
    userMessageFields: { target_language: 'unit.targetLanguage', translation_requirements: 'unit.instruction', source_text: 'unit.sourceVersions[revision.sourceVersion-1].text' } }] : []),
    ...normalVersions.map(promptVersion => ({ promptVersion, systemPrompt: promptVersion === 'normal-text-v1' ? LEGACY_NORMAL_SYSTEM_PROMPT : NORMAL_SYSTEM_PROMPT, userMessageFields: {
      target_language: 'unit.targetLanguage', translation_requirements: 'unit.instruction', source_text: 'unit.sourceVersions[revision.sourceVersion-1].text',
      main_model_requirements: 'revision.callRecord.context.organizedRequirements', terminology: 'revision.callRecord.context.terms',
    } }))]
  const content = JSON.stringify({ format: 'dsh-translation-session', schemaVersion: 1, exportedAt, session, history: persistedTranslationHistory(history),
    summary: { complete, missingUnits, exportedUnitIds }, promptDefinitions }, null, 2)
  return { content, fileName: `${fileBase(session, exportedAt)}-records.json`, mimeType: 'application/json;charset=utf-8', complete, missingUnits, exportedUnitIds }
}

interface FrozenTextExportUnit extends BilingualTextUnit {
  readonly kind: 'text'
  readonly finalRevisionId: string | null
  readonly latestStatus: TextRevisionStatus | null
}
interface FrozenDocumentExportUnit {
  readonly kind: 'document'; readonly unitId: string; readonly order: number; readonly targetLanguage: string
  readonly sourceVersion: number; readonly source: DocumentSourceVersion | null; readonly finalRevisionId: string | null
  readonly manifest: DocumentRevision | null; readonly snapshot: DocumentReadSnapshot | EvidenceUnavailableResult
}
interface FrozenFileJobExportUnit extends FileJobExportUnit { readonly kind: 'file_job'; readonly order: number }
function objectText(text: string, session: LocalSession, unitId: string, revisionId: string, references: readonly RecordObjectReference[]): string {
  return projectRecordObjects(text, { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId,
    side: 'revision', revisionId }, references).segments.map(segment => segment.kind === 'text' ? segment.text : `[${segment.label}]`).join('')
}

/** Capture every scope and immutable document identity before the first asynchronous page read. */
export async function buildTranslationExportAsync(request: TranslationExportRequest, reader: TranslationDocumentReader | undefined, options: FinalExportOptions = {}): Promise<AsyncTranslationExport> {
  const topic = { ...request.topic }, scope = request.scope, format = request.format, exportedAt = request.exportedAt
  if (scope === 'session' && request.entries.length !== 1) throw new Error('Session translation export requires one session')
  const references = structuredClone(request.references ?? [])
  const sessions = scopedSessions(topic, request.entries).map(({ session, history }) => ({ session: { ...session }, units: [...history.units].filter(unit => !request.fileJobs?.some(job => job.sessionId === session.id && job.unitId === unit.id)).sort((a, b) => a.order - b.order).map((unit): FrozenTextExportUnit | FrozenDocumentExportUnit | FrozenFileJobExportUnit => {
    if (isTextUnit(unit)) {
      const final = currentFinalRevision(unit)
      return { kind: 'text', unitId: unit.id, order: unit.order, source: unit.source, targetLanguage: unit.targetLanguage,
        status: final ? 'final' : 'missing', translation: final?.text ?? null, finalRevisionId: final?.id ?? null, latestStatus: unit.revisions.at(-1)?.status ?? null }
    }
    const final = currentDocumentFinalRevision(unit)
    const manifest = final ?? currentDocumentCandidateRevision(unit) ?? null
    const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id,
      sourceVersion: unit.sourceVersion, manifestRevisionId: manifest?.id ?? null }
    const captured = reader?.captureDocument(target) ?? { status: 'unloaded' as const, request: null, reason: 'document_reader_unavailable' }
    const snapshot = 'status' in captured ? captured : { ...captured, finalRevisionId: final?.id ?? null }
    return { kind: 'document', unitId: unit.id, order: unit.order, targetLanguage: unit.targetLanguage,
      sourceVersion: unit.sourceVersion, source: unit.sourceVersions.find(source => source.version === unit.sourceVersion) ?? null,
      finalRevisionId: final?.id ?? null, manifest, snapshot }
  }).concat((request.fileJobs ?? []).filter(job => job.sessionId === session.id && job.topicId === topic.topicId).map((job, index) => ({ ...job, kind: 'file_job' as const, order: history.units.length + index + 1 })))
    .sort((left, right) => Date.parse(left.kind === 'file_job' ? left.createdAt : history.units.find(unit => unit.id === left.unitId)!.createdAt) - Date.parse(right.kind === 'file_job' ? right.createdAt : history.units.find(unit => unit.id === right.unitId)!.createdAt))
    .map((unit, index) => ({ ...unit, order: index + 1 })) }))
  const missingUnits: MissingTopicTextUnit[] = [], missingRanges: MissingTranslationRange[] = [], exportedUnitIds: string[] = [], texts: string[] = []
  const exportedSessions: { id: string; ownerId: string; name: string; remark: string; sequence: number; units: unknown[] }[] = []
  const hasDocument = sessions.some(entry => entry.units.some(unit => unit.kind === 'document'))
  for (const { session, units } of sessions) {
    const exportedUnits: unknown[] = []
    for (const unit of units) {
      const location = { sessionId: session.id, sessionName: session.name, sessionSequence: session.sequence, unitId: unit.unitId, order: unit.order }
      if (unit.kind === 'file_job') {
        const ready = unit.translation !== null && unit.source !== null && unit.resultVersion !== null
        exportedUnits.push({ kind: 'file_job', unitId: unit.unitId, order: unit.order, sourceVersion: unit.sourceVersion, targetLanguage: unit.targetLanguage,
          source: unit.source, translation: unit.translation, resultVersion: unit.resultVersion, selection: unit.selection, status: ready ? 'final' : 'missing' })
        if (ready) { exportedUnitIds.push(unit.unitId); texts.push(unit.translation!) }
        else { missingUnits.push({ ...location, latestStatus: null, reason: 'file_job_not_final' }); texts.push(`\n[缺失：${session.name} · 文件 ${unit.order}尚无最终译文]\n`) }
        continue
      }
      if (unit.kind === 'text') {
        const { kind: _kind, finalRevisionId: _finalRevisionId, latestStatus: _latestStatus, ...bilingual } = unit
        exportedUnits.push(bilingual)
        if (unit.translation !== null && unit.finalRevisionId) {
          exportedUnitIds.push(unit.unitId); texts.push(objectText(unit.translation, session, unit.unitId, unit.finalRevisionId, references))
        } else { missingUnits.push({ ...location, latestStatus: unit.latestStatus }); if (hasDocument) texts.push(`\n[缺失：${session.name} · 文本 ${unit.order}尚无最终译文]\n`) }
        continue
      }
      let projection
      if ('status' in unit.snapshot) {
        const length = unit.source?.body.kind === 'asset' ? unit.source.body.reference.totalCodePoints : unit.source?.body.text ? sourceCodePointLength(unit.source.body.text) : 0
        projection = { text: null, complete: false, hasTranslation: false, blocks: [], missingRanges: [{ range: { start: 0, end: length }, chunkId: null,
          side: 'translation' as const, status: unit.snapshot.status, reason: unit.snapshot.reason }] }
      } else projection = await projectDocument(unit.snapshot, format === 'json')
      const ranges = projection.missingRanges.map(missing => ({ ...missing, ...location, sourceVersion: unit.sourceVersion }))
      missingRanges.push(...ranges)
      if (!projection.complete) missingUnits.push({ ...location, latestStatus: null, reason: 'document_incomplete' })
      if (projection.hasTranslation && projection.text !== null) {
        exportedUnitIds.push(unit.unitId)
        const refs = references.filter(ref => ref.ownerId === session.ownerId && ref.topicId === session.topicId && ref.sessionId === session.id && ref.unitId === unit.unitId && ref.side === 'revision' && ref.revisionId === unit.manifest?.id)
        texts.push(unit.manifest && projection.complete ? objectText(projection.text, session, unit.unitId, unit.manifest.id, refs)
          : projection.text + refs.map(ref => `\n[${recordObjectLabel(ref)}：关联位置不可用]`).join(''))
      }
      else texts.push(`\n[缺失：${session.name} · 文档 ${unit.order}；原文码点 ${ranges[0]?.range.start ?? 0}–${ranges[0]?.range.end ?? 0}]\n`)
      exportedUnits.push({ kind: 'document', unitId: unit.unitId, order: unit.order, sourceVersion: unit.sourceVersion,
        targetLanguage: unit.targetLanguage, status: projection.complete ? 'final' : 'partial', complete: projection.complete,
        source: unit.source?.body.kind === 'asset' ? { kind: 'asset', reference: unit.source.body.reference } : { kind: 'inline' },
        finalRevisionId: unit.finalRevisionId, manifestRevisionId: unit.manifest?.id ?? null, manifest: unit.manifest,
        blocks: projection.blocks, missingRanges: ranges })
    }
    exportedSessions.push({ id: session.id, ownerId: session.ownerId, name: session.name, remark: session.remark, sequence: session.sequence, units: exportedUnits })
  }
  const complete = missingUnits.length === 0
  const check = (): boolean => sessions.every(entry => entry.units.every(unit => unit.kind !== 'document' || 'status' in unit.snapshot || unit.snapshot.check() === null))
  if (!check()) throw new Error('导出范围在读取期间已不可访问，请重新导出。')
  const includedObjects = references.filter(ref => sessions.some(({ session, units }) => session.ownerId === ref.ownerId && session.topicId === ref.topicId && session.id === ref.sessionId && units.some(unit => unit.unitId === ref.unitId && (ref.side === 'source' ? ref.revisionId === null : (unit.kind === 'text' ? unit.finalRevisionId : unit.kind === 'document' ? unit.manifest?.id : null) === ref.revisionId))))
  const partialContent = exportedUnitIds.length ? format === 'txt' ? texts.join('\n\n') : JSON.stringify({
    format: 'dsh-translation-bilingual', schemaVersion: sessions.some(entry => entry.units.some(unit => unit.kind === 'file_job')) ? 4 : hasDocument ? 3 : includedObjects.length ? 2 : 1, exportedAt, scope,
    topic, sessions: exportedSessions, summary: { complete, missingUnits, exportedUnitIds, ...(hasDocument ? { missingRanges } : {}) },
    ...(includedObjects.length ? { objectReferences: includedObjects } : {}),
  }, null, 2) : null
  const name = scope === 'session' ? sessions[0]!.session.name : topic.topicName
  const result: AsyncTranslationExport = { content: complete || options.allowPartial ? partialContent : null, fileName: `${namedFileBase(name, exportedAt)}${scope === 'topic' ? '-topic' : ''}${format === 'json' ? '-bilingual' : ''}${complete ? '' : '-partial'}.${format}`,
    mimeType: format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8', complete, missingUnits, missingRanges, exportedUnitIds }
  partialExports.set(result, { content: partialContent, check })
  return result
}
