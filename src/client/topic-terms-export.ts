import type { TopicTermSnapshot, TermEvidenceRef } from '../memory/topic-terms.js'
import type { TopicArchiveSnapshot } from '../memory/topic-archive.js'
import type { HistoryStatus } from './session-store.js'
import { assetStatus, assetStatusLabels } from './topic-asset-status.js'

export interface TopicTermsExport {
  readonly content: string
  readonly fileName: string
  readonly mimeType: string
}

/** Only reference labels and availability cross this boundary, never evidence bodies. */
export interface TopicEvidenceAvailability {
  readonly entryId: string
  readonly evidenceIndex: number
  readonly sessionName: string | null
  readonly unitOrder: number | null
  readonly revisionOrder: number | null
  readonly readable: boolean
  readonly sourceLabel?: string
  readonly readability?: 'not_loaded'
}

export interface TopicTermsExportSnapshot {
  readonly topicName: string
  readonly snapshot: TopicTermSnapshot
  readonly exportedAt: string

  readonly storageStatus: HistoryStatus
  readonly evidenceAvailability: readonly TopicEvidenceAvailability[]
}

function fileName(input: TopicTermsExportSnapshot, extension: string): string {
  const safeName = input.topicName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '')
  const name = [...safeName].slice(0, 100).join('') || 'topic'
  return `${name}-terms-${input.exportedAt.replace(/[^0-9TZ]/g, '')}.${extension}`
}

export function buildTopicTermsJsonExport(input: TopicTermsExportSnapshot): TopicTermsExport {
  const { snapshot } = input
  return {
    fileName: fileName(input, 'json'), mimeType: 'application/json;charset=utf-8',
    content: JSON.stringify({
      format: 'dsh-translation-topic-terms', schemaVersion: 1, exportedAt: input.exportedAt,
      ownerId: snapshot.ownerId, topicId: snapshot.topicId, topicName: input.topicName,
      scope: 'existing_topic_terms_snapshot',
      automaticExtractionTriggered: false, organizationTriggered: false,
      excludes: ['evidence_bodies', 'main_chat', 'complete_topic_backup'],
      storage: { status: input.storageStatus },
      snapshot, evidenceAvailability: input.evidenceAvailability,
    }, null, 2),
  }
}

function md(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+!|~\-]/g, '\\$&').replace(/\r?\n/g, '  \n  ')
}
export function markdownEntityNames(ids: readonly string[], archive?: TopicArchiveSnapshot): string {
  return ids.map(id => {
    const entity = archive?.entries.find(entry => entry.id === id && entry.kind === 'entity')
    return entity?.kind === 'entity' ? md(entity.name) : '实体不可用'
  }).join('、')
}

export function markdownEvidenceLines(entry: { readonly id: string; readonly evidence: readonly TermEvidenceRef[] },
  availability: readonly TopicEvidenceAvailability[]): readonly string[] {
  const labels = entry.evidence.map((ref, index) => {
    const source = availability.find(value => value.entryId === entry.id && value.evidenceIndex === index)
    return [source?.sourceLabel ?? source?.sessionName ?? '来源不可用',
      ...(source?.unitOrder ? [`单元 ${source.unitOrder}`] : []), ref.kind === 'source' ? '原文' : '译文'].join(' · ')
  })
  return [...new Set(labels)].map(label => `- 来源：${md(label)}`)
}

export function topicTermsMarkdownLines(input: TopicTermsExportSnapshot, archive: TopicArchiveSnapshot | undefined,
  heading: '##' | '###'): readonly string[] {
  const lines: string[] = []
  for (const entry of input.snapshot.entries) {
    lines.push(`${heading} ${md(entry.sourceForms.join('、'))} → ${md(entry.preferred)}`, '',
      `- 状态：${assetStatusLabels[assetStatus(entry)]}`,
      `- 语言：${md(entry.sourceLanguage ?? '任意源语言')} → ${md(entry.targetLanguage)}`,
      ...(entry.sense.trim() ? [`- 说明：${md(entry.sense)}`] : []),
      ...(entry.aliases.length ? [`- 别名：${entry.aliases.map(md).join('、')}`] : []),
      ...(entry.forbidden.length ? [`- 避免译法：${entry.forbidden.map(md).join('、')}`] : []),
      ...(entry.entityIds?.length ? [`- 关联实体：${markdownEntityNames(entry.entityIds, archive)}`] : []),
      ...markdownEvidenceLines(entry, input.evidenceAvailability), '')
  }
  return lines
}

export function buildTopicTermsMarkdownExport(input: TopicTermsExportSnapshot, archive?: TopicArchiveSnapshot): TopicTermsExport {
  const lines = [`# ${md(input.topicName)} · 术语档案`, '', ...topicTermsMarkdownLines(input, archive, '##')]
  if (!input.snapshot.entries.length) lines.push('暂无术语。', '')
  return { content: lines.join('\n'), fileName: fileName(input, 'md'), mimeType: 'text/markdown;charset=utf-8' }
}
