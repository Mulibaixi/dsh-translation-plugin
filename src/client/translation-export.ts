import type { LocalSession } from './sessions.js'
import type { TextRevisionStatus, TranslationHistory } from './translation-history.js'
import { QUICK_SYSTEM_PROMPT, TRANSLATION_PROMPT_VERSION } from '../shared/translation-call.js'

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

function finalSummary(history: TranslationHistory): { texts: string[]; missingUnits: MissingTextUnit[]; exportedUnitIds: string[] } {
  const texts: string[] = [], missingUnits: MissingTextUnit[] = [], exportedUnitIds: string[] = []
  for (const unit of history.units) {
    const revision = unit.revisions.find(revision => revision.id === unit.final?.revisionId)
    if (revision?.accepted && revision.status === 'completed' && revision.text.trim()) {
      texts.push(revision.text); exportedUnitIds.push(unit.id)
    } else missingUnits.push({ unitId: unit.id, order: unit.order, latestStatus: unit.revisions.at(-1)?.status ?? null })
  }
  return { texts, missingUnits, exportedUnitIds }
}
function fileBase(session: LocalSession, exportedAt: string): string {
  const name = session.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'translation'
  const stamp = exportedAt.replace(/[^0-9TZ]/g, '')
  return `${name}-${stamp}`
}

/** Pure projection: final pointers are the sole source; missing units never fall back. */
export function buildFinalTextExport(session: LocalSession, history: TranslationHistory, exportedAt: string, options: { readonly allowPartial?: boolean } = {}): TranslationExport {
  const { texts, missingUnits, exportedUnitIds } = finalSummary(history), complete = missingUnits.length === 0
  return { content: texts.length && (complete || options.allowPartial) ? texts.join('\n\n') : null,
    fileName: `${fileBase(session, exportedAt)}${complete ? '' : '-partial'}.txt`, mimeType: 'text/plain;charset=utf-8', complete, missingUnits, exportedUnitIds }
}

/** Browser facts and safe call fields, not Host capabilities or full provider configuration. */
export function buildFullRecordExport(session: LocalSession, history: TranslationHistory, exportedAt: string): TranslationExport {
  const { missingUnits, exportedUnitIds } = finalSummary(history), complete = missingUnits.length === 0
  const hasKnownPrompt = history.units.some(unit => unit.revisions.some(revision => revision.callRecord?.promptVersion === TRANSLATION_PROMPT_VERSION))
  const promptDefinitions = hasKnownPrompt ? [{ promptVersion: TRANSLATION_PROMPT_VERSION, systemPrompt: QUICK_SYSTEM_PROMPT,
    userMessageFields: { target_language: 'unit.targetLanguage', translation_requirements: 'unit.instruction', source_text: 'unit.source' } }] : []
  const content = JSON.stringify({ format: 'dsh-translation-session', schemaVersion: 1, exportedAt, session, history,
    summary: { complete, missingUnits, exportedUnitIds }, promptDefinitions }, null, 2)
  return { content, fileName: `${fileBase(session, exportedAt)}-records.json`, mimeType: 'application/json;charset=utf-8', complete, missingUnits, exportedUnitIds }
}
