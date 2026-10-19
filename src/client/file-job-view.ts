import { h, react } from './react.js'
import type { FileJobProposal } from '../shared/file-jobs.js'
import { FileJobsClient, proposalTitle, type FileJobRecord } from './file-jobs-client.js'
import type { ViewFilesClient } from './view-files-client.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { EvidenceReadResult } from '../shared/translation-evidence.js'
import { proposalPreviousContent } from './file-proposal-revisions.js'
import { assetPriority } from '../memory/asset-priority.js'

export interface FileJobViewProps { readonly fileJobs?: FileJobsClient | undefined }
const phases = { accepted: '已受理', preparing: '准备中', awaiting_baseline_review: '待确认关键语境', translating: '翻译中', checking: '检查中', awaiting_review: '集中验收中', completed: '译文已完成', failed: '任务失败', cancelled: '已取消', unknown: '结果待确认' } as const
const kinds = { term: '术语', entity: '实体', fact: '事实', relation: '关系' } as const

/** A compact delivery row owns version controls; proposal bodies live in the existing asset window. */
export function FileJobView({ jobs, record, viewFiles, materials, onOpenAssets, ownerId }: {
  readonly jobs: FileJobsClient; readonly record: FileJobRecord; readonly viewFiles?: ViewFilesClient | undefined
  readonly materials?: MaterialSubmissionsClient | undefined
  readonly ownerId?: string | undefined
  readonly onOpenAssets?: ((ownerId: string, topicId: string, sessionId?: string, jobId?: string) => void) | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  const [sourceSelection, setSourceSelection] = react.useState<number | undefined>(undefined)
  const [resultSelection, setResultSelection] = react.useState<number | undefined>(undefined)
  const [expanded, setExpanded] = react.useState(false), [versionsExpanded, setVersionsExpanded] = react.useState(false), [removeRequested, setRemoveRequested] = react.useState(false)
  react.useEffect(() => jobs.subscribe(() => refresh(value => value + 1)), [jobs])
  const current = jobs.unitRecord(record.summary.jobId) ?? record, job = current.summary, busy = jobs.isBusy(job.jobId)
  const sourceVersion = sourceSelection ?? job.sourceVersion, resultVersion = resultSelection ?? current.results.at(-1)?.version
  const result = current.results.find(value => value.version === resultVersion), source = current.sources.find(value => value.version === sourceVersion)
  const batches = jobs.all(job.translationSessionId).filter(value => value.summary.unitId === job.unitId && value.summary.proposalBatch?.status === 'reviewed')
  const count = batches.reduce((sum, value) => sum + jobs.pendingCount(value), 0), storage = jobs.status(job.jobId)
  const name = job.sourceRef?.name ?? '原稿.txt', resultName = `${name.replace(/\.txt$/iu, '')}-${job.targetLanguage}-v${resultVersion ?? 1}.txt`
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.phase) || jobs.hostUnavailable(job.jobId)
  const failedWithoutResult = ['failed', 'cancelled'].includes(job.phase) && !current.results.length
  const retranslation = jobs.getRetranslationStatus(job.jobId)
  const awaitingRetranslation = retranslation && retranslation.status !== 'failed'
  const openSource = (): void => { if (viewFiles) void jobs.open(job.jobId, 'source', sourceVersion, viewFiles) }
  const openResult = (): void => { if (viewFiles && resultVersion !== undefined) void jobs.open(job.jobId, 'result', resultVersion, viewFiles) }
  const detailsControl = h('button', { type: 'button', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, expanded ? '收起详情' : '详情')
  const versionsControl = current.results.length > 1 || current.sources.length > 1 ? h('button', { type: 'button', 'aria-expanded': versionsExpanded, onClick: () => setVersionsExpanded(!versionsExpanded) }, `旧版本（${Math.max(0, current.results.length - 1)}）`) : null
  const assetsControl = batches.length ? h('button', { type: 'button', disabled: !onOpenAssets,
    onClick: () => onOpenAssets?.(ownerId ?? job.ownerId, job.topicId, job.translationSessionId, batches.find(value => jobs.pendingCount(value) > 0)?.summary.jobId ?? job.jobId) }, `资产提案${count ? ` · ${count} 条待审` : ' · 已处理'}`) : null
  return h('article', { className: 'dsh-tp-record-unit dsh-tp-file-unit dsh-tp-file-job', 'data-unit-id': job.unitId, 'data-file-job-id': job.jobId, 'data-file-job-phase': job.phase },
    h('div', { className: 'dsh-tp-unit-header' },
      h('span', { role: 'status', className: 'dsh-tp-muted' }, `原文 · ${phases[job.phase]}${job.progress.total ? ` · ${job.progress.completed}/${job.progress.total}` : ''}`),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: busy || !terminal || Boolean(awaitingRetranslation), onClick: () => { void jobs.retranslate(job.jobId, ownerId) } }, '重译'),
        awaitingRetranslation ? h('button', { type: 'button', disabled: busy, onClick: () => { void jobs.queryRetranslation(job.jobId) } }, '检查重译状态') : null,
        h('button', { type: 'button', 'aria-pressed': jobs.isReferenced(job.jobId, ownerId), onClick: () => jobs.toggleReference(job.jobId, ownerId) }, jobs.isReferenced(job.jobId, ownerId) ? '取消参考' : '参考'),
        failedWithoutResult ? h('button', { type: 'button', disabled: busy || Boolean(awaitingRetranslation), title: '沿此原稿与翻译要求，使用当前会话所选模型开始新的翻译。', onClick: () => { void jobs.retranslate(job.jobId, ownerId) } }, '重新发送') : null,
        failedWithoutResult ? h('button', { type: 'button', disabled: busy, onClick: () => setRemoveRequested(true) }, '移除') : null,
        !result ? detailsControl : null, !result ? versionsControl : null,
        h('button', { type: 'button', disabled: busy || !viewFiles || !source, onClick: openSource }, '打开'))),
    h('div', { className: 'dsh-tp-file-name' }, h('button', { type: 'button', className: 'dsh-tp-object-link', disabled: busy || !viewFiles || !source, onClick: openSource }, name)),
    retranslation ? h('p', { role: 'status', className: 'dsh-tp-muted' }, retranslation.message) : null,
    result ? h('div', { className: 'dsh-tp-version-header' },
      h('span', { className: 'dsh-tp-muted', role: 'status' }, `版本 ${result.version} · 译文 · ${job.targetLanguage} · ${current.final?.version === result.version ? '已定稿' : result.semanticStatus === 'passed' ? '待定稿' : '待复核'}`),
      h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
        h('button', { type: 'button', disabled: busy || result.semanticStatus !== 'passed' || current.final?.version === result.version,
          title: result.semanticStatus !== 'passed' ? '须完成集中语义验收后才能设为最终。' : undefined, onClick: () => jobs.selectFinal(job.jobId, result.version) }, current.final?.version === result.version ? '已定稿' : '设为最终'),
        assetsControl, detailsControl, versionsControl, h('button', { type: 'button', disabled: busy || !viewFiles, onClick: openResult }, '打开'))) : assetsControl,
    result ? h('div', { className: 'dsh-tp-file-name' }, h('button', { type: 'button', className: 'dsh-tp-object-link', disabled: busy || !viewFiles, onClick: openResult }, resultName)) : null,
    current.final && current.final.version !== result?.version ? h('p', { className: 'dsh-tp-muted', role: 'status' }, `原最终保留：版本 ${current.final.version}。`) : null,
    removeRequested ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '移除失败文件单元' },
      h('p', null, '移除此单元；原稿依据、调用事实和主题资产仍保留。'),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => { void jobs.remove(job.jobId).finally(() => setRemoveRequested(false)) } }, '确认移除'),
        h('button', { type: 'button', disabled: busy, onClick: () => setRemoveRequested(false) }, '取消'))) : null,
    versionsExpanded ? h('div', { className: 'dsh-tp-actions dsh-tp-file-versions' },
      current.sources.length > 1 ? h('select', { 'aria-label': '原稿版本', value: sourceVersion, onChange: (event: { currentTarget: { value: string } }) => setSourceSelection(Number(event.currentTarget.value)) },
        ...current.sources.map(value => h('option', { key: value.version, value: value.version }, `原稿版本 ${value.version}`))) : null,
      h('select', { 'aria-label': '译文版本', value: resultVersion ?? '', onChange: (event: { currentTarget: { value: string } }) => setResultSelection(Number(event.currentTarget.value)) },
        ...current.results.map(value => h('option', { key: value.version, value: value.version }, `版本 ${value.version}${current.final?.version === value.version ? ' · 最终' : ''}${value.semanticStatus === 'passed' ? ' · 已复核' : ' · 待复核'}`)))) : null,
    expanded ? h('div', { className: 'dsh-tp-file-details' },
      h('p', { className: 'dsh-tp-muted' }, `原稿版本 ${sourceVersion} · ${storage.saved ? '已保存' : '仅本次运行或保存中'}${current.final?.selection === 'user_fixed' ? ' · 最终版本由用户固定' : ''}`),
      !terminal ? h('button', { type: 'button', disabled: busy, onClick: () => { void jobs.cancel(job.jobId) } }, '取消任务') : null,
      result ? h('div', { className: 'dsh-tp-translation-text dsh-tp-file-job-text' }, result.text) : null) : null,
    job.error ? h('p', { className: 'dsh-tp-message', role: 'alert' }, `${job.error.stage}：${job.error.message}`) : null,
    jobs.hostUnavailable(job.jobId) ? h('p', { className: 'dsh-tp-muted', role: 'status' }, '当前宿主没有此任务；已保存版本可继续查阅。') : null,
    storage.error ? h('p', { className: 'dsh-tp-message', role: 'alert' }, storage.error) : null,
    jobs.getNotice() ? h('p', { className: 'dsh-tp-muted', role: 'status' }, jobs.getNotice()) : null,
  )
}

function ProposalEditor({ proposal, entities, onChange }: { readonly proposal: FileJobProposal; readonly entities: readonly FileJobProposal[]; readonly onChange: (proposal: FileJobProposal) => void }): unknown {
  const field = (label: string, value: string, change: (value: string) => FileJobProposal, multiline = false): unknown => h('label', { className: 'dsh-tp-file-card-field' }, label,
    h(multiline ? 'textarea' : 'input', { value, rows: multiline ? 3 : undefined, 'aria-label': label, onChange: (event: { currentTarget: { value: string } }) => onChange(change(event.currentTarget.value)) }))
  if (proposal.kind === 'term') return h('div', null, field('原词（每行一个）', proposal.sourceForms.join('\n'), value => ({ ...proposal, sourceForms: value.split('\n').map(value => value.trim()).filter(Boolean) }), true),
    field('译法', proposal.preferred, value => ({ ...proposal, preferred: value })), field('说明', proposal.description, value => ({ ...proposal, description: value }), true))
  if (proposal.kind === 'entity') return h('div', null, field('名称', proposal.name, value => ({ ...proposal, name: value })),
    field('别名（每行一个）', proposal.aliases.join('\n'), value => ({ ...proposal, aliases: value.split('\n').map(value => value.trim()).filter(Boolean) }), true), field('描述', proposal.description, value => ({ ...proposal, description: value }), true))
  if (proposal.kind === 'fact') return h('div', null, field('标题', proposal.title, value => ({ ...proposal, title: value })), field('事实陈述', proposal.body, value => ({ ...proposal, body: value }), true))
  const entity = (label: string, id: string, change: (value: string) => FileJobProposal): unknown => h('label', { className: 'dsh-tp-file-card-field' }, label,
    h('select', { value: id, 'aria-label': label, onChange: (event: { currentTarget: { value: string } }) => onChange(change(event.currentTarget.value)) },
      ...entities.filter(value => value.kind === 'entity').map(value => h('option', { key: value.candidateId, value: value.candidateId }, proposalTitle(value)))))
  return h('div', null, entity('主体', proposal.sourceEntityCandidateId, value => ({ ...proposal, sourceEntityCandidateId: value })),
    field('关系', proposal.relation, value => ({ ...proposal, relation: value })), entity('客体', proposal.targetEntityCandidateId, value => ({ ...proposal, targetEntityCandidateId: value })), field('说明', proposal.description, value => ({ ...proposal, description: value }), true))
}

function ProposalCard({ jobs, record, proposal, reviews, selected, onSelect }: { readonly jobs: FileJobsClient; readonly record: FileJobRecord; readonly proposal: FileJobProposal; readonly reviews: import('./file-proposal-revisions.js').FileProposalReviews; readonly selected: boolean; readonly onSelect: (selected: boolean) => void }): unknown {
  const state = record.cards.find(card => card.candidateId === proposal.candidateId), current = state?.status === 'adopted' ? state.adoptedProposal ?? state.draft ?? proposal : state?.draft ?? proposal
  const draftStale = !!state?.draft && state.draftBatchVersion !== record.proposalVersion
  const [editing, setEditing] = react.useState(false), [evidence, setEvidence] = react.useState<readonly EvidenceReadResult[] | undefined>(undefined)
  const active = state?.status === 'adopted', busy = jobs.isBusy(record.summary.jobId), entities = record.proposals.filter(value => value.kind === 'entity')
  const review = reviews[proposal.candidateId]
  const entityName = (id: string): string => { const entity = entities.find(value => value.candidateId === id); return entity ? proposalTitle(record.cards.find(value => value.candidateId === id)?.draft ?? entity) : '缺少实体' }
  async function showEvidence(): Promise<void> {
    if (evidence) { setEvidence(undefined); return }
    setEvidence(await Promise.all(current.evidence.map(async value => {
      const ref: import('../memory/topic-terms.js').TermEvidenceRef = { kind: 'source', sessionId: record.summary.translationSessionId, unitId: record.summary.unitId,
        sourceVersion: record.summary.sourceVersion, revisionId: null, selectionEventId: null, range: value.range, role: 'basis' }
      const captured = jobs.capture(record.summary.ownerId, record.summary.topicId, ref)
      return 'status' in captured ? captured : jobs.read(captured)
    })))
  }
  return h('article', { className: 'dsh-tp-file-card', 'data-candidate-id': current.candidateId },
    h('div', { className: 'dsh-tp-unit-header' }, h('label', null, h('input', { type: 'checkbox', checked: selected, disabled: active || busy || proposal.disposition === 'rejected',
      onChange: (event: { currentTarget: { checked: boolean } }) => onSelect(event.currentTarget.checked) }), ` ${kinds[current.kind]} · ${proposalTitle(current)}`),
      h('small', { className: 'dsh-tp-muted' }, active ? '已采纳' : state?.status === 'rejected' || proposal.disposition === 'rejected' ? '不采用' : '待审')),
    h('small', { className: 'dsh-tp-muted' }, `${current.origin === 'inferred' ? '模型推断' : '原文依据'}${state?.draft ? ' · 已编辑' : ''} · 原稿版本 ${record.summary.sourceVersion}`),
    !active && review?.kind === 'update' ? h('div', { className: 'dsh-tp-file-card-revision' },
      h('p', null, `更新既有条目 · 版本 ${review.entry.version} → ${review.entry.version + 1}${assetPriority(review.entry) === 2 ? ' · 用户固定条目' : assetPriority(review.entry) === 1 ? ' · 用户已审条目' : ''}`),
      h('details', null, h('summary', null, '查看原条目'), h('div', { className: 'dsh-tp-file-card-content' }, proposalPreviousContent(review.entry))))
      : !active && review?.kind === 'blocked' ? h('p', { role: 'alert', className: 'dsh-tp-message' }, review.message)
        : !active ? h('small', { className: 'dsh-tp-muted' }, '新增条目') : null,
    editing ? h(ProposalEditor, { proposal: current, entities, onChange: (value: FileJobProposal) => jobs.edit(record.summary.jobId, value) })
      : h('div', { className: 'dsh-tp-file-card-content' }, current.kind === 'term' ? `${current.sourceForms.join('、')} → ${current.preferred}${current.description ? `\n${current.description}` : ''}`
        : current.kind === 'entity' ? `${current.aliases.length ? `别名：${current.aliases.join('、')}\n` : ''}${current.description}`
          : current.kind === 'fact' ? `${current.body}${current.entityCandidateIds.length ? `\n相关实体：${current.entityCandidateIds.map(entityName).join('、')}` : ''}`
            : `${entityName(current.sourceEntityCandidateId)} → ${current.relation} → ${entityName(current.targetEntityCandidateId)}${current.description ? `\n${current.description}` : ''}`),
    state?.message ? h('p', { role: 'alert', className: 'dsh-tp-message' }, state.message) : null,
    draftStale || state?.status === 'adopted' && state.adoptedProposal && JSON.stringify(state.adoptedProposal) !== JSON.stringify(proposal) ? h('details', null,
      h('summary', null, '查看主模型更新后的提案'), h('div', { className: 'dsh-tp-file-card-content' }, proposal.kind === 'term' ? `${proposal.sourceForms.join('、')} → ${proposal.preferred}\n${proposal.description}`
        : proposal.kind === 'entity' ? `${proposal.name}\n${proposal.description}` : proposal.kind === 'fact' ? `${proposal.title}\n${proposal.body}` : `${entityName(proposal.sourceEntityCandidateId)} → ${proposal.relation} → ${entityName(proposal.targetEntityCandidateId)}\n${proposal.description}`),
      draftStale && !active ? h('button', { type: 'button', onClick: () => { jobs.discardDraft(record.summary.jobId, proposal.candidateId); setEditing(false) } }, '使用新提案') : null) : null,
    h('div', { className: 'dsh-tp-actions' },
      h('button', { type: 'button', disabled: active || busy || proposal.disposition === 'rejected' || review?.kind === 'blocked', onClick: () => { void jobs.adopt(record.summary.jobId, [current.candidateId], reviews) } }, review?.kind === 'update' && !active ? '采纳新版本' : '采纳'),
      h('button', { type: 'button', disabled: active || busy || proposal.disposition === 'rejected', onClick: () => setEditing(!editing) }, editing ? '完成编辑' : '编辑'),
      h('button', { type: 'button', disabled: active || busy, onClick: () => jobs.reject(record.summary.jobId, [current.candidateId]) }, '不采用'),
      h('button', { type: 'button', onClick: () => { void showEvidence() }, 'aria-expanded': !!evidence }, evidence ? '收起依据' : '查看依据')),
    evidence ? h('div', { className: 'dsh-tp-file-card-evidence' }, ...evidence.map((value, index) => h('div', { key: index, className: 'dsh-tp-translation-text' }, value.status === 'ready' ? value.text : '此依据暂不可读取。'))) : null)
}

function ProposalBatch({ jobs, record, kind }: { readonly jobs: FileJobsClient; readonly record: FileJobRecord; readonly kind: 'all' | FileJobProposal['kind'] }): unknown {
  const [selected, setSelected] = react.useState(() => new Set<string>()), [comment, setComment] = react.useState(''), [page, setPage] = react.useState(0)
  react.useEffect(() => { setSelected(new Set()); setPage(0) }, [kind])
  const rank = (proposal: FileJobProposal): number => record.cards.find(card => card.candidateId === proposal.candidateId)?.status === 'adopted' ? 2
    : proposal.disposition === 'rejected' || record.cards.find(card => card.candidateId === proposal.candidateId)?.status === 'rejected' ? 1 : 0
  const displayed = record.proposals.filter(proposal => kind === 'all' || proposal.kind === kind).sort((left, right) => rank(left) - rank(right))
  const eligible = displayed.filter(proposal => rank(proposal) === 0)
  const ids = [...selected].filter(id => eligible.some(proposal => proposal.candidateId === id)), busy = jobs.isBusy(record.summary.jobId)
  const allSelected = eligible.length > 0 && ids.length === eligible.length
  const reviews = jobs.proposalReviews(record)
  const pages = Math.max(1, Math.ceil(displayed.length / 40)), currentPage = Math.min(page, pages - 1)
  return h('section', { className: 'dsh-tp-file-proposal-batch', 'data-file-job-id': record.summary.jobId },
    h('h3', null, `${record.summary.sourceRef?.name ?? '文件翻译'} · ${eligible.length} 条待审`),
    h('small', { className: 'dsh-tp-muted' }, '采纳事实或关系时一并采纳所需实体；保留原文依据与模型归属，后续可在档案中查阅。'),
    h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: busy || !eligible.length, 'aria-pressed': allSelected,
      onClick: () => setSelected(allSelected ? new Set() : new Set(eligible.map(proposal => proposal.candidateId))) }, allSelected ? '取消全选' : '全选待审'),
      h('button', { type: 'button', disabled: busy || !ids.length, onClick: () => { void jobs.adopt(record.summary.jobId, ids, reviews) } }, `采纳所选${ids.length ? `（${ids.length}）` : ''}`),
      h('button', { type: 'button', disabled: busy || !ids.length, onClick: () => { jobs.reject(record.summary.jobId, ids); setSelected(new Set()) } }, '不采用所选')),
    !displayed.length ? h('p', { className: 'dsh-tp-muted' }, '此文件暂无该类型提案。') : null,
    ...displayed.slice(currentPage * 40, currentPage * 40 + 40).map(proposal => h(ProposalCard, { key: proposal.candidateId, jobs, record, proposal, reviews, selected: ids.includes(proposal.candidateId),
      onSelect: (checked: boolean) => setSelected(value => { const next = new Set(value); if (checked) next.add(proposal.candidateId); else next.delete(proposal.candidateId); return next }) })),
    pages > 1 ? h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: currentPage === 0, onClick: () => setPage(currentPage - 1) }, '上一页'),
      h('span', null, `${currentPage + 1}/${pages} · 共 ${displayed.length} 条`), h('button', { type: 'button', disabled: currentPage + 1 >= pages, onClick: () => setPage(currentPage + 1) }, '下一页')) : null,
    h('label', { className: 'dsh-tp-file-card-field' }, '所选卡片的意见', h('textarea', { rows: 2, value: comment, 'aria-label': '所选资产意见', onChange: (event: { currentTarget: { value: string } }) => setComment(event.currentTarget.value) })),
    h('button', { type: 'button', disabled: busy || !ids.length || !comment.trim(), onClick: () => { void jobs.feedback(record.summary.jobId, ids, comment) } }, '合并提交意见'))
}

export function FileJobAssetsView({ jobs, topicId, jobId, navigationRevision }: { readonly jobs: FileJobsClient; readonly topicId: string; readonly sessionId?: string | undefined; readonly jobId?: string | undefined; readonly navigationRevision?: number | undefined }): unknown {
  const [, refresh] = react.useState(0)
  const [selectedJob, setSelectedJob] = react.useState<string | undefined>(undefined), [kind, setKind] = react.useState<'all' | FileJobProposal['kind']>('all')
  react.useEffect(() => jobs.subscribe(() => refresh(value => value + 1)), [jobs])
  react.useEffect(() => { setSelectedJob(undefined); setKind('all') }, [jobId, topicId, navigationRevision])
  const records = jobs.all(undefined, topicId).filter(record => record.summary.proposalBatch?.status === 'reviewed' && !record.summary.removedAt)
    .sort((left, right) => Date.parse(right.summary.createdAt) - Date.parse(left.summary.createdAt))
  const record = records.find(record => record.summary.jobId === (selectedJob ?? jobId)) ?? records[0]
  return h('section', { 'aria-label': '文件资产提案', className: 'dsh-tp-file-proposals' },
    records.length ? null : h('p', { className: 'dsh-tp-muted' }, '尚无已完成集中验收的文件资产提案。'),
    record ? h('div', { className: 'dsh-tp-actions' }, h('label', null, '提案文件 ', h('select', { 'aria-label': '提案文件', value: record.summary.jobId,
      onChange: (event: { currentTarget: { value: string } }) => setSelectedJob(event.currentTarget.value) },
      ...records.map(record => h('option', { key: record.summary.jobId, value: record.summary.jobId }, `${record.summary.sourceRef?.name ?? '文件翻译'} · ${new Date(record.summary.createdAt).toLocaleString()}`)))),
      h('label', null, '提案类型 ', h('select', { 'aria-label': '提案类型', value: kind, onChange: (event: { currentTarget: { value: string } }) => {
        const value = event.currentTarget.value
        if (value === 'all' || value === 'term' || value === 'entity' || value === 'relation' || value === 'fact') setKind(value)
      } }, ...(['all', 'term', 'entity', 'relation', 'fact'] as const).map(value => h('option', { key: value, value }, value === 'all' ? '全部' : kinds[value]))))) : null,
    record ? h(ProposalBatch, { key: record.summary.jobId, jobs, record, kind }) : null,
    jobs.getNotice() ? h('p', { className: 'dsh-tp-message', role: 'status' }, jobs.getNotice()) : null)
}
