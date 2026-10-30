import { h, react } from './react.js'
import { FileJobsClient, type FileJobRecord } from './file-jobs-client.js'
import type { ViewFilesClient } from './view-files-client.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import { RecordIndexControl, RecordIndexStatus, supportsRecordIndex, type RecordIndexProps } from './record-index-view.js'

export interface FileJobViewProps extends RecordIndexProps { readonly fileJobs?: FileJobsClient | undefined }
const phases = { accepted: '已受理', preparing: '准备中', awaiting_baseline_review: '待确认关键语境', translating: '翻译中', checking: '检查中', awaiting_review: '集中验收中', completed: '译文已完成', failed: '任务失败', cancelled: '已取消', unknown: '结果待确认' } as const

/** A compact delivery row owns version controls and links to the topic assets. */
export function FileJobView({ jobs, record, viewFiles, materials, onOpenAssets, ownerId, unitNumber, recordIndex, visible = true }: RecordIndexProps & {
  readonly jobs: FileJobsClient; readonly record: FileJobRecord; readonly viewFiles?: ViewFilesClient | undefined
  readonly materials?: MaterialSubmissionsClient | undefined
  readonly ownerId?: string | undefined
  readonly unitNumber?: number | undefined
  readonly visible?: boolean | undefined
  readonly onOpenAssets?: ((ownerId: string, topicId: string, sessionId?: string, jobId?: string) => void) | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  const [sourceSelection, setSourceSelection] = react.useState<number | undefined>(undefined)
  const [resultSelection, setResultSelection] = react.useState<number | undefined>(undefined)
  const [expanded, setExpanded] = react.useState(false), [versionsExpanded, setVersionsExpanded] = react.useState(false)
  const [deletePlan, setDeletePlan] = react.useState<import('./session-store.js').TextUnitDeletionPlan | undefined>(undefined)
  const [resultDeletePlan, setResultDeletePlan] = react.useState<(import('./session-store.js').TextUnitDeletionPlan & { readonly resultVersion: number }) | undefined>(undefined)
  const [sourceDeletePlan, setSourceDeletePlan] = react.useState<(import('./session-store.js').TextUnitDeletionPlan & { readonly sourceVersion: number }) | undefined>(undefined)
  const [deleting, setDeleting] = react.useState(false)
  react.useEffect(() => jobs.subscribe(() => refresh(value => value + 1)), [jobs])
  const current = jobs.unitRecord(record.summary.jobId)
  if (!current) return h('p', { role: 'status', className: 'dsh-tp-muted' }, '文件单元已删除或暂不可用。')
  const job = current.summary, busy = jobs.isBusy(job.jobId)
  const sourceVersion = sourceSelection ?? job.sourceVersion, resultVersion = resultSelection ?? current.results.at(-1)?.version
  const result = current.results.find(value => value.version === resultVersion), source = current.sources.find(value => value.version === sourceVersion)
  const records = jobs.all(job.translationSessionId).filter(value => value.summary.unitId === job.unitId)
  const resultLanguage = result && records.find(record => record.summary.sourceVersion === result.sourceVersion && record.results.some(value => value.version === result.version && value.text === result.text))?.summary.targetLanguage || job.targetLanguage
  const storage = jobs.status(job.jobId)
  const name = job.sourceRef?.name ?? '原稿.txt', resultName = `${name.replace(/\.txt$/iu, '')}-${resultLanguage}-v${resultVersion ?? 1}.txt`
  const indexTarget = supportsRecordIndex(name) ? { namespaceId: jobs.getNamespaceId(), topicId: job.topicId, sessionId: job.translationSessionId, unitId: job.unitId, sourceVersion: job.sourceVersion } : undefined
  const mainSessionId = ownerId && ownerId !== jobs.getNamespaceId() ? ownerId : undefined
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.phase) || jobs.hostUnavailable(job.jobId)
  const failedWithoutResult = ['failed', 'cancelled'].includes(job.phase) && !current.results.length
  const canExecute = jobs.canExecute(ownerId)
  const retranslation = jobs.getRetranslationStatus(job.jobId)
  const awaitingRetranslation = retranslation && retranslation.status !== 'failed'
  const deletionBlocked = jobs.unitDeletionBlockedReason(job.jobId)
  const resultDeletionBlocked = result && jobs.resultDeletionBlockedReason(job.jobId, result.version)
  const sourceDeletionBlocked = jobs.sourceDeletionBlockedReason(job.jobId, sourceVersion)
  const openSource = (): void => { if (viewFiles) void jobs.open(job.jobId, 'source', sourceVersion, viewFiles) }
  const openResult = (): void => { if (viewFiles && resultVersion !== undefined) void jobs.open(job.jobId, 'result', resultVersion, viewFiles) }
  const detailsControl = h('button', { type: 'button', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, expanded ? '收起详情' : '详情')
  const versionsControl = current.results.length > 1 || current.sources.length > 1 ? h('button', { type: 'button', 'aria-expanded': versionsExpanded, onClick: () => setVersionsExpanded(!versionsExpanded) }, `旧版本（${Math.max(0, current.results.length - 1)}）`) : null
  const assetsControl = onOpenAssets ? h('button', { type: 'button',
    onClick: () => onOpenAssets(ownerId ?? jobs.getNamespaceId(), job.topicId, job.translationSessionId) }, '记忆资产') : null
  return h('article', { className: 'dsh-tp-record-unit dsh-tp-file-unit dsh-tp-file-job', 'data-unit-id': job.unitId, 'data-file-job-id': job.jobId, 'data-file-job-phase': job.phase },
    h('div', { className: 'dsh-tp-unit-header' },
      h('span', { role: 'status', className: 'dsh-tp-muted' }, `${unitNumber ? `单元 ${unitNumber} · 文件` : '文件材料'} · ${phases[job.phase]}${job.progress.total ? ` · ${job.progress.completed}/${job.progress.total}` : ''}`, h(RecordIndexStatus, { client: recordIndex, target: indexTarget, visible, prefix: ' · ' })),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: true, title: '旧文件任务不再启动重译；请重新发送原稿，使用当前翻译流程。', onClick: () => { void jobs.retranslate(job.jobId, ownerId) } }, '重译'),
        h(RecordIndexControl, { client: recordIndex, target: indexTarget, mainSessionId, visible, disabled: busy || !current.final }),
        awaitingRetranslation ? h('button', { type: 'button', disabled: busy, onClick: () => { void jobs.queryRetranslation(job.jobId) } }, '检查重译状态') : null,
        failedWithoutResult ? h('button', { type: 'button', disabled: true, title: '请重新发送原稿，使用当前翻译流程。', onClick: () => { void jobs.retranslate(job.jobId, ownerId) } }, '重新发送') : null,
        h('button', { type: 'button', disabled: busy || deleting || !!deletionBlocked || Boolean(awaitingRetranslation), title: deletionBlocked, onClick: () => setDeletePlan(jobs.captureUnitDeletion(job.jobId)) }, '删除单元'),
        !result ? detailsControl : null, !result ? versionsControl : null,
        h('button', { type: 'button', disabled: busy || !viewFiles || !source || !!source.deletion, onClick: openSource }, '打开'))),
    h('div', { className: 'dsh-tp-file-name' }, h('button', { type: 'button', className: 'dsh-tp-object-link', disabled: busy || !viewFiles || !source || !!source.deletion, onClick: openSource }, name)),
    retranslation ? h('p', { role: 'status', className: 'dsh-tp-muted' }, retranslation.message) : null,
    result ? h('div', { className: 'dsh-tp-version-header' },
      h('span', { className: 'dsh-tp-muted', role: 'status' }, `版本 ${result.version} · 译文 · ${resultLanguage} · ${result.deletion ? '已删除' : current.final?.version === result.version ? '已定稿' : result.semanticStatus === 'passed' ? '待定稿' : '待复核'}`),
      h('div', { className: 'dsh-tp-actions dsh-tp-version-actions' },
        h('button', { type: 'button', disabled: busy || !!result.deletion || result.semanticStatus !== 'passed' || result.sourceVersion !== job.sourceVersion || current.final?.version === result.version,
          title: result.sourceVersion !== job.sourceVersion ? '此译文属于其他原稿版本。' : result.semanticStatus !== 'passed' ? '须完成集中语义验收后才能设为最终。' : undefined, onClick: () => jobs.selectFinal(job.jobId, result.version) }, current.final?.version === result.version ? '已定稿' : '设为最终'),
        h('button', { type: 'button', disabled: busy || deleting || !!resultDeletionBlocked, title: resultDeletionBlocked, onClick: () => setResultDeletePlan(jobs.captureResultDeletion(job.jobId, result.version)) }, '删除此译文版本'),
        assetsControl, detailsControl, versionsControl, h('button', { type: 'button', disabled: busy || !!result.deletion || !viewFiles, onClick: openResult }, '打开'))) : assetsControl,
    result && !result.deletion ? h('div', { className: 'dsh-tp-file-name' }, h('button', { type: 'button', className: 'dsh-tp-object-link', disabled: busy || !viewFiles, onClick: openResult }, resultName)) : null,
    current.final && current.final.version !== result?.version ? h('p', { className: 'dsh-tp-muted', role: 'status' }, `原最终保留：版本 ${current.final.version}。`) : null,
    deletePlan ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '删除文件单元确认' },
      h('p', null, '删除此文件单元及其全部原稿、译文版本和从属任务记录？保留编号和调用统计；其他记录或参考资料仍在使用的原件会保留。'),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: busy || deleting, onClick: () => { setDeleting(true); void jobs.deleteUnit(deletePlan).finally(() => { setDeleting(false); setDeletePlan(undefined) }) } }, deleting ? '正在删除…' : '确认删除文件单元'),
        h('button', { type: 'button', disabled: busy || deleting, onClick: () => setDeletePlan(undefined) }, '取消'))) : null,
    resultDeletePlan ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '删除旧译文确认' },
      h('p', null, `删除译文版本 ${resultDeletePlan.resultVersion} 的正文及展示文件？保留版本号和调用统计，原稿与其他译文版本保留。`),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: busy || deleting, onClick: () => { setDeleting(true); void jobs.deleteResult(resultDeletePlan).finally(() => { setDeleting(false); setResultDeletePlan(undefined) }) } }, deleting ? '正在删除…' : '确认删除此译文版本'),
        h('button', { type: 'button', disabled: busy || deleting, onClick: () => setResultDeletePlan(undefined) }, '取消'))) : null,
    sourceDeletePlan ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '删除文件旧原稿确认' },
      h('p', null, `删除原稿版本 ${sourceDeletePlan.sourceVersion} 及其所属译文、原任务提案、准备／请求正文和展示文件？保留当前原稿、其他版本、已采纳的主题记忆及调用统计；仍被其他资料使用的共享文件保留。`),
      h('div', { className: 'dsh-tp-actions' }, h('button', { type: 'button', disabled: busy || deleting, onClick: () => { setDeleting(true); void jobs.deleteSource(sourceDeletePlan).finally(() => { setDeleting(false); setSourceDeletePlan(undefined) }) } }, deleting ? '正在删除…' : '确认删除文件旧原稿'),
        h('button', { type: 'button', disabled: busy || deleting, onClick: () => setSourceDeletePlan(undefined) }, '取消'))) : null,
    versionsExpanded ? h('div', { className: 'dsh-tp-actions dsh-tp-file-versions' },
      current.sources.length > 1 ? h('select', { 'aria-label': '原稿版本', value: sourceVersion, onChange: (event: { currentTarget: { value: string } }) => setSourceSelection(Number(event.currentTarget.value)) },
        ...current.sources.map(value => h('option', { key: value.version, value: value.version }, `原稿版本 ${value.version}${value.deletion ? ' · 已删除' : ''}`))) : null,
      current.sources.length > 1 ? h('button', { type: 'button', disabled: busy || deleting || !!sourceDeletionBlocked, title: sourceDeletionBlocked, onClick: () => setSourceDeletePlan(jobs.captureSourceDeletion(job.jobId, sourceVersion)) }, '删除此原稿版本') : null,
      h('select', { 'aria-label': '译文版本', value: resultVersion ?? '', onChange: (event: { currentTarget: { value: string } }) => setResultSelection(Number(event.currentTarget.value)) },
        ...current.results.map(value => h('option', { key: value.version, value: value.version }, `版本 ${value.version}${value.deletion ? ' · 已删除' : `${current.final?.version === value.version ? ' · 最终' : ''}${value.semanticStatus === 'passed' ? ' · 已复核' : ' · 待复核'}`}`)))) : null,
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
