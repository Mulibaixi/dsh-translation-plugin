import { h, react } from './react.js'
import type { MemoryIndexClient } from './memory-index-client.js'
export function MemoryIndexView({ client, topicId }: { readonly client: MemoryIndexClient; readonly topicId?: string }): unknown {
  const [, update] = react.useState(0), state = client.getState(topicId)
  react.useEffect(() => { const stop = client.subscribe(() => update(value => value + 1)); void client.refresh(topicId); return stop }, [client, topicId])
  react.useEffect(() => { if (!state.status?.building) return; const timer = setTimeout(() => { void client.refresh(topicId) }, 2000); return () => clearTimeout(timer) }, [client, topicId, state])
  const status = state.status, disabled = state.busy || status?.building
  return h('div', { 'aria-label': '记忆索引' },
    status ? h('p', { role: 'status' }, status.enabled ? `${topicId === undefined ? '全库索引' : '本主题索引'}${status.building ? '（正在建立）' : ''}：已覆盖 ${status.indexed}／${status.total} 段；尚未完成分段 ${status.unsegmented} 份文件，不支持 ${status.unsupported} 份文件，读取失败 ${status.unavailable} 份文件、${status.unavailableRecords} 个译例单元。` : '尚未建立记忆索引，主模型仍可使用词面查找。') : null,
    status?.reason ? h('p', { role: 'status' }, status.reason) : null,
    state.error ? h('p', { role: 'alert' }, state.error) : null,
    h('div', { className: 'dsh-tp-actions' },
      h('button', { type: 'button', disabled, onClick: () => { void client.build(false, topicId) } }, '建立或补齐记忆索引'),
      h('button', { type: 'button', disabled, onClick: () => { void client.build(true, topicId) } }, '重建记忆索引'),
      h('button', { type: 'button', disabled: state.busy, onClick: () => { void client.refresh(topicId) } }, '刷新索引状态')))
}
