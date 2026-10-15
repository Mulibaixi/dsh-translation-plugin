import type { TopicTermSnapshot, TermEvidenceRef } from '../memory/topic-terms.js'
import type { HistoryStatus } from './session-store.js'

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
  readonly rememberHistory: boolean
  readonly storageStatus: HistoryStatus
  readonly evidenceAvailability: readonly TopicEvidenceAvailability[]
}

const statusLabels = { proposal: '待确认', active: '生效', conflict: '有冲突', review_required: '待复核', disabled: '已停用' } as const
const originLabels = { inferred: '模型提案', source_checked: '原文依据', reference_derived: '参考资料（主模型解读）', user_explicit: '用户采用' } as const
const storageLabels = { memory: '仅本次运行', saved: '已保存', conflict: '存在存储冲突，当前快照可能与已保存副本不同', error: '保存失败，当前快照不代表已可靠落盘' } as const

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
      storage: { rememberHistory: input.rememberHistory, status: input.storageStatus },
      snapshot, evidenceAvailability: input.evidenceAvailability,
    }, null, 2),
  }
}

function md(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+!|~\-]/g, '\\$&').replace(/\r?\n/g, '  \n  ')
}
function referenceLines(ref: TermEvidenceRef): string[] {
  if (ref.kind === 'reference') return ['参考资料：' + md(ref.referenceId), '片段：' + md(ref.segmentId) + '；来源为主模型解读；不等于用户确认', `范围：${ref.range ? `[${ref.range.start}, ${ref.range.end})（Unicode 码点）` : '完整片段'}`]
  return [
    `类型：${ref.kind === 'source' ? '原文' : '最终译文'}；用途：${ref.role === 'basis' ? '依据' : '示例'}`,
    `会话 ID：${md(ref.sessionId)}；单元 ID：${md(ref.unitId)}`,
    `版本 ID：${ref.revisionId === null ? '无' : md(ref.revisionId)}；最终选择事件 ID：${ref.selectionEventId === null ? '无' : md(ref.selectionEventId)}`,
    `范围：${ref.range === null ? '完整引用' : `[${ref.range.start}, ${ref.range.end})（Unicode 码点）`}`,
  ]
}

export function buildTopicTermsMarkdownExport(input: TopicTermsExportSnapshot): TopicTermsExport {
  const { snapshot } = input
  const lines = [
    `# ${md(input.topicName)} · 主题术语快照`, '',
    '仅导出现有术语档案，未触发自动提炼或整理。包含所有状态的条目及证据引用，不包含来源正文、主聊天或完整主题备份。', '',
    `- 导出时间：${md(input.exportedAt)}`,
    `- 所属主会话 ID：${md(snapshot.ownerId)}`,
    `- 主题 ID：${md(snapshot.topicId)}`,
    `- 档案版本：${snapshot.version}；生效集版本：${snapshot.activeVersion}`,
    `- 档案更新时间：${md(snapshot.updatedAt)}`,
    `- 历史保存开关：${input.rememberHistory ? '开启' : '关闭'}；实际保存状态：${storageLabels[input.storageStatus]}`,
    '- 保存开关表示保存策略；本文件记录点击导出时的内存快照。', '',
  ]
  if (snapshot.entries.length === 0) lines.push('暂无术语。', '')
  for (const entry of snapshot.entries) {
    lines.push(`## ${md(entry.sourceForms.join('、'))} → ${md(entry.preferred)}`, '',
      `- 条目 ID：${md(entry.id)}；版本：${entry.version}`,
      `- 状态：${statusLabels[entry.status]}（${entry.status}）；来源：${originLabels[entry.origin]}（${entry.origin}）`,
      `- 语言：${md(entry.sourceLanguage ?? '未指定')} → ${md(entry.targetLanguage)}`,
      `- 原文形式：${entry.sourceForms.map(md).join('、')}`,
      `- 首选译法：${md(entry.preferred)}`,
      `- 义项：${md(entry.sense) || '未提供'}`,
      `- 别名：${entry.aliases.map(md).join('、') || '无'}`,
      `- 避免译法：${entry.forbidden.map(md).join('、') || '无'}`,
      `- 创建：${md(entry.createdAt)}；更新：${md(entry.updatedAt)}`,
      entry.confirmation ? `- 用户确认：事件 ${md(entry.confirmation.eventId)}；时间 ${md(entry.confirmation.at)}；采用前条目版本 ${entry.confirmation.adoptedEntryVersion}` : '- 用户确认：无', '',
      '### 证据引用', '')
    if (entry.evidence.length === 0) lines.push('无证据引用。', '')
    entry.evidence.forEach((ref, index) => {
      const availability = input.evidenceAvailability.find(value => value.entryId === entry.id && value.evidenceIndex === index)
      const label = availability?.sourceLabel ?? (availability ? `${availability.sessionName ?? '会话不可用'} · ${availability.unitOrder === null ? '单元不可用' : `文本 ${availability.unitOrder}`}${availability.revisionOrder === null ? '' : ` · 版本 ${availability.revisionOrder}`}` : '来源标签未提供')
      lines.push(`#### 引用 ${index + 1}`, '', `- 来源：${md(label)}`,
        `- 冻结时可读性：${availability?.readability === 'not_loaded' ? '本次未读取参考片段，未确认可读性（正文未导出）' : availability ? availability.readable ? '可读（正文未导出）' : '依据已变化或不可用（正文未导出）' : '未提供，无法确认来源是否可读'}`,
        ...referenceLines(ref).map(line => `- ${line}`), '')
    })
  }
  return { content: lines.join('\n'), fileName: fileName(input, 'md'), mimeType: 'text/markdown;charset=utf-8' }
}
