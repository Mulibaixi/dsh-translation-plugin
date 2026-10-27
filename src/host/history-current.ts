import { currentFinalRevision, isDocumentUnit, isTextUnit, isDeletedUnit } from '../memory/translation-history.js'
import { currentDocumentFinal } from '../memory/document-task.js'
import type { DocumentUnit, DocumentSourceVersion } from '../shared/translation-batch.js'
import type { HistoryBundle } from '../shared/history-bundle.js'
import type { CurrentHistoryRead, HistoryCurrentPage } from '../shared/history-remote.js'
import type { TranslationSourcesService } from './translation-sources.js'
import { sourceSha256 } from './source-storage.js'
import { currentFileJob } from '../memory/file-job-current.js'

/** Exact current final only. An unavailable projection never falls back to a newer candidate. */
export async function readCurrentHistory(bundle: HistoryBundle, request: CurrentHistoryRead, peer: string, sources: TranslationSourcesService | undefined, signal: AbortSignal, pagePoints = 4000): Promise<HistoryCurrentPage> {
  const unit = bundle.history.units.find(unit => unit.id === request.unitId)
  if (!unit || isDeletedUnit(unit)) throw new Error('此历史单元已删除或不可用。')
  const kind = isTextUnit(unit) ? 'text' : unit.kind
  const base = { token: request.token, unitId: unit.id, kind, sourceVersion: unit.sourceVersion, targetLanguage: isTextUnit(unit) || isDocumentUnit(unit) ? unit.targetLanguage : bundle.session.targetLanguage } as const
  const missing = (reason: string, finalId: string | null = null): HistoryCurrentPage => ({ ...base, finalId, text: null, totalCodePoints: 0, next: null, reason })
  const page = (text: string, finalId: string | null): HistoryCurrentPage => {
    const points = Array.from(text)
    if (request.start > points.length || points.length > 0 && request.start === points.length) throw new Error('历史正文位置已超出当前版本。')
    const end = Math.min(points.length, request.start + pagePoints)
    return { ...base, finalId, text: points.slice(request.start, end).join(''), totalCodePoints: points.length, next: end < points.length ? end : null }
  }
  if (isTextUnit(unit)) {
    const final = currentFinalRevision(unit)
    return request.side === 'source' ? page(unit.sourceVersions.find(source => source.version === unit.sourceVersion)!.text, final?.id ?? null)
      : final ? page(final.text, final.id) : missing('此单元没有当前有效的最终译文。')
  }
  if (unit.kind === 'file_job') {
    const selected = currentFileJob(bundle.fileJobs.filter(record => record.summary.unitId === unit.id), unit.sourceVersion)
    const body = request.side === 'source' ? selected?.source : selected?.final
    return body ? { ...page(body.text, selected?.final ? `file-result:${selected.final.version}` : null), targetLanguage: selected!.targetLanguage } : missing(selected?.reason ?? '当前文件正文尚未完整取得。')
  }
  const doc = unit as DocumentUnit, source = doc.sourceVersions.find(source => source.version === doc.sourceVersion)!, final = currentDocumentFinal(doc)
  const readSource = async (source: DocumentSourceVersion, start: number, end: number): Promise<string | undefined> => {
    signal.throwIfAborted()
    if (source.body.kind === 'inline') return Array.from(source.body.text).slice(start, end).join('')
    const commit = source.historyCommit, ref = commit?.reference
    if (!sources || !commit || !ref || ref.scope.topicId !== request.topicId || ref.scope.translationSessionId !== request.sessionId || ref.scope.namespaceId !== undefined && ref.scope.namespaceId !== request.namespaceId) return undefined
    const result = await sources.readLibrarySource({ namespaceId: request.namespaceId, stored: { scope: ref.scope, referenceKey: ref.referenceKey, source: ref.source, historyToken: commit.historyToken }, prepareToken: ref.prepareToken, action: 'page', range: { start, end } }, signal, peer)
    return result.ok && result.value.kind === 'page' ? result.value.text : undefined
  }
  if (request.side === 'source') {
    const length = source.body.kind === 'inline' ? Array.from(source.body.text).length : source.body.reference.totalCodePoints
    if (request.start >= length && length !== 0) throw new Error('当前原件读取范围已变化。')
    const end = Math.min(length, request.start + pagePoints), text = await readSource(source, request.start, end)
    return text === undefined ? missing('当前原件未保存、已释放或无法准确读取。', final?.id ?? null) : { ...base, finalId: final?.id ?? null, text, totalCodePoints: length, next: end < length ? end : null }
  }
  if (!final) return missing('当前文档没有有效的最终清单。')
  const plan = doc.plans.find(plan => plan.id === final.planRef.id && plan.version === final.planRef.version)
  if (!plan) return missing('当前最终清单的规划不可用。', final.id)
  const parts = plan.items.map(item => {
    const entry = final.entries.find(entry => entry.chunkId === item.chunkId)
    return doc.chunkRevisions.find(chunk => chunk.id === entry?.revisionId)
  })
  if (parts.some(part => !part)) return missing('当前最终清单的正文不完整。', final.id)
  const lengths = parts.map(part => part!.content.kind === 'text' ? Array.from(part!.content.text).length : part!.content.range.end - part!.content.range.start)
  const total = lengths.reduce((sum, length) => sum + length, 0), end = Math.min(total, request.start + pagePoints)
  if (request.start > total || request.start === total && total > 0) throw new Error('当前最终译文读取范围已变化。')
  let offset = 0, text = ''
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i]!, length = lengths[i]!, from = Math.max(0, request.start - offset), to = Math.min(length, end - offset); offset += length
    if (to <= from) continue
    if (chunk.content.kind === 'text') { text += Array.from(chunk.content.text).slice(from, to).join(''); continue }
    const content = chunk.content, original = doc.sourceVersions.find(source => source.version === content.sourceVersion)
    if (!original) return missing('保留片段的原稿版本不可用。', final.id)
    let verified = false
    if (original.body.kind === 'inline') verified = await sourceSha256(new TextEncoder().encode(Array.from(original.body.text).slice(content.range.start, content.range.end).join(''))) === content.sha256
    else if (original.historyCommit && sources) {
      const commit = original.historyCommit, ref = commit.reference
      if (ref.scope.topicId === request.topicId && ref.scope.translationSessionId === request.sessionId && (ref.scope.namespaceId === undefined || ref.scope.namespaceId === request.namespaceId)) {
        const result = await sources.readLibrarySource({ namespaceId: request.namespaceId, stored: { scope: ref.scope, referenceKey: ref.referenceKey, source: ref.source, historyToken: commit.historyToken }, prepareToken: ref.prepareToken, action: 'verify', range: content.range, sha256: content.sha256 }, signal, peer)
        verified = result.ok && result.value.kind === 'verified'
      }
    }
    if (!verified) return missing('保留片段的原件或摘要无法核验。', final.id)
    const copied = await readSource(original, content.range.start + from, content.range.start + to)
    if (copied === undefined) return missing('保留片段的原件不可读取。', final.id)
    text += copied
  }
  signal.throwIfAborted()
  return { ...base, finalId: final.id, text, totalCodePoints: total, next: end < total ? end : null }
}
