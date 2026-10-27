import type { FileJobRecord } from '../shared/file-job-record.js'
import type { FileJobSummary } from '../shared/file-jobs.js'
import { currentFileJob, fileResultSourceVersion } from './file-job-current.js'

export function fileResultDeletionBlockedReason(records: readonly FileJobRecord[], sourceVersion: number, version: number): string | undefined {
  const selected = currentFileJob(records, sourceVersion), result = selected?.record.results.find(result => result.version === version)
  if (!result) return '此译文版本不存在或归属不明确。'
  if (result.deletion) return '此译文版本已删除。'
  if (selected!.final?.version === version) return '当前最终译文不能删除，请先选择其他最终版本。'
  if (version === Math.max(...selected!.record.results.map(result => result.version))) return '最新译文版本不能删除。'
  if (records.some(record => record.results.some(result => !result.deletion && result.baseVersion === version))) return '此版本仍是后续修订的基础，请先处理依赖它的修订。'
  if (records.some(record => !['completed', 'failed', 'cancelled'].includes(record.summary.phase) || record.workers.some(worker => ['queued', 'running', 'unknown'].includes(worker.status)))) return '此文件仍有未结算任务，请先结束或查询。'
  return undefined
}
export function deleteFileResult(records: readonly FileJobRecord[], sourceVersion: number, version: number, deletion: { readonly eventId: string; readonly at: string }): readonly FileJobRecord[] {
  const blocked = fileResultDeletionBlockedReason(records, sourceVersion, version)
  if (blocked) throw new Error(blocked)
  return records.map(record => eraseFileResult(record, version, deletion))
}
/** Also applied to late pages, so an earlier captured record cannot restore a deleted body. */
export function eraseFileResult(record: FileJobRecord, version: number, deletion: { readonly eventId: string; readonly at: string }): FileJobRecord {
  if (!record.results.some(result => result.version === version)) return record
  const cleanSummary = (summary: FileJobSummary): FileJobSummary => ({ ...summary, instruction: '', organizedRequirements: '', error: null, notice: '', ...(summary.result?.version === version ? { result: null } : {}) })
  const results = record.results.map(result => result.version === version ? { ...result, text: '', deletion } : result)
  const operations = record.revisionOperations?.map(operation => operation.summary.result?.version === version ? { ...operation, signature: '', summary: cleanSummary(operation.summary) } : operation)
  const next: FileJobRecord = { ...record, results, summary: record.summary.result?.version === version ? { ...record.summary, result: null } : record.summary,
    final: record.final?.version === version ? null : record.final, ...(operations ? { revisionOperations: operations } : {}) }
  if (results.some(result => !result.deletion)) return next
  const { preparation: _preparation, constraints: _constraints, plan: _plan, checks: _checks, contexts: _contexts, reviews: _reviews, ...withoutBodies } = next
  return { ...withoutBodies, summary: cleanSummary(next.summary) }
}

export function fileSourceDeletionBlockedReason(records: readonly FileJobRecord[], currentVersion: number, version: number): string | undefined {
  const sources = records.flatMap(record => record.sources.filter(source => source.version === version))
  if (!sources.length || sources.every(source => source.deletion)) return '此旧原稿已删除或不存在。'
  if (version === currentVersion) return '当前原稿不能删除。'
  if (sources.some(source => source.deletion) || new Set(sources.map(source => source.text)).size !== 1) return '此原稿的同版本内容不一致，暂不能删除。'
  if (records.some(record => !['completed', 'failed', 'cancelled'].includes(record.summary.phase) || record.workers.some(worker => ['queued', 'running', 'unknown'].includes(worker.status)))) return '此文件仍有未结算任务，请先结束或查询。'
  if (records.some(record => record.results.some(result => fileResultSourceVersion(record, result) === undefined))) return '译文的原稿归属不明确，暂不能删除。'
  const removed = new Set(records.flatMap(record => record.results.filter(result => fileResultSourceVersion(record, result) === version).map(result => result.version)))
  if (records.some(record => record.results.some(result => !result.deletion && fileResultSourceVersion(record, result) !== version && result.baseVersion !== undefined && removed.has(result.baseVersion)))) return '其他原稿的保留译文仍以此稿译文为修订基础，暂不能删除。'
  return undefined
}
export function deleteFileSource(records: readonly FileJobRecord[], currentVersion: number, version: number, deletion: { readonly eventId: string; readonly at: string }): readonly FileJobRecord[] {
  const blocked = fileSourceDeletionBlockedReason(records, currentVersion, version)
  if (blocked) throw new Error(blocked)
  return records.map(record => eraseFileSource(record, version, deletion))
}
/** Removes owned bodies in every repeated record; independent adopted assets live elsewhere. */
export function eraseFileSource(record: FileJobRecord, version: number, deletion: { readonly eventId: string; readonly at: string }): FileJobRecord {
  let next = record
  for (const result of record.results) if (!result.deletion && fileResultSourceVersion(record, result) === version) next = eraseFileResult(next, result.version, deletion)
  next = { ...next, sources: next.sources.map(source => source.version === version && !source.deletion ? { ...source, text: '', deletion } : source) }
  if (record.summary.sourceVersion !== version) return next
  const clean = (summary: FileJobSummary): FileJobSummary => {
    const { sourceRef: _sourceRef, sourceOrigin: _sourceOrigin, assetFeedback: _feedback, ...metadata } = summary
    return { ...metadata, instruction: '', organizedRequirements: '', error: null, notice: '', result: null, proposalBatch: null, baselineVersion: null }
  }
  const { preparation: _preparation, constraints: _constraints, plan: _plan, checks: _checks, contexts: _contexts, reviews: _reviews, ...metadata } = next
  return { ...metadata, summary: clean(next.summary), proposals: [], cards: [], proposalVersion: null,
    ...(next.revisionOperations ? { revisionOperations: next.revisionOperations.map(operation => ({ ...operation, signature: '', summary: clean(operation.summary) })) } : {}) }
}
