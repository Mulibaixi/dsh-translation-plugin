import { REFERENCE_PAGE_BYTES, parseReferenceFileSelection, referenceBytes, referenceString,
  type ReferenceFileSelection, type ReferenceFileExcerpt, type ReferenceScope } from '../shared/reference-memory.js'
import type { OtherMemoryReference } from '../shared/other-memory.js'
import { referenceSegmentationComplete } from '../shared/reference-segmentation.js'
import type { OtherMemoryService } from './other-memory.js'
import type { OtherMemoryFilesService } from './other-memory-files.js'

const PAGE_FILES = 20
const supportsText = (entry: OtherMemoryReference): boolean => entry.source.encoding === 'utf-8' && /\.(?:txt|text|md|markdown|csv|tsv|json|jsonl|log|rst)$/iu.test(entry.source.name)
const identity = (entry: OtherMemoryReference): string => JSON.stringify([entry.id, entry.version, entry.source])
const fold = (text: string): string => text.replace(/[A-Z]/g, letter => letter.toLowerCase())
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
function bounded<T>(value: T): T {
  if (referenceBytes(value) > REFERENCE_PAGE_BYTES) throw failure('reference_page_limit', '参考文件完整回包超过 32768 字节，请缩小范围；未截断正文。')
  return value
}
function metadata(entry: OtherMemoryReference) {
  return { id: entry.id, version: entry.version, sha256: entry.source.sha256, name: entry.source.name, category: entry.category,
    totalCodePoints: entry.source.totalCodePoints, textReadable: supportsText(entry), segmentation: { planVersion: entry.segmentation?.version ?? 0, segments: entry.segmentation?.ends.length ?? 0, complete: referenceSegmentationComplete(entry) } }
}
/** No index copy: current authoritative registrations and their immutable held originals are read together. */
export async function listReferenceFiles(memory: OtherMemoryService, scope: ReferenceScope, peer: string, after?: string) {
  if (after !== undefined) referenceString(after)
  const entries = await memory.referencesForTopic(scope, peer), candidates = entries.filter(entry => after === undefined || entry.id > after)
  const selected: ReturnType<typeof metadata>[] = []
  for (const entry of candidates.slice(0, PAGE_FILES)) {
    const next = { files: [...selected, metadata(entry)], next: entry.id }
    if (referenceBytes(next) > REFERENCE_PAGE_BYTES) break
    selected.push(metadata(entry))
  }
  if (candidates.length && !selected.length) throw failure('reference_page_limit', '单条参考文件元数据超过读取预算。')
  return bounded({ files: selected, next: selected.length < candidates.length ? selected.at(-1)!.id : null,
    textSupport: 'UTF-8 txt/text/md/markdown/csv/tsv/json/jsonl/log/rst; eligibility is checked against the actual original on read.' })
}
export async function readReferenceFile(files: OtherMemoryFilesService, scope: ReferenceScope, peer: string, raw: unknown, signal: AbortSignal): Promise<ReferenceFileExcerpt> {
  const selection = parseReferenceFileSelection(raw)
  const { entry, text } = await files.readText({ namespaceId: scope.namespaceId, topicId: scope.topicId, id: selection.id, version: selection.version }, peer, signal)
  if (selection.sha256 !== entry.source.sha256) throw failure('stale_reference', '参考文件摘要与所选版本不一致。')
  const points = Array.from(text)
  if (selection.range.end > points.length) throw failure('reference_range', '参考范围超出原件实际正文。')
  return bounded({ selection, name: entry.source.name, category: entry.category, totalCodePoints: points.length,
    text: points.slice(selection.range.start, selection.range.end).join('') })
}
export async function searchReferenceFiles(memory: OtherMemoryService, files: OtherMemoryFilesService, scope: ReferenceScope, peer: string,
  query: string, signal: AbortSignal, after?: string) {
  referenceString(query, 300)
  if (after !== undefined) referenceString(after)
  const snapshot = await memory.referencesForTopic(scope, peer)
  const candidates = snapshot.filter(entry => after === undefined || entry.id > after).slice(0, PAGE_FILES)
  const matches: ReferenceFileExcerpt[] = [], unavailable: { id: string; reason: string }[] = []
  let resultsLimited = false, scanned = 0
  const needle = fold(query)
  for (const entry of candidates) {
    signal.throwIfAborted()
    if (!supportsText(entry)) { unavailable.push({ id: entry.id, reason: 'reference_format_unsupported' }); continue }
    let body: string
    try { body = (await files.readText({ namespaceId: scope.namespaceId, topicId: scope.topicId, id: entry.id, version: entry.version }, peer, signal)).text }
    catch (error) {
      signal.throwIfAborted()
      const code = (error as { code?: string }).code
      if (!['reference_format_unsupported', 'reference_integrity_failed'].includes(code ?? '')) throw error
      unavailable.push({ id: entry.id, reason: code! }); continue
    }
    scanned++
    const points = Array.from(body), searchable = fold(body)
    let offset = 0, windows = 0
    while (true) {
      const found = searchable.indexOf(needle, offset)
      if (found < 0) break
      if (windows === 2 || matches.length === 8) { resultsLimited = true; break }
      const position = Array.from(body.slice(0, found)).length
      let start = Math.max(0, position - 200), end = Math.min(points.length, start + 1000)
      if (referenceSegmentationComplete(entry)) {
        const ends = entry.segmentation!.ends, first = ends.findIndex(boundary => boundary > position)
        const wholeStart = first > 0 ? ends[first - 1]! : 0, wholeEnd = ends.find(boundary => boundary >= position + Array.from(query).length)!
        if (wholeEnd - wholeStart <= 4000) { start = wholeStart; end = wholeEnd }
      }
      const selection: ReferenceFileSelection = { id: entry.id, version: entry.version, sha256: entry.source.sha256, range: { start, end } }
      const excerpt = { selection, name: entry.source.name, category: entry.category, totalCodePoints: points.length, text: points.slice(start, end).join('') }
      if (referenceBytes([...matches, excerpt]) > REFERENCE_PAGE_BYTES - 8192) { resultsLimited = true; break }
      matches.push(excerpt)
      windows++; offset = points.slice(0, end).join('').length
    }
  }
  signal.throwIfAborted()
  const latest = await memory.referencesForTopic(scope, peer)
  if (JSON.stringify(latest.map(identity)) !== JSON.stringify(snapshot.map(identity))) throw failure('stale_reference', '参考文件在查询期间变化，请重新查找。')
  return bounded({ method: 'literal_ascii_case_insensitive', matches, resultsLimited,
    coverage: { scannedFiles: scanned, unavailable, next: snapshot.filter(entry => after === undefined || entry.id > after).length > candidates.length ? candidates.at(-1)!.id : null,
      complete: after === undefined && unavailable.length === 0 && candidates.length === snapshot.length },
    note: 'Only current topic file bodies were searched; no embeddings, old revisions, settings, filenames or UI labels. Matches do not establish bilingual alignment.' })
}
