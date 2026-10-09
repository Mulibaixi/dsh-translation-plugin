import type { LocalSession } from './sessions.js'
import { persistedTranslationHistory, currentFinalRevision, type TextRevisionStatus, type TranslationHistory } from './translation-history.js'
import { QUICK_SYSTEM_PROMPT, TRANSLATION_PROMPT_VERSION, NORMAL_SYSTEM_PROMPT, NORMAL_TRANSLATION_PROMPT_VERSION } from '../shared/translation-call.js'

export interface MissingTextUnit {
  readonly unitId: string
  readonly order: number
  readonly latestStatus: TextRevisionStatus | null
}
export interface TranslationExport {
  readonly content: string | null
  readonly fileName: string
  readonly mimeType: string
  readonly complete: boolean
  readonly missingUnits: readonly MissingTextUnit[]
  readonly exportedUnitIds: readonly string[]
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

interface BilingualTextUnit {
  readonly unitId: string
  readonly order: number
  readonly source: string
  readonly targetLanguage: string
  readonly status: 'final' | 'missing'
  readonly translation: string | null
}

function finalSummary(history: TranslationHistory): { texts: string[]; units: BilingualTextUnit[]; missingUnits: MissingTextUnit[]; exportedUnitIds: string[] } {
  const texts: string[] = [], units: BilingualTextUnit[] = [], missingUnits: MissingTextUnit[] = [], exportedUnitIds: string[] = []
  for (const unit of [...history.units].sort((a, b) => a.order - b.order)) {
    const revision = currentFinalRevision(unit)
    const translation = revision?.text ?? null
    units.push({ unitId: unit.id, order: unit.order, source: unit.source, targetLanguage: unit.targetLanguage,
      status: translation === null ? 'missing' : 'final', translation })
    if (translation !== null) {
      texts.push(translation); exportedUnitIds.push(unit.id)
    } else missingUnits.push({ unitId: unit.id, order: unit.order, latestStatus: unit.revisions.at(-1)?.status ?? null })
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
    if (session.ownerId !== topic.ownerId || session.topicId !== topic.topicId) throw new Error('Translation export session is outside the topic scope')
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
    sessions: sessions.map(({ session, units }) => ({ id: session.id, name: session.name, remark: session.remark, sequence: session.sequence, units })),
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
  const hasKnownPrompt = history.units.some(unit => unit.revisions.some(revision => revision.callRecord?.promptVersion === TRANSLATION_PROMPT_VERSION))
  const hasNormalPrompt = history.units.some(unit => unit.revisions.some(revision => revision.callRecord?.promptVersion === NORMAL_TRANSLATION_PROMPT_VERSION))
  const promptDefinitions = [...(hasKnownPrompt ? [{ promptVersion: TRANSLATION_PROMPT_VERSION, systemPrompt: QUICK_SYSTEM_PROMPT,
    userMessageFields: { target_language: 'unit.targetLanguage', translation_requirements: 'unit.instruction', source_text: 'unit.sourceVersions[revision.sourceVersion-1].text' } }] : []),
    ...(hasNormalPrompt ? [{ promptVersion: NORMAL_TRANSLATION_PROMPT_VERSION, systemPrompt: NORMAL_SYSTEM_PROMPT, userMessageFields: {
      target_language: 'unit.targetLanguage', translation_requirements: 'unit.instruction', source_text: 'unit.sourceVersions[revision.sourceVersion-1].text',
      main_model_requirements: 'revision.callRecord.context.organizedRequirements', terminology: 'revision.callRecord.context.terms',
    } }] : [])]
  const content = JSON.stringify({ format: 'dsh-translation-session', schemaVersion: 1, exportedAt, session, history: persistedTranslationHistory(history),
    summary: { complete, missingUnits, exportedUnitIds }, promptDefinitions }, null, 2)
  return { content, fileName: `${fileBase(session, exportedAt)}-records.json`, mimeType: 'application/json;charset=utf-8', complete, missingUnits, exportedUnitIds }
}
