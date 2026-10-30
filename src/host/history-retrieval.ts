import { isDocumentUnit, isDeletedUnit, isTextUnit, currentFinalRevision } from '../memory/translation-history.js'
import { currentDocumentFinal } from '../memory/document-task.js'
import { parseTranslationRecordExcerpt, type TranslationRecordExcerpt, type TranslationRecordSelection } from '../shared/reference-memory.js'
import type { HistoryBundle, HistoryScope } from '../shared/history-bundle.js'
import type { TranslationSourcesService } from './translation-sources.js'
import { readCurrentHistory } from './history-current.js'
import { sourceSha256 } from './source-storage.js'
import { currentFileJob } from '../memory/file-job-current.js'

export interface CurrentHistoryPair {
  readonly sessionId: string; readonly unitId: string; readonly sourceVersion: number; readonly finalId: string; readonly targetLanguage: string
  readonly source: string; readonly translation: string
}
export const historyIndexSourceId = (sessionId: string, unitId: string, side: 'source' | 'translation' | 'bilingual'): string => `history:${JSON.stringify([sessionId, unitId, side])}`
export const historyIndexSourceIds = (sessionId: string, unitId: string): readonly string[] => (['source', 'translation', 'bilingual'] as const).map(side => historyIndexSourceId(sessionId, unitId, side))
/** File identity comes from its admitted carrier, never a filename guessed from body text. */
export function historyFileName(bundle: HistoryBundle, unitId: string): string | undefined {
  const intake = bundle.intakes.find(entry => entry.unitId === unitId)
  if (intake) return intake.name
  const job = bundle.fileJobs.find(entry => entry.summary.unitId === unitId && entry.summary.sourceRef?.name)
  if (job) return job.summary.sourceRef!.name
  const unit = bundle.history.units.find(entry => entry.id === unitId)
  if (unit && isDocumentUnit(unit)) {
    const source = unit.sourceVersions.find(entry => entry.version === unit.sourceVersion)
    if (source?.body.kind === 'asset') return source.body.reference.name
  }
  return undefined
}
export function isFileHistoryUnit(bundle: HistoryBundle, unitId: string): boolean {
  const unit = bundle.history.units.find(entry => entry.id === unitId)
  return !!unit && (!isTextUnit(unit) || bundle.intakes.some(entry => entry.unitId === unitId))
}
/** Only the effective pair participates in a call fence; streaming/new unadopted candidates do not. */
export function currentHistoryStamp(bundle: HistoryBundle | null, unitId: string): readonly unknown[] | null {
  const unit = bundle?.history.units.find(unit => unit.id === unitId)
  if (!bundle || !unit || isDeletedUnit(unit)) return null
  if (isTextUnit(unit)) {
    const final = currentFinalRevision(unit)
    return final ? [unit.sourceVersion, unit.targetLanguage, final.id, unit.sourceVersions.find(source => source.version === unit.sourceVersion)?.text, final.text] : null
  }
  if (unit.kind === 'file_job') {
    const selected = currentFileJob(bundle.fileJobs.filter(record => record.summary.unitId === unit.id), unit.sourceVersion)
    return selected?.source && selected.final ? [unit.sourceVersion, selected.targetLanguage, `file-result:${selected.final.version}`, selected.source.text, selected.final.text] : null
  }
  const final = currentDocumentFinal(unit)
  if (!final) return null
  const source = (version: number): readonly unknown[] => {
    const item = unit.sourceVersions.find(source => source.version === version)
    return [version, item?.body.kind === 'inline' ? item.body.text : JSON.stringify(item?.body), JSON.stringify(item?.historyCommit)]
  }
  const plan = unit.plans.find(plan => plan.id === final.planRef.id && plan.version === final.planRef.version)
  return [unit.sourceVersion, unit.targetLanguage, final.id, ...source(unit.sourceVersion), JSON.stringify(plan), JSON.stringify(final.entries), ...final.entries.flatMap(entry => {
    const chunk = unit.chunkRevisions.find(chunk => chunk.id === entry.revisionId)
    return chunk ? [chunk.id, chunk.status, chunk.content.kind === 'text' ? chunk.content.text : JSON.stringify(chunk.content), ...(chunk.content.kind === 'source_copy' ? source(chunk.content.sourceVersion) : [])] : [null]
  })]
}
/** Shared current-final reader: never reconstruct a pair from candidates or another source version. */
export async function currentHistoryPair(bundle: HistoryBundle, scope: HistoryScope, token: string, unitId: string, peer: string, sources: TranslationSourcesService | undefined, signal: AbortSignal): Promise<CurrentHistoryPair | null> {
  const unit = bundle.history.units.find(unit => unit.id === unitId)
  if (!unit || isDeletedUnit(unit)) return null
  const pagePoints = isDocumentUnit(unit) && unit.sourceVersions.some(source => source.body.kind === 'asset') ? 4000 : 32 * 1024 * 1024
  let finalId: string | null = null, sourceVersion = 0, targetLanguage = ''
  const read = async (side: 'source' | 'translation'): Promise<string | null> => {
    const parts: string[] = []; let start = 0, total = -1
    do {
      signal.throwIfAborted()
      const page = await readCurrentHistory(bundle, { ...scope, token, unitId, side, start }, peer, sources, signal, pagePoints)
      if (page.text === null || page.finalId === null) return null
      if (finalId === null) { finalId = page.finalId; sourceVersion = page.sourceVersion; targetLanguage = page.targetLanguage }
      if (page.finalId !== finalId || page.sourceVersion !== sourceVersion || page.targetLanguage !== targetLanguage || total !== -1 && page.totalCodePoints !== total) return null
      total = page.totalCodePoints; parts.push(page.text)
      const end = start + Array.from(page.text).length
      if (page.next === null) return end === total ? parts.join('') : null
      if (page.next !== end || end <= start) return null
      start = end
    } while (true)
  }
  const translation = await read('translation')
  if (translation === null) return null
  const source = await read('source'); signal.throwIfAborted()
  return source === null || !finalId ? null : { sessionId: scope.sessionId, unitId, sourceVersion, finalId, targetLanguage, source, translation }
}
export async function historyRecordExcerpt(pair: CurrentHistoryPair, sourceRange: TranslationRecordSelection['sourceRange'], translationRange: TranslationRecordSelection['translationRange'], points?: { readonly source: readonly string[]; readonly translation: readonly string[] }): Promise<TranslationRecordExcerpt> {
  const sourcePoints = points?.source ?? Array.from(pair.source), translationPoints = points?.translation ?? Array.from(pair.translation)
  const source = sourceRange === null ? null : sourcePoints.slice(sourceRange.start, sourceRange.end).join('')
  const translation = translationRange === null ? null : translationPoints.slice(translationRange.start, translationRange.end).join('')
  const sha256 = await sourceSha256(new TextEncoder().encode(JSON.stringify([pair.targetLanguage, source, translation])))
  return parseTranslationRecordExcerpt({ selection: { sessionId: pair.sessionId, unitId: pair.unitId, sourceVersion: pair.sourceVersion, finalId: pair.finalId, sourceRange, translationRange, sha256 }, targetLanguage: pair.targetLanguage,
    source, translation, sourceTotalCodePoints: sourcePoints.length, translationTotalCodePoints: translationPoints.length })
}
export function historyRecordText(excerpt: TranslationRecordExcerpt): string {
  return [excerpt.source === null ? null : `原文：\n${excerpt.source}`, excerpt.translation === null ? null : `译文（${excerpt.targetLanguage}）：\n${excerpt.translation}`].filter(value => value !== null).join('\n')
}
