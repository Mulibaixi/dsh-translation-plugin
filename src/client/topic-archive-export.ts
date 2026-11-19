import type { TopicArchiveEntry, TopicArchiveSnapshot } from '../memory/topic-archive.js'
import type { TopicTermSnapshot } from '../memory/topic-terms.js'
import type { HistoryStatus } from './session-store.js'
import { markdownEntityNames, markdownEvidenceLines, topicTermsMarkdownLines, type TopicEvidenceAvailability } from './topic-terms-export.js'
import { assetStatus, assetStatusLabels } from './topic-asset-status.js'

export interface TopicArchiveExport { readonly content: string; readonly fileName: string; readonly mimeType: string }
export interface TopicArchiveExportSnapshot {
  readonly topicName: string; readonly terms: TopicTermSnapshot; readonly archive: TopicArchiveSnapshot; readonly exportedAt: string
  readonly termsStorageStatus: HistoryStatus; readonly archiveStorageStatus: HistoryStatus
  readonly termEvidenceAvailability: readonly TopicEvidenceAvailability[]; readonly archiveEvidenceAvailability: readonly TopicEvidenceAvailability[]
}
const kindLabels = { entity: '实体', fact: '事实', relation: '关系' } as const
function scope(input: TopicArchiveExportSnapshot): void {
  if (input.terms.ownerId !== input.archive.ownerId || input.terms.topicId !== input.archive.topicId) throw new Error('Topic export scope mismatch')
}
function fileName(input: TopicArchiveExportSnapshot, extension: string): string {
  const safe = input.topicName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '')
  return `${[...safe].slice(0, 100).join('') || 'topic'}-archive-${input.exportedAt.replace(/[^0-9TZ]/g, '')}.${extension}`
}
/** The frozen inputs include entry content and reference labels, never referenced evidence bodies. */
export function buildTopicArchiveJsonExport(input: TopicArchiveExportSnapshot): TopicArchiveExport {
  scope(input)
  return { fileName: fileName(input, 'json'), mimeType: 'application/json;charset=utf-8', content: JSON.stringify({
    format: 'dsh-translation-topic-archive', schemaVersion: 1, exportedAt: input.exportedAt,
    ownerId: input.archive.ownerId, topicId: input.archive.topicId, topicName: input.topicName,
    scope: 'existing_topic_structured_snapshots', automaticExtractionTriggered: false, organizationTriggered: false,
    excludes: ['evidence_bodies', 'main_chat', 'complete_topic_backup'],
    storage: { terms: input.termsStorageStatus, archive: input.archiveStorageStatus },
    terms: input.terms, archive: input.archive,
    evidenceAvailability: { terms: input.termEvidenceAvailability, archive: input.archiveEvidenceAvailability },
  }, null, 2) }
}
function md(value: string): string { return value.replace(/[\\`*_{}\[\]()<>#+!|~\-]/g, '\\$&').replace(/\r?\n/g, '  \n  ') }
function semanticLines(snapshot: TopicArchiveSnapshot, entry: TopicArchiveEntry): readonly string[] {
  if (entry.kind === 'entity') return [
    ...(entry.aliases.length ? [`- 别名：${entry.aliases.map(md).join('、')}`] : []),
    ...(entry.description.trim() ? [`- 描述：${md(entry.description)}`] : []),
  ]
  if (entry.kind === 'fact') return [`- 内容：${md(entry.body)}`,
    ...(entry.entityIds.length ? [`- 关联实体：${markdownEntityNames(entry.entityIds, snapshot)}`] : [])]
  return [`- 源实体：${markdownEntityNames(entry.sourceEntityIds, snapshot)}`, `- 目标实体：${markdownEntityNames(entry.targetEntityIds, snapshot)}`,
    ...(entry.description.trim() ? [`- 描述：${md(entry.description)}`] : [])]
}
export function buildTopicArchiveMarkdownExport(input: TopicArchiveExportSnapshot): TopicArchiveExport {
  scope(input)
  const { archive } = input
  const lines = [`# ${md(input.topicName)} · 结构化档案`, '']
  if (input.terms.entries.length) lines.push('## 术语', '',
    ...topicTermsMarkdownLines({ topicName: input.topicName, snapshot: input.terms, exportedAt: input.exportedAt,
      storageStatus: input.termsStorageStatus, evidenceAvailability: input.termEvidenceAvailability }, archive, '###'))
  for (const kind of ['entity', 'fact', 'relation'] as const) {
    const entries = archive.entries.filter(entry => entry.kind === kind)
    if (!entries.length) continue
    lines.push(`## ${kindLabels[kind]}`, '')
    for (const entry of entries) {
      const name = entry.kind === 'entity' ? entry.name : entry.kind === 'fact' ? entry.title : entry.relation
      lines.push(`### ${md(name)}`, '', `- 状态：${assetStatusLabels[assetStatus(entry)]}`, ...semanticLines(archive, entry),
        ...markdownEvidenceLines(entry, input.archiveEvidenceAvailability), '')
    }
  }
  if (!input.terms.entries.length && !archive.entries.length) lines.push('暂无结构化档案。', '')
  return { content: lines.join('\n'), fileName: fileName(input, 'md'), mimeType: 'text/markdown;charset=utf-8' }
}
