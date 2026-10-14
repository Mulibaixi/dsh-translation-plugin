import { documentSourceLength, sameVersionReference, type DocumentUnit } from '../shared/translation-batch.js'
import type { DocumentMechanicalReview, DocumentReviewIssue } from '../shared/document-review.js'
import type { PreparationSnapshot } from '../shared/translation-preparation.js'
import type { TranslationSourceRange } from '../shared/translation-source-read.js'
import { isDocumentManifestReuse } from './document-correction.js'
export { appendDocumentManualRevision, appendDocumentReviewAudit, documentManifestFinalEligibility, documentReviewVersion } from './document-task.js'

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const overlap = (left: TranslationSourceRange, right: TranslationSourceRange): boolean => left.start < right.end && right.start < left.end
function hasUnprotectedOverlap(range: TranslationSourceRange, outputRange: TranslationSourceRange, protectedRanges: readonly TranslationSourceRange[]): boolean {
  let cursor = Math.max(range.start, outputRange.start)
  const end = Math.min(range.end, outputRange.end)
  if (cursor >= end) return false
  for (const protectedRange of protectedRanges) {
    if (protectedRange.end <= cursor) continue
    if (protectedRange.start > cursor) return true
    cursor = Math.max(cursor, protectedRange.end)
    if (cursor >= end) return false
  }
  return cursor < end
}
async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text), digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export interface VerifyDocumentMechanicalReviewInput {
  readonly unit: DocumentUnit
  readonly manifestRevisionId: string
  /** Complete exact source read under the fixed reader handle, never a padded prefix. */
  readonly sourceText: string
  readonly preparation: Pick<PreparationSnapshot, 'id' | 'version' | 'sourceVersion' | 'sourceSha256' | 'totalCodePoints' | 'terms' | 'conflicts' | 'preparationReady'>
}
/** Uses actual source and immutable chunk bodies. It makes no semantic quality claim. */
export async function verifyDocumentMechanicalReview(input: VerifyDocumentMechanicalReviewInput): Promise<DocumentMechanicalReview> {
  const { unit, preparation } = input, manifest = unit.revisions.find(revision => revision.id === input.manifestRevisionId)
  if (!manifest) throw new TypeError('Fixed document review manifest unavailable')
  const source = unit.sourceVersions.find(source => source.version === manifest.sourceVersion)
  const plan = unit.plans.find(plan => sameVersionReference(plan, manifest.planRef))
  if (!source || !plan) throw new TypeError('Document review source or fixed plan unavailable')
  const points = Array.from(input.sourceText), sourceSha256 = await sha256(input.sourceText), length = documentSourceLength(source)
  if (points.length !== length || /[\uD800-\uDFFF]/u.test(input.sourceText) ||
    (source.body.kind === 'inline' ? source.body.text !== input.sourceText : source.body.reference.sha256 !== sourceSha256)) throw new TypeError('Document review actual source identity changed')
  const whole = { start: 0, end: length }, issues: DocumentReviewIssue[] = [], suspicions: DocumentReviewIssue[] = []
  const add = (code: string, range: TranslationSourceRange, message: string): void => { issues.push({ code, range, message }) }
  if (manifest.sourceVersion !== unit.sourceVersion) add('source_changed', whole, '该清单不是当前原稿版本。')
  if (!sameVersionReference(preparation, manifest.preparationRef) || preparation.sourceVersion !== manifest.sourceVersion || preparation.sourceSha256 !== sourceSha256 || preparation.totalCodePoints !== length || !preparation.preparationReady ||
    plan.sourceVersion !== manifest.sourceVersion || !sameVersionReference(plan.preparationRef, manifest.preparationRef)) add('preparation_invalid', whole, '实际准备版本或原稿依据与固定清单不符。')
  for (const conflict of preparation.conflicts) for (const range of conflict.ranges.length ? conflict.ranges : [whole]) add(conflict.code, range, conflict.message)
  let end = 0, outputBytes = 0
  const revisionIds = new Set<string>(), entries: DocumentMechanicalReview['entries'][number][] = []
  for (let index = 0; index < manifest.entries.length; index++) {
    const entry = manifest.entries[index]!, item = plan.items[index], chunk = unit.chunkRevisions.find(chunk => chunk.id === entry.revisionId)
    if (!item || item.chunkId !== entry.chunkId || !same(item.outputRange, entry.outputRange) || entry.outputRange.start !== end || revisionIds.has(entry.revisionId)) add('manifest_coverage', entry.outputRange, '清单必须按固定计划顺序完整覆盖原稿一次。')
    revisionIds.add(entry.revisionId); end = entry.outputRange.end
    let text = ''
    const reused = !!entry.reuseRef && isDocumentManifestReuse(unit, manifest, entry)
    if (!chunk || !reused && (chunk.chunkId !== entry.chunkId || chunk.taskId !== manifest.taskId || chunk.sourceVersion !== manifest.sourceVersion || !!entry.reuseRef)) add('chunk_reference_invalid', entry.outputRange, '清单引用的实际块或复用批准不成立。')
    if (chunk) {
      if (chunk.status !== 'completed' || chunk.kind === 'machine' && !chunk.callRecord) add('chunk_not_completed', entry.outputRange, '实际块尚未完整完成，可能失败、未知或被截断。')
      if (item && (chunk.kind === 'copy') !== (item.mode === 'copy')) add('chunk_mode_changed', entry.outputRange, '实际块与固定计划的复制或翻译模式不符。')
      if (chunk.content.kind === 'text') text = chunk.content.text
      else {
        text = points.slice(entry.outputRange.start, entry.outputRange.end).join('')
        if (!reused && (chunk.content.sourceVersion !== manifest.sourceVersion || !same(chunk.content.range, entry.outputRange)) || await sha256(text) !== chunk.content.sha256) add('copy_integrity_failed', entry.outputRange, '复制块的实际精确范围内容校验失败。')
      }
      const protectedParts = (plan.protectedRanges ?? []).filter(range => overlap(range, entry.outputRange))
      let protectedCursor = 0
      for (const part of protectedParts) {
        const range = { start: Math.max(part.start, entry.outputRange.start), end: Math.min(part.end, entry.outputRange.end) }
        const protectedText = points.slice(range.start, range.end).join(''), found = text.indexOf(protectedText, protectedCursor)
        if (found < 0) add('protected_content_changed', range, '必须逐字保留的内容缺失或顺序发生变化。')
        else protectedCursor = found + protectedText.length
      }
      for (const term of preparation.terms) {
        if (item?.mode !== 'translate' || !term.ranges.some(range => hasUnprotectedOverlap(range, entry.outputRange, plan.protectedRanges ?? []))) continue
        const questionable = !text.includes(term.preferred) || term.forbidden.some(form => text.includes(form))
        const code = term.userFixed ? 'fixed_term_suspected' : 'term_suspected'
        if (questionable && !suspicions.some(issue => issue.code === code && same(issue.range, entry.outputRange))) suspicions.push({ code, range: entry.outputRange,
          message: `请按实际语义核对当前准备选中的${term.userFixed ? '用户固定译法' : '术语'}；字符串匹配仅提示疑点。` })
      }
    }
    entries.push({ chunkId: entry.chunkId, revisionId: entry.revisionId, outputRange: entry.outputRange, contentSha256: await sha256(text) })
    outputBytes += new TextEncoder().encode(text).byteLength
  }
  if (outputBytes > 16 * 1024 * 1024) add('output_budget_exceeded', whole, '固定候选的实际累计正文超过 16 MiB。')
  if (end !== length || manifest.entries.length !== plan.items.length || plan.items.some((item, index) => item.outputRange.start !== (index ? plan.items[index - 1]!.outputRange.end : 0)) || plan.items.at(-1)?.outputRange.end !== length) add('manifest_coverage', whole, '清单缺少必要范围或固定计划覆盖不完整。')
  // Changed call dependencies remain visible facts and need an explicit semantic resolution.
  const critical = unit.tasks.find(task => task.taskId === manifest.taskId)?.executionFacts?.reviewIssues ?? []
  suspicions.push(...critical)
  return { status: issues.length ? 'failed' : 'passed', sourceSha256, entries, issues, criticalIssues: critical, suspicions }
}
