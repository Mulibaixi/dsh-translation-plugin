import { currentFileJob } from '../memory/file-job-current.js'
import { sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { EvidenceReadResult } from '../shared/translation-evidence.js'
import type { LocalSession } from './sessions.js'
import type { SessionStore } from './session-store.js'
import type { FileJobRecord } from './file-jobs-store.js'
import type { FileJobsClient } from './file-jobs-client.js'
import type { TranslationDocumentReader } from './source-reader.js'
import { currentDocumentFinalRevision, currentFinalRevision, isDeletedUnit, isDocumentUnit, isTextUnit, type TranslationUnit } from './translation-history.js'

export interface RecordSearchRead { readonly text?: string; readonly reason?: string }
export interface RecordSearchBody {
  readonly key: string; readonly sessionId: string; readonly unitId: string; readonly side: 'source' | 'translation'
  readonly version: string; readonly length: number; readonly paged: boolean
  read(range: TranslationSourceRange): Promise<RecordSearchRead>
  current(): boolean
  search?(query: string, start: number, signal: AbortSignal): Promise<import('../shared/history-remote.js').HistoryTextMatches>
}
export interface RecordSearchMatch extends TranslationSourceRange { readonly bodyKey: string }
export interface RecordSearchResult { readonly matches: readonly RecordSearchMatch[]; readonly complete: boolean }
export interface RecordSearchGroup { readonly session: LocalSession; readonly units: readonly TranslationUnit[]; readonly jobs: readonly FileJobRecord[] }

export function sliceRecordText(text: string, range: TranslationSourceRange): string {
  if (range.start === range.end) return ''
  let point = 0, start = text.length, end = text.length, offset = 0
  for (const character of text) {
    if (point === range.start) start = offset
    if (point === range.end) { end = offset; break }
    point++; offset += character.length
  }
  return text.slice(start, end)
}
/** Sequential paging keeps a small cursor; loading an earlier context interval simply seeks again. */
function textReader(text: string): RecordSearchBody['read'] {
  let point = 0, offset = 0
  return async range => {
    if (range.start < point) { point = 0; offset = 0 }
    while (point < range.start && offset < text.length) { offset += text.codePointAt(offset)! > 0xffff ? 2 : 1; point++ }
    const start = offset
    while (point < range.end && offset < text.length) { offset += text.codePointAt(offset)! > 0xffff ? 2 : 1; point++ }
    return { text: text.slice(start, offset) }
  }
}
// Folding only English letters keeps every original code point and offset intact.
const fold = (text: string): string => text.replace(/[A-Z]/g, character => character.toLowerCase())

/** Streaming literal search. Only the current body's tail is retained, never a whole-topic text copy. */
export async function searchRecordBodies(bodies: readonly RecordSearchBody[], query: string, signal: AbortSignal,
  progress?: (result: RecordSearchResult) => void, pageSize = 2000): Promise<RecordSearchResult> {
  const matches: RecordSearchMatch[] = [], needle = fold(query), queryLength = sourceCodePointLength(query)
  if (!queryLength) return { matches, complete: true }
  let complete = true, pages = 0
  const result = (finished: boolean): RecordSearchResult => {
    const current = new Set(bodies.filter(body => body.current()).map(body => body.key))
    return { matches: matches.filter(match => current.has(match.bodyKey)), complete: finished && complete && current.size === bodies.length }
  }
  for (const body of bodies) {
    let offset = 0, nextMatch = 0, tail = '', size = pageSize
    if (!body.current()) { complete = false; continue }
    // A negative length marks a body whose current content could not be captured.
    if (body.length < 0) { complete = false; continue }
    if (body.search) {
      try {
        do {
          signal.throwIfAborted(); const page = await body.search(query, offset, signal)
          if (!body.current()) { complete = false; break }
          matches.push(...page.matches.map(match => ({ ...match, bodyKey: body.key }))); progress?.(result(false))
          if (page.next === null) break
          if (page.next <= offset) throw new Error('Invalid search cursor')
          offset = page.next
        } while (true)
      } catch { complete = false }
      continue
    }
    while (offset < body.length) {
      if (signal.aborted) return { matches: [], complete: false }
      const end = Math.min(body.length, offset + size)
      let page: RecordSearchRead
      try { page = await body.read({ start: offset, end }) } catch { page = { reason: 'read_failed' } }
      if (signal.aborted) return { matches: [], complete: false }
      if (!body.current()) { complete = false; break }
      if (page.text === undefined) {
        if (page.reason === 'range_required' && size > 1) { size = Math.max(1, Math.floor(size / 2)); continue }
        complete = false; break
      }
      if (sourceCodePointLength(page.text) !== end - offset) { complete = false; break }
      const text = tail + page.text, points = Array.from(text), base = offset - sourceCodePointLength(tail), folded = fold(text)
      let from = Math.max(0, nextMatch - base), utfOffset = points.slice(0, from).join('').length
      while (true) {
        const found = folded.indexOf(needle, utfOffset)
        if (found < 0) break
        from = sourceCodePointLength(text.slice(0, found))
        const start = base + from
        matches.push({ bodyKey: body.key, start, end: start + queryLength })
        nextMatch = start + queryLength; utfOffset = found + needle.length
      }
      tail = queryLength > 1 ? points.slice(-Math.min(points.length, queryLength - 1)).join('') : ''
      offset = end
      progress?.(result(false))
      // Local text reads resolve immediately; periodically let input and cancellation events run.
      if (++pages % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }
  const final = result(true)
  if (!signal.aborted) progress?.(final)
  return signal.aborted ? { matches: [], complete: false } : final
}

function pageResult(result: EvidenceReadResult, range: TranslationSourceRange): RecordSearchRead {
  return result.status !== 'ready' ? { reason: result.reason }
    : result.range.start !== range.start || result.range.end !== range.end ? { reason: 'page_range_mismatch' } : { text: result.text }
}

/** The merged record may retain an old automatic pointer after a failed restart. */
export function effectiveFileJobSearchFinal(record: FileJobRecord, records: readonly FileJobRecord[]): FileJobRecord['results'][number] | undefined {
  return currentFileJob(records.filter(value => value.summary.translationSessionId === record.summary.translationSessionId && value.summary.unitId === record.summary.unitId), record.summary.sourceVersion)?.final
}

/** Capture the current original and effective final without invoking export/finalization or candidate fallbacks. */
export function captureRecordSearchBodies(groups: readonly RecordSearchGroup[], store: SessionStore,
  documents?: TranslationDocumentReader, fileJobs?: FileJobsClient): readonly RecordSearchBody[] {
  const bodies: RecordSearchBody[] = []
  for (const { session, jobs, units } of groups) {
    const available = (): boolean => !store.isSessionDeleted(session.id) && store.getSession(session.id)?.topicId === session.topicId
    const add = (unitId: string, side: RecordSearchBody['side'], version: string, length: number, paged: boolean,
      read: RecordSearchBody['read'], current: () => boolean): void => {
      bodies.push({ key: JSON.stringify([session.id, unitId, side, version]), sessionId: session.id, unitId, side, version, length, paged, read,
        current: () => available() && current() })
    }
    for (const record of jobs) {
      const job = record.summary, source = record.sources.find(value => value.version === job.sourceVersion)
      const current = (): FileJobRecord | undefined => fileJobs?.unitRecord(job.jobId)
      add(job.unitId, 'source', String(job.sourceVersion), source ? sourceCodePointLength(source.text) : -1, true,
        source ? textReader(source.text) : async () => ({ reason: 'source_unavailable' }),
        () => { const value = current(); return !!value && !value.summary.removedAt && value.summary.sourceVersion === job.sourceVersion && value.sources.find(value => value.version === job.sourceVersion)?.text === source?.text })
      const final = effectiveFileJobSearchFinal(record, fileJobs?.all(session.id) ?? [])
      if (final) add(job.unitId, 'translation', String(final.version), sourceCodePointLength(final.text), true,
        textReader(final.text),
        () => { const value = current(), selected = value && effectiveFileJobSearchFinal(value, fileJobs?.all(session.id) ?? []); return !!value && !value.summary.removedAt && selected?.version === final.version && selected.text === final.text })
    }
    for (const unit of units) {
      if (isDeletedUnit(unit)) continue
      const current = (): TranslationUnit | undefined => store.getTranslationHistory(session.id)?.units.find(value => value.id === unit.id)
      if (isTextUnit(unit)) {
        add(unit.id, 'source', String(unit.sourceVersion), sourceCodePointLength(unit.source), false, textReader(unit.source),
          () => { const value = current(); return !!value && isTextUnit(value) && !isDeletedUnit(value) && value.sourceVersion === unit.sourceVersion && value.source === unit.source })
        const final = currentFinalRevision(unit)
        if (final) add(unit.id, 'translation', final.id, sourceCodePointLength(final.text), false, textReader(final.text),
          () => { const value = current(), selected = value && currentFinalRevision(value); return selected?.id === final.id && selected.text === final.text })
      } else if (isDocumentUnit(unit)) {
        const final = currentDocumentFinalRevision(unit)
        const snapshot = documents?.captureDocument({ ownerId: store.getTopicStorageScope(session.topicId)!, topicId: session.topicId,
          sessionId: session.id, unitId: unit.id, sourceVersion: unit.sourceVersion, manifestRevisionId: final?.id ?? null })
        const handle = snapshot && !('status' in snapshot) ? snapshot : undefined
        const valid = (): boolean => { const value = current(); return !!value && isDocumentUnit(value) && !isDeletedUnit(value) && value.sourceVersion === unit.sourceVersion && !handle?.check() }
        add(unit.id, 'source', String(unit.sourceVersion), handle?.totalSourceCodePoints ?? -1, true,
          async range => handle ? pageResult(await handle.readSource(range), range) : { reason: 'source_unavailable' }, valid)
        if (final) {
          const chunks = (handle?.blocks ?? []).flatMap(block => block.revision ? [{ revision: block.revision, length: block.revision.content.kind === 'text'
            ? sourceCodePointLength(block.revision.content.text) : block.revision.content.range.end - block.revision.content.range.start }] : [])
          const complete = !!handle && handle.manifest?.id === final.id && chunks.length === handle.blocks.length && chunks.every(chunk => chunk.revision.status === 'completed')
          add(unit.id, 'translation', final.id, complete ? chunks.reduce((sum, chunk) => sum + chunk.length, 0) : -1, true, async range => {
            if (!handle) return { reason: 'translation_unavailable' }
            let offset = 0, text = ''
            for (const chunk of chunks) {
              const start = Math.max(range.start, offset), end = Math.min(range.end, offset + chunk.length)
              if (end > start) {
                const part = { start: start - offset, end: end - offset }, loaded = pageResult(await handle.readChunk(chunk.revision.id, part), part)
                if (loaded.text === undefined) return loaded
                text += loaded.text
              }
              offset += chunk.length
              if (offset >= range.end) break
            }
            return { text }
          }, () => { const value = current(); return valid() && !!value && currentDocumentFinalRevision(value)?.id === final.id })
        }
      }
    }
  }
  return bodies
}
