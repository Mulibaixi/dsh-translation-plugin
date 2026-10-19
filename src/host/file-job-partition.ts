import type { FileJobConflict, FileJobProposal, FileJobTerm, FileJobWorker, FileWorkerPreparationOutput, FileWorkerReviewOutput } from '../shared/file-jobs.js'
import type { TranslationSourceRange } from '../shared/translation-source-read.js'

export interface FileSourcePartition {
  readonly id: string; readonly range: TranslationSourceRange; readonly text: string
  readonly contextBefore: string; readonly contextAfter: string
}
export interface FilePartitionOptions {
  readonly maxCodePoints?: number
  /** UTF-8 bytes of the JSON string content, excluding its enclosing quotes. */
  readonly maxBytes?: number
  /** Preserve an indivisible source object even when it exceeds the scheduling target. */
  readonly softByteLimit?: boolean
  readonly protectedRanges?: readonly TranslationSourceRange[]
  readonly contextCodePoints?: number
}
export class FilePartitionError extends Error {
  constructor(readonly code: string, message: string, readonly range?: TranslationSourceRange) { super(message); this.name = 'FilePartitionError' }
}
const encoder = new TextEncoder()
const size = (text: string): number => encoder.encode(JSON.stringify(text).slice(1, -1)).byteLength
/** Default chunk size is a scheduling preference, never a model input ceiling. */
export function suggestFileSourceBytes(inputHint: number | null, overheadBytes = 0, expansion = 1): number {
  const defaultTarget = 196608
  const suggested = Math.floor(((inputHint ?? defaultTarget) - overheadBytes) / expansion)
  // Splitting cannot fix an oversized shared header. Keep a useful source chunk and
  // let the actual adapter decide, instead of rejecting or spawning one-character jobs.
  return suggested >= 256 ? Math.min(defaultTarget, suggested) : defaultTarget
}
function validRange(range: TranslationSourceRange, total: number): boolean {
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= total
}
function rangesUnique(ranges: readonly TranslationSourceRange[]): TranslationSourceRange[] {
  return [...new Map(ranges.map(range => [`${range.start}:${range.end}`, range])).values()].sort((a, b) => a.start - b.start || a.end - b.end)
}

/** Syntax protection preserves whole objects during scheduling; it does not authorize copying or asset adoption. */
export function fileSourceProtectedRanges(text: string): readonly TranslationSourceRange[] {
  const ranges: TranslationSourceRange[] = []
  const patterns = [
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu,
    /\$\$[\s\S]*?(?:\$\$|$)|`[^`\n]+`|\{\{[^{}\n]+\}\}|\$\{[^{}\n]+\}|https?:\/\/[^\s<>]+/gu,
    /^(?:[^\r\n]*\|[^\r\n]*(?:\r?\n|$)){2,}/gmu,
  ]
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const start = Array.from(text.slice(0, match.index)).length
    if (match[0]) ranges.push({ start, end: start + Array.from(match[0]).length })
  }
  return rangesUnique(ranges)
}
function protections(text: string, explicit: readonly TranslationSourceRange[], total: number): readonly TranslationSourceRange[] {
  const sorted = [...fileSourceProtectedRanges(text), ...explicit].sort((a, b) => a.start - b.start || a.end - b.end), merged: TranslationSourceRange[] = []
  for (const range of sorted) {
    if (!validRange(range, total)) throw new FilePartitionError('invalid_protected_range', '文件保护范围无效。', range)
    const previous = merged.at(-1)
    if (previous && range.start < previous.end) merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) }
    else merged.push(range)
  }
  return merged
}
function boundaries(points: readonly string[]): readonly { end: number; rank: number }[] {
  const result = new Map<number, number>()
  let lineStart = 0
  for (let index = 0; index < points.length; index++) {
    const char = points[index]!, next = points[index + 1]
    if (/[。！？]/u.test(char) || /[.!?]/u.test(char) && (next === undefined || /\s/u.test(next))) result.set(index + 1, 2)
    if (/\s/u.test(char)) result.set(index + 1, Math.min(result.get(index + 1) ?? 3, 3))
    if (char !== '\n' && index + 1 !== points.length) continue
    const lineEnd = char === '\n' ? index : index + 1, line = points.slice(lineStart, lineEnd).join('')
    if (/^\s*(?:#{1,6}\s+|第[^\n]{1,30}[章节回卷部](?:\s|$)|chapter\s+\S)/iu.test(line) && lineStart > 0) result.set(lineStart, 0)
    if (!line.trim()) result.set(index + 1, 1)
    lineStart = index + 1
  }
  result.set(points.length, 0)
  return [...result].map(([end, rank]) => ({ end, rank })).sort((a, b) => a.end - b.end)
}

/** Callers choose explicit limits or advisory byte targets; every source position stays covered. */
export function partitionFileSource(text: string, options: FilePartitionOptions = {}): readonly FileSourcePartition[] {
  const points = Array.from(text), total = points.length
  if (!total) return []
  for (const limit of [options.maxBytes, options.maxCodePoints]) if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new FilePartitionError('invalid_partition_capacity', '文件分区需要正整数容量。')
  }
  const contextSize = options.contextCodePoints ?? 160
  if (!Number.isSafeInteger(contextSize) || contextSize < 0) throw new FilePartitionError('invalid_partition_context', '邻接上下文范围无效。')
  const protectedRanges = protections(text, options.protectedRanges ?? [], total), candidates = boundaries(points)
  const prefix = [0]
  for (const point of points) prefix.push(prefix.at(-1)! + size(point))
  const fits = (start: number, end: number): boolean => end - start <= (options.maxCodePoints ?? Infinity) && prefix[end]! - prefix[start]! <= (options.maxBytes ?? Infinity)
  const safe = (end: number): boolean => !protectedRanges.some(range => range.start < end && end < range.end)
  const result: FileSourcePartition[] = []
  for (let start = 0; start < total;) {
    let low = start, high = Math.min(total, start + (options.maxCodePoints ?? total))
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(start, middle)) low = middle; else high = middle - 1 }
    let end = low
    const crossing = protectedRanges.find(range => range.start < end && end < range.end)
    if (crossing) end = crossing.start
    if (end <= start) {
      const protectedRange = protectedRanges.find(range => range.start <= start && start < range.end)
      if (options.softByteLimit) end = protectedRange?.end ?? start + 1
      else throw new FilePartitionError(protectedRange ? 'protected_partition_capacity' : 'partition_capacity_exhausted',
        protectedRange ? '完整保护内容超过本次实际分区容量，请调整模型或输入约束。' : '本次实际分区容量无法容纳下一个字符。', protectedRange ?? { start, end: start + 1 })
    }
    if (end < total) {
      const preferred = candidates.filter(item => item.end > start && item.end <= end && safe(item.end))
      const near = preferred.filter(item => item.end >= start + (end - start) / 2)
      const choices = near.length ? near : preferred
      choices.sort((a, b) => a.rank - b.rank || b.end - a.end)
      end = choices[0]?.end ?? end
    }
    result.push({ id: `p${result.length + 1}`, range: { start, end }, text: points.slice(start, end).join(''),
      contextBefore: points.slice(Math.max(0, start - contextSize), start).join(''), contextAfter: points.slice(end, Math.min(total, end + contextSize)).join('') })
    start = end
  }
  return result
}

export interface FilePartitionRun<T, R> {
  readonly results: readonly { readonly index: number; readonly item: T; readonly value: R }[]
  readonly errors: readonly { readonly index: number; readonly item: T; readonly error: unknown }[]
  readonly cancelled: boolean; readonly started: number; readonly completed: number; readonly maxActive: number
}
/** Two host-owned slots at most. A failure stops new work; accepted siblings settle and retain their actual results. */
export async function mapFilePartitions<T, R>(items: readonly T[], signal: AbortSignal,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>, options: { readonly concurrency?: 1 | 2 } = {}): Promise<FilePartitionRun<T, R>> {
  const concurrency = options.concurrency ?? 2
  if (concurrency !== 1 && concurrency !== 2) throw new FilePartitionError('invalid_partition_concurrency', '文件工作队列只支持一或两个在途工作者。')
  const results: { index: number; item: T; value: R }[] = [], errors: { index: number; item: T; error: unknown }[] = []
  let cursor = 0, stopped = false, started = 0, completed = 0, active = 0, maxActive = 0
  const consume = async (): Promise<void> => {
    while (!stopped && !signal.aborted && cursor < items.length) {
      const index = cursor++, item = items[index]!
      started++; active++; maxActive = Math.max(maxActive, active)
      try { results.push({ index, item, value: await worker(item, index, signal) }) }
      catch (error) { stopped = true; errors.push({ index, item, error }) }
      finally { active--; completed++ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume))
  return { results: results.sort((a, b) => a.index - b.index), errors: errors.sort((a, b) => a.index - b.index), cancelled: signal.aborted, started, completed, maxActive }
}

function shifted(range: TranslationSourceRange, offset: number): TranslationSourceRange { return { start: range.start + offset, end: range.end + offset } }
/** Use only on an output produced from the partition's local source text. */
export function remapPreparation(output: FileWorkerPreparationOutput, offset: number, namespace = `at${offset}`): FileWorkerPreparationOutput {
  const id = (value: string): string => `${namespace}:${value}`
  const proposals = output.proposals.map((proposal): FileJobProposal => {
    const base = { ...proposal, candidateId: id(proposal.candidateId), evidence: proposal.evidence.map(item => ({ range: shifted(item.range, offset) })) }
    if (proposal.kind === 'fact') return { ...base, kind: 'fact', title: proposal.title, body: proposal.body, entityCandidateIds: proposal.entityCandidateIds.map(id) }
    if (proposal.kind === 'relation') return { ...base, kind: 'relation', sourceEntityCandidateId: id(proposal.sourceEntityCandidateId), relation: proposal.relation,
      targetEntityCandidateId: id(proposal.targetEntityCandidateId), description: proposal.description }
    return base as FileJobProposal
  })
  return { context: output.context, terms: output.terms.map(term => ({ ...term, ranges: term.ranges.map(range => shifted(range, offset)) })), proposals,
    conflicts: output.conflicts.map(conflict => ({ ...conflict, id: id(conflict.id), ranges: conflict.ranges.map(range => shifted(range, offset)) })),
    worker: { ...output.worker, range: output.worker.range ? shifted(output.worker.range, offset) : null } }
}
export function remapReview(output: FileWorkerReviewOutput, offset: number): FileWorkerReviewOutput {
  return { reviewedRanges: output.reviewedRanges.map(range => shifted(range, offset)), issues: output.issues.map(issue => ({ ...issue, range: shifted(issue.range, offset) })),
    worker: { ...output.worker, range: output.worker.range ? shifted(output.worker.range, offset) : null } }
}
export interface FilePartitionPreparation { readonly partition: FileSourcePartition; readonly output: FileWorkerPreparationOutput }
export interface FileMergedPreparation {
  readonly terms: readonly FileJobTerm[]; readonly proposals: readonly FileJobProposal[]; readonly conflicts: readonly FileJobConflict[]
  readonly contexts: readonly { readonly range: TranslationSourceRange; readonly text: string }[]; readonly workers: readonly FileJobWorker[]
}
function orderedPartitions<T extends { readonly partition: FileSourcePartition }>(items: readonly T[]): T[] {
  const ordered = [...items].sort((a, b) => a.partition.range.start - b.partition.range.start), ids = new Set<string>()
  for (const [index, { partition }] of ordered.entries()) {
    if (!partition.id || ids.has(partition.id) || partition.range.start < 0 || partition.range.end - partition.range.start !== Array.from(partition.text).length ||
      index > 0 && ordered[index - 1]!.partition.range.end > partition.range.start) {
      throw new FilePartitionError('invalid_partition_identity', '原稿分区标识重复、范围重叠或正文长度不一致。', partition.range)
    }
    ids.add(partition.id)
  }
  return ordered
}
/** Namespace dependencies before merging. Only identical term content is coalesced; entities remain distinct. */
export function mergeFilePreparations(items: readonly FilePartitionPreparation[]): FileMergedPreparation {
  const terms = new Map<string, FileJobTerm>(), termProposals = new Map<string, Extract<FileJobProposal, { kind: 'term' }>>()
  const proposals: FileJobProposal[] = [], conflicts: FileJobConflict[] = [], contexts: { range: TranslationSourceRange; text: string }[] = [], workers: FileJobWorker[] = []
  for (const { partition, output } of orderedPartitions(items)) {
    const total = Array.from(partition.text).length
    if (partition.range.end - partition.range.start !== total || [...output.terms.flatMap(item => item.ranges), ...output.proposals.flatMap(item => item.evidence.map(evidence => evidence.range)),
      ...output.conflicts.flatMap(item => item.ranges)].some(range => !validRange(range, total))) throw new FilePartitionError('invalid_partition_output', '子任务结果引用不属于该原稿分区。', partition.range)
    const mapped = remapPreparation(output, partition.range.start, partition.id)
    for (const term of mapped.terms) {
      const key = JSON.stringify([term.source, term.target, term.description ?? '']), previous = terms.get(key)
      terms.set(key, previous ? { ...previous, ranges: rangesUnique([...previous.ranges, ...term.ranges]) } : term)
    }
    for (const proposal of mapped.proposals) {
      if (proposal.kind !== 'term') { proposals.push(proposal); continue }
      const key = JSON.stringify([[...proposal.sourceForms].sort(), proposal.preferred, proposal.description, proposal.origin, proposal.disposition]), previous = termProposals.get(key)
      termProposals.set(key, previous ? { ...previous, evidence: rangesUnique([...previous.evidence, ...proposal.evidence].map(item => item.range)).map(range => ({ range })) } : proposal)
    }
    conflicts.push(...mapped.conflicts)
    workers.push({ ...mapped.worker, range: partition.range })
    // Context pages have a transport bound, independent of any model capacity.
    for (const fragment of contextFragments(output.context)) contexts.push({ range: partition.range, text: fragment })
  }
  const meanings = new Map<string, FileJobTerm[]>()
  for (const term of terms.values()) { const existing = meanings.get(term.source) ?? []; existing.push(term); meanings.set(term.source, existing) }
  for (const [source, variants] of meanings) if (new Set(variants.map(term => term.target)).size > 1) conflicts.push({
    id: `merge:term:${conflicts.length + 1}`, message: `同一原词“${source}”存在不同候选译法：${[...new Set(variants.map(term => term.target))].join(' / ')}。请结合各段语义集中决定，程序未合并义项。`,
    ranges: rangesUnique(variants.flatMap(term => term.ranges)),
  })
  return { terms: [...terms.values()], proposals: [...termProposals.values(), ...proposals], conflicts, contexts, workers }
}
function contextFragments(text: string): readonly string[] {
  const fragments: string[] = []
  let fragment = '', bytes = 0
  for (const point of text) {
    const count = size(point)
    if (bytes + count > 8192 && fragment) { fragments.push(fragment); fragment = ''; bytes = 0 }
    fragment += point; bytes += count
  }
  if (fragment) fragments.push(fragment)
  return fragments
}
export function mergeFileReviews(items: readonly { readonly partition: FileSourcePartition; readonly output: FileWorkerReviewOutput }[]): {
  readonly reviewedRanges: readonly TranslationSourceRange[]; readonly issues: FileWorkerReviewOutput['issues']; readonly workers: readonly FileJobWorker[]
} {
  const outputs = orderedPartitions(items).map(({ partition, output }) => {
    const total = Array.from(partition.text).length
    if ([...output.reviewedRanges, ...output.issues.map(item => item.range)].some(range => !validRange(range, total))) {
      throw new FilePartitionError('invalid_partition_review', '子任务审阅范围不属于该原稿分区。', partition.range)
    }
    const mapped = remapReview(output, partition.range.start)
    return { ...mapped, worker: { ...mapped.worker, range: partition.range } }
  })
  return { reviewedRanges: rangesUnique(outputs.flatMap(output => output.reviewedRanges)), issues: outputs.flatMap(output => output.issues), workers: outputs.map(output => output.worker) }
}
