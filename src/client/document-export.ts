import type { EvidenceReadResult, EvidenceUnavailableResult } from '../shared/translation-evidence.js'
import { sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { DocumentReadSnapshot } from './source-reader.js'

export interface DocumentMissingRange {
  readonly range: TranslationSourceRange
  readonly chunkId: string | null
  readonly reason: string
  readonly status: EvidenceUnavailableResult['status'] | 'incomplete'
  readonly side: 'source' | 'translation'
}
export interface DocumentExportBlock {
  readonly chunkId: string
  readonly outputRange: TranslationSourceRange
  readonly revisionId: string | null
  readonly mode: 'translate' | 'copy'
  readonly source: string | null
  readonly translation: string | null
  readonly status: 'completed' | 'missing'
}
export interface DocumentProjection {
  readonly text: string | null
  readonly complete: boolean
  readonly hasTranslation: boolean
  readonly blocks: readonly DocumentExportBlock[]
  readonly missingRanges: readonly DocumentMissingRange[]
  readonly manifestRevisionId: string | null
  readonly sourceVersion: number
}
/** All requests remain bounded; a byte-heavy reply reduces the page instead of becoming a missing fact. */
export async function readDocumentText(read: (range: TranslationSourceRange) => Promise<EvidenceReadResult>, range: TranslationSourceRange): Promise<{ readonly text: string } | EvidenceUnavailableResult> {
  let start = range.start, size = Math.min(2000, range.end - range.start), text = ''
  while (start < range.end) {
    const part = { start, end: Math.min(range.end, start + size) }, result = await read(part)
    if (result.status !== 'ready') {
      if (result.status === 'unloaded' && result.reason === 'range_required' && size > 1) { size = Math.max(1, Math.floor(size / 2)); continue }
      return result
    }
    if (result.range.start !== part.start || result.range.end !== part.end || sourceCodePointLength(result.text) !== part.end - part.start) {
      return { status: 'corrupt', request: result.request, reason: 'page_range_mismatch' }
    }
    text += result.text; start = part.end
  }
  return { text }
}
function marker(missing: DocumentMissingRange): string {
  const reason = missing.status === 'forbidden' ? '无权读取' : missing.status === 'corrupt' ? '内容校验失败'
    : missing.status === 'unloaded' ? '尚未取得内容' : missing.reason === 'chunk_unknown' ? '译文状态未知'
      : missing.reason === 'chunk_failed' ? '此范围翻译失败' : '此范围尚无可用译文'
  return `\n[缺失：原文码点 ${missing.range.start}–${missing.range.end}；${reason}]\n`
}
/** The projection is disposable. The fixed manifest and chunk records remain authoritative. */
export async function projectDocument(snapshot: DocumentReadSnapshot, includeSource = false, selection: 'final' | 'candidate' = 'final'): Promise<DocumentProjection> {
  const missingRanges: DocumentMissingRange[] = [], blocks: DocumentExportBlock[] = [], parts: string[] = []
  let hasTranslation = false, end = 0
  const { manifest, plan } = snapshot
  const validPlan = !!plan && plan.sourceVersion === snapshot.target.sourceVersion && plan.items.length > 0 && plan.items.every(item => {
    const valid = item.outputRange.start === end && item.outputRange.end > end && item.outputRange.end <= snapshot.totalSourceCodePoints
    end = item.outputRange.end; return valid
  }) && end === snapshot.totalSourceCodePoints
  let previous = -1
  const revisionIds = new Set<string>()
  const validManifest = !!manifest && validPlan && manifest.entries.every(entry => {
    const index = snapshot.blocks.findIndex(block => block.chunkId === entry.chunkId), block = snapshot.blocks[index]
    const valid = !!block && index > previous && !revisionIds.has(entry.revisionId) && entry.outputRange.start === block.outputRange.start && entry.outputRange.end === block.outputRange.end && entry.revisionId === block.revisionId
    previous = index; revisionIds.add(entry.revisionId); return valid
  })
  const whole = { start: 0, end: snapshot.totalSourceCodePoints }
  if (!validPlan || !validManifest) {
    const missing: DocumentMissingRange = { range: whole, chunkId: null, side: 'translation', status: 'incomplete', reason: !validPlan ? 'plan_missing_or_invalid' : 'manifest_missing_or_invalid' }
    missingRanges.push(missing)
  }
  // finalRevisionId was fixed through the domain's sole qualification rule during capture.
  const fixedFinal = !!manifest && manifest.id === snapshot.finalRevisionId
  if (selection === 'final' && validManifest && !fixedFinal) missingRanges.push({ range: whole, chunkId: null, side: 'translation', status: 'incomplete', reason: 'manifest_not_final' })
  for (const block of validPlan ? snapshot.blocks : []) {
    let source: string | null = null, translation: string | null = null
    if (includeSource) {
      const loaded = await readDocumentText(range => snapshot.readSource(range), block.outputRange)
      if ('text' in loaded) source = loaded.text
      else missingRanges.push({ range: block.outputRange, chunkId: block.chunkId, side: 'source', status: loaded.status, reason: loaded.reason })
    }
    let missing: DocumentMissingRange | null = null
    if (manifest && !validManifest || !block.revision || !block.revisionId) missing = { range: block.outputRange, chunkId: block.chunkId, side: 'translation', status: 'incomplete', reason: 'chunk_missing' }
    else if (block.revision.status !== 'completed') missing = { range: block.outputRange, chunkId: block.chunkId, side: 'translation', status: 'incomplete', reason: `chunk_${block.revision.status}` }
    else {
      const length = block.revision.content.kind === 'text' ? sourceCodePointLength(block.revision.content.text) : block.revision.content.range.end - block.revision.content.range.start
      const loaded = await readDocumentText(range => snapshot.readChunk(block.revisionId!, range), { start: 0, end: length })
      if ('text' in loaded && loaded.text.length) translation = loaded.text
      else missing = { range: block.outputRange, chunkId: block.chunkId, side: 'translation', status: 'text' in loaded ? 'incomplete' : loaded.status, reason: 'text' in loaded ? 'chunk_empty' : loaded.reason }
    }
    if (missing) { missingRanges.push(missing); parts.push(marker(missing)) }
    if (translation !== null) { hasTranslation = true; parts.push(translation) }
    blocks.push({ chunkId: block.chunkId, outputRange: { ...block.outputRange }, revisionId: block.revisionId, mode: block.mode,
      source, translation, status: translation === null ? 'missing' : 'completed' })
  }
  const after = snapshot.check()
  if (after) {
    missingRanges.push({ range: whole, chunkId: null, side: 'translation', status: after.status, reason: after.reason })
    return { text: null, complete: false, hasTranslation: false, blocks: [], missingRanges, manifestRevisionId: manifest?.id ?? null, sourceVersion: snapshot.target.sourceVersion }
  }
  const complete = (selection === 'candidate' ? Boolean(manifest?.eligibility.complete) : fixedFinal) && !!manifest && manifest.entries.length === snapshot.blocks.length && missingRanges.length === 0
  const qualification = selection === 'final' && validManifest && !fixedFinal ? '\n[未定稿：此文档清单尚未成为最终译文]\n' : ''
  return { text: hasTranslation ? qualification + parts.join('') : null, complete, hasTranslation, blocks, missingRanges,
    manifestRevisionId: manifest?.id ?? null, sourceVersion: snapshot.target.sourceVersion }
}
