import { h, react } from './react.js'
import type { RecordIndexState, RecordIndexTarget } from '../shared/record-index.js'
import type { RecordIndexClient, RecordIndexClientState } from './record-index-client.js'

export interface RecordIndexProps { readonly recordIndex?: RecordIndexClient | undefined }
export const supportsRecordIndex = (name: string): boolean => /\.(?:txt|md)$/iu.test(name)
export function recordIndexLabel(state?: RecordIndexState): string {
  if (!state) return '未嵌入'
  return { unselected: '未嵌入', submitted: '已提交', segmenting: '分段中', partial: '分段未完成', embedding: '嵌入中', indexed: '已嵌入', failed: '嵌入未完成', empty: '无可索引正文' }[state.phase]
}
function useRecordIndex(client: RecordIndexClient | undefined, target: RecordIndexTarget | undefined, visible = true): RecordIndexClientState {
  const [, changed] = react.useState(0)
  const key = target ? JSON.stringify(target) : ''
  react.useEffect(() => client?.subscribe(() => changed(value => value + 1)), [client])
  react.useEffect(() => client && target && visible ? client.retain(target) : undefined, [client, key, visible])
  return client && target ? client.getState(target) : { busy: false }
}
export function RecordIndexStatus({ client, target, visible = true, prefix = '' }: {
  readonly client?: RecordIndexClient | undefined; readonly target?: RecordIndexTarget | undefined; readonly visible?: boolean | undefined; readonly prefix?: string
}): unknown {
  const state = useRecordIndex(client, target, visible)
  return client && target ? h('span', { 'data-record-index-phase': state.status?.phase ?? 'unselected', title: state.error ?? state.status?.message }, prefix + recordIndexLabel(state.status)) : null
}
export function RecordIndexControl({ client, target, mainSessionId, disabled = false, visible = true }: {
  readonly client?: RecordIndexClient | undefined; readonly target?: RecordIndexTarget | undefined; readonly mainSessionId?: string | undefined
  readonly disabled?: boolean | undefined; readonly visible?: boolean | undefined
}): unknown {
  const state = useRecordIndex(client, target, visible)
  if (!client || !target) return null
  const phase = state.status?.phase ?? 'unselected', working = ['submitted', 'segmenting', 'embedding'].includes(phase)
  const label = phase === 'partial' ? '继续分段' : phase === 'failed' ? '重试嵌入' : phase === 'indexed' || phase === 'empty' ? '重新分段' : working ? `${recordIndexLabel(state.status)}…` : '嵌入原文'
  const action = phase === 'failed' ? 'retry' : phase === 'indexed' || phase === 'empty' ? 'resegment' : 'start'
  const blocked = disabled || state.busy || working || !mainSessionId
  const message = state.error ?? (phase === 'failed' ? state.status?.message : undefined)
  return h('span', { className: 'dsh-tp-actions dsh-tp-record-index-actions' },
    h('button', { type: 'button', disabled: blocked, title: !mainSessionId ? '请选择本次任务使用的主会话。' : undefined,
      onClick: () => { if (mainSessionId) void client.request(target, mainSessionId, action) } }, label),
    ['partial', 'failed', 'indexed', 'empty'].includes(phase) ? h('button', { type: 'button', disabled: blocked,
      onClick: () => { if (mainSessionId) void client.request(target, mainSessionId, 'remove') } }, '移出索引') : null,
    message ? h('small', { className: 'dsh-tp-muted', role: 'alert' }, message) : null)
}
