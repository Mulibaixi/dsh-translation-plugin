import type { FileJobRecord, FileJobTextVersion } from '../shared/file-job-record.js'

export interface CurrentFileJob {
  readonly record: FileJobRecord
  readonly source: FileJobTextVersion | undefined
  readonly final: FileJobTextVersion | undefined
  readonly targetLanguage: string
  readonly reason?: string
}
export function fileResultSourceVersion(record: FileJobRecord, result: FileJobTextVersion): number | undefined {
  return result.sourceVersion ?? (record.summary.result?.version === result.version || record.sources.length === 1 ? record.summary.sourceVersion : undefined)
}
/** Admission and explicit choices determine the result; a maximum result number is never a final. */
export function currentFileJob(records: readonly FileJobRecord[], sourceVersion?: number): CurrentFileJob | undefined {
  if (!records.length) return undefined
  // Stable sorting preserves recorded admission order when timestamps share a millisecond.
  const ordered = [...records].sort((a, b) => Date.parse(a.summary.createdAt) - Date.parse(b.summary.createdAt))
  const currentVersion = sourceVersion ?? ordered.at(-1)!.summary.sourceVersion
  const current = ordered.filter(record => record.summary.sourceVersion === currentVersion), latest = current.at(-1) ?? ordered.at(-1)!
  const sources = new Map<number, FileJobTextVersion>(), results = new Map<number, FileJobTextVersion>(), conflicts = new Set<number>(), sourceConflicts = new Set<number>()
  const bindings = new Map<number, Set<number>>()
  for (const record of ordered) {
    for (const source of record.sources) {
      if (sources.has(source.version) && (sources.get(source.version)!.text !== source.text || JSON.stringify(sources.get(source.version)!.deletion) !== JSON.stringify(source.deletion))) sourceConflicts.add(source.version)
      else sources.set(source.version, source)
    }
    for (const result of record.results) {
      const old = results.get(result.version)
      if (old && (old.text !== result.text || old.semanticStatus !== undefined && result.semanticStatus !== undefined && old.semanticStatus !== result.semanticStatus)) conflicts.add(result.version)
      else results.set(result.version, old?.semanticStatus === undefined ? result : old ?? result)
      const origin = fileResultSourceVersion(record, result)
      if (origin !== undefined) { const values = bindings.get(result.version) ?? new Set<number>(); values.add(origin); bindings.set(result.version, values) }
    }
  }
  for (const [version, values] of bindings) {
    if (values.size > 1) conflicts.add(version)
    else if (results.has(version)) results.set(version, { ...results.get(version)!, sourceVersion: [...values][0]! })
  }
  const eligible = (version: number): FileJobTextVersion | undefined => {
    const result = results.get(version)
    return result && !result.deletion && result.sourceVersion === currentVersion && result.semanticStatus === 'passed' && !conflicts.has(version) && !sourceConflicts.has(currentVersion) ? result : undefined
  }
  const fixed = current.filter(record => record.final?.selection === 'user_fixed' && eligible(record.final.version))
    .sort((a, b) => Date.parse(b.final!.selectedAt) - Date.parse(a.final!.selectedAt))
  const tiedChoices = fixed.filter(record => record.final!.selectedAt === fixed[0]?.final?.selectedAt)
  const ambiguousChoice = new Set(tiedChoices.map(record => record.final!.version)).size > 1
  const selection = ambiguousChoice ? null : fixed[0]?.final ?? (latest.summary.sourceVersion === currentVersion && latest.summary.phase === 'completed' && latest.summary.result?.semanticStatus === 'passed' && latest.summary.result.version === latest.final?.version && eligible(latest.final.version) ? latest.final : null)
  const source = sourceConflicts.has(currentVersion) || sources.get(currentVersion)?.deletion ? undefined : sources.get(currentVersion), final = selection ? eligible(selection.version) : undefined
  const origin = final && ordered.find(record => record.summary.sourceVersion === currentVersion && record.results.some(value => value.version === final.version && value.text === final.text))
  const record: FileJobRecord = { ...latest, summary: { ...latest.summary, sourceVersion: currentVersion, createdAt: ordered[0]!.summary.createdAt },
    sources: [...sources.values()].filter(value => !sourceConflicts.has(value.version)).sort((a, b) => a.version - b.version),
    results: [...results.values()].filter(value => !conflicts.has(value.version)).sort((a, b) => a.version - b.version), final: source && final ? selection : null }
  return { record, source, final: source ? final : undefined, targetLanguage: origin?.summary.targetLanguage ?? latest.summary.targetLanguage,
    ...(!source || !final ? { reason: !source ? '当前文件原文缺失或同版本内容不一致。' : '当前文件没有与此原稿版本一致的有效最终译文。' } : {}) }
}
