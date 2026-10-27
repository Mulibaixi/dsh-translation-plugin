import { h, react } from './react.js'
import type { MemoryIndexClient } from './memory-index-client.js'
export function MemoryIndexView({ client, compact = false }: { readonly client: MemoryIndexClient; readonly compact?: boolean }): unknown {
  const [, update] = react.useState(0), state = client.getState()
  react.useEffect(() => { const stop = client.subscribe(() => update(value => value + 1)); void client.refresh(); return stop }, [client])
  react.useEffect(() => { if (!state.status?.building) return; const timer = setTimeout(() => { void client.refresh() }, 2000); return () => clearTimeout(timer) }, [client, state])
  const status = state.status, disabled = state.busy || status?.building
  return h('div', { 'aria-label': '记忆索引' },
    h('p', { className: 'dsh-tp-muted' }, compact ? '索引覆盖整个资料库，会将已采用档案、主题参考正文、当前原文和有效最终译文发送至已配置的嵌入服务。启用后随资产采用、修改及原件变化自动更新；术语和明确设定直接读取。' : '建立索引会将本资料库的有效实体、事实、关系、可读取的主题参考正文，以及当前原文和有效最终译文发送至已保存的嵌入服务，之后随内容变化补齐。主模型仅检索当前主题中已打开会话的译例；旧译文、未采用候选、旧参考片段和聊天不纳入。术语和明确设定继续直接读取。'),
    status ? h('p', { role: 'status' }, status.enabled ? `${status.building ? '正在建立索引' : '当前索引'}：已覆盖 ${status.indexed}／${status.total} 段；不支持 ${status.unsupported} 份文件，读取失败 ${status.unavailable} 份；无有效最终译文或读取失败 ${status.unavailableRecords} 个单元。` : '尚未建立记忆索引，主模型仍可使用词面查找。') : null,
    status?.reason ? h('p', { role: 'status' }, status.reason) : null,
    state.error ? h('p', { role: 'alert' }, state.error) : null,
    h('div', { className: 'dsh-tp-actions' },
      h('button', { type: 'button', disabled, onClick: () => { void client.build() } }, '建立或补齐记忆索引'),
      h('button', { type: 'button', disabled, onClick: () => { void client.build(true) } }, '重建记忆索引'),
      h('button', { type: 'button', disabled: state.busy, onClick: () => { void client.refresh() } }, '刷新索引状态')))
}
