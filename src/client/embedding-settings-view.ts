import { h, react } from './react.js'
import type { EmbeddingClient } from './embedding-client.js'
import type { MemoryIndexClient } from './memory-index-client.js'
import { MemoryIndexView } from './memory-index-view.js'

interface Draft { readonly endpoint: string; readonly model: string; readonly apiKey: string; readonly revision: string | null }
export function EmbeddingSettingsView({ client, index }: { readonly client: EmbeddingClient; readonly index?: MemoryIndexClient | undefined }): unknown {
  const [, update] = react.useState(0)
  const [draft, setDraft] = react.useState<Draft | undefined>(undefined)
  const alive = react.useRef(true)
  react.useEffect(() => { alive.current = true; const stop = client.subscribe(() => update(value => value + 1)); void client.refresh(); return () => { alive.current = false; stop() } }, [client])
  react.useEffect(() => index?.subscribe(() => update(value => value + 1)), [index])
  const state = client.getState(), settings = state.settings
  const form = draft ?? { endpoint: settings?.endpoint ?? '', model: settings?.model ?? '', apiKey: '', revision: settings?.revision ?? null }
  const disabled = state.busy || state.loading
  const dirty = form.endpoint !== settings?.endpoint || form.model !== settings?.model || form.apiKey !== ''
  function change(patch: Partial<Draft>): void { setDraft({ ...form, ...patch }) }
  async function save(): Promise<boolean> {
    const saved = await client.save({ endpoint: form.endpoint.trim(), model: form.model.trim(), expectedRevision: form.revision,
      ...(form.apiKey ? { apiKey: form.apiKey } : {}) })
    if (saved && alive.current) setDraft(undefined)
    return saved
  }
  return h('section', { className: 'dsh-tp-settings-section', 'aria-label': '嵌入 API 设置' },
    h('h3', null, '嵌入 API'),
    h('p', { className: 'dsh-tp-muted' }, '配置一组兼容 OpenAI Embeddings 的文本接口。配置与密钥由宿主凭据服务单独保存；可测试连接，并为已接入的主题档案和参考正文建立语义索引。'),
    h('label', { className: 'dsh-tp-field' }, h('span', null, 'API 完整地址'), h('input', { type: 'url', value: form.endpoint, disabled, 'aria-label': '嵌入 API 完整地址', placeholder: 'https://api.example.com/v1/embeddings', onChange: (event: { currentTarget: { value: string } }) => change({ endpoint: event.currentTarget.value }) })),
    h('label', { className: 'dsh-tp-field' }, h('span', null, '模型名称'), h('input', { value: form.model, disabled, 'aria-label': '嵌入模型名称', onChange: (event: { currentTarget: { value: string } }) => change({ model: event.currentTarget.value }) })),
    h('label', { className: 'dsh-tp-field' }, h('span', null, 'API Key'), h('input', { type: 'password', value: form.apiKey, disabled, 'aria-label': '嵌入 API Key', autoComplete: 'off', placeholder: settings?.hasKey ? '已保存；留空保留当前密钥' : '无鉴权服务可留空', onChange: (event: { currentTarget: { value: string } }) => change({ apiKey: event.currentTarget.value }) })),
    h('p', { className: 'dsh-tp-muted' }, '填写包含 /embeddings 的完整地址。更换服务主机时不会沿用旧密钥，请重新填写；留空将保存为无鉴权配置。测试仅向已保存地址发送固定短文本，不发送记忆资产。'),
    state.loading ? h('p', { role: 'status' }, '正在读取嵌入配置…') : null,
    settings?.reason ? h('p', { role: 'status' }, settings.reason) : null,
    draft && settings && draft.revision !== settings.revision ? h('p', { role: 'status' }, '编辑期间配置已变化，当前输入保留。请核对后继续。') : null,
    state.error ? h('p', { role: 'alert', className: 'dsh-tp-message' }, state.error) : null,
    state.result ? h('p', { role: 'status' }, `连接测试通过：${state.result.dimensions} 维，${state.result.elapsedMs} ms。维度由接口返回；这不代表语义召回效果已验证。`) : null,
    h('div', { className: 'dsh-tp-actions' },
      h('button', { type: 'button', disabled: disabled || !settings?.available || !settings.writable || !form.endpoint.trim() || !form.model.trim(), onClick: () => { void save() } }, '保存嵌入配置'),
      index ? h('button', { type: 'button', disabled: disabled || index.getState().busy || index.getState().status?.building || !settings?.available || !settings.writable || !form.endpoint.trim() || !form.model.trim(), onClick: () => { void save().then(saved => { if (saved && alive.current) void index.build() }) } }, '保存并建立索引') : null,
      h('button', { type: 'button', disabled: disabled || !settings?.revision || dirty, onClick: () => { void client.testConnection() } }, state.busy ? '正在处理…' : '测试已保存配置'),
      h('button', { type: 'button', disabled, onClick: () => { void client.refresh() } }, '读取最新嵌入配置'),
      draft && settings && draft.revision !== settings.revision ? h('button', { type: 'button', disabled, onClick: () => change({ revision: settings.revision }) }, '基于最新配置继续编辑') : null,
      h('button', { type: 'button', disabled: disabled || !settings?.writable, onClick: () => { void client.clear(settings!.revision).then(cleared => { if (cleared && alive.current) setDraft(undefined) }) } }, '清除嵌入配置与密钥')),
    index ? h(MemoryIndexView, { client: index }) : null)
}
