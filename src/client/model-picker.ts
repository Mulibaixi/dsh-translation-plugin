import { h, react } from './react.js'
import { matchesModel, type ModelCatalog } from './models.js'
import { type ModelRoute } from './sessions.js'
import { Menu, MenuGroup, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular } from './native-ui.js'

export function ModelPicker({ catalog, current, onSelect }: {
  readonly catalog: ModelCatalog
  readonly current: ModelRoute | null
  readonly onSelect: (route: ModelRoute) => void
}): unknown {
  const [, update] = react.useState(0)
  const [open, setOpen] = react.useState(false)
  const [pane, setPane] = react.useState<'root' | 'models' | 'efforts'>('root')
  const [query, setQuery] = react.useState('')
  const menuRoot = react.useRef<HTMLElement | null>(null)
  const trigger = react.useRef<HTMLButtonElement | null>(null)
  react.useEffect(() => catalog.subscribe(() => update(value => value + 1)), [catalog])
  const state = catalog.getSnapshot()
  // Native Menu remeasures in its layout effect when getAnchorRect changes.
  // A taller top-side pane must move before paint, rather than on the next RAF.
  const getAnchorRect = react.useMemo(() => () => trigger.current?.getBoundingClientRect() ?? null,
    [pane, query, state, current?.provider, current?.model, current?.reasoningEffort])
  react.useEffect(() => { if (open && state.status === 'idle') void catalog.load() }, [catalog, open, state.status])
  const choice = state.groups.flatMap(group => group.models.map(model => ({ group, model })))
    .find(item => item.group.id === current?.provider && item.model.id === current.model)
  const label = choice?.model.name ?? (current ? `${current.provider}/${current.model}` : '选择模型')
  const reasoning = choice?.model.reasoning
  const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning ? (effectiveEffort === undefined ? 'Default' : reasoning.efforts.find(item => item.id === effectiveEffort)?.name ?? effectiveEffort) : current?.reasoningEffort
  const groups = state.groups.map(group => ({ ...group, models: [...group.models]
    .filter(model => matchesModel(model.name, query))
    .sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(query.trim().toLocaleLowerCase())) - Number(!b.name.toLocaleLowerCase().startsWith(query.trim().toLocaleLowerCase()))) }))
    .filter(group => group.models.length)
  const count = state.groups.reduce((total, group) => total + group.models.length, 0)
  const efforts = reasoning ? [...(reasoning.defaultEffort === undefined ? [{ id: undefined, name: 'Default' }] : []), ...reasoning.efforts] : []

  function chooseModel(route: ModelRoute): void { onSelect(route); setPane('root'); setQuery('') }
  function chooseEffort(effort: string | undefined): void {
    if (!current) return
    onSelect({ provider: current.provider, model: current.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    setOpen(false)
  }
  function keys(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = [...(menuRoot.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not([disabled])') ?? [])]
    if (!rows.length) return
    event.preventDefault(); event.stopPropagation()
    const index = rows.findIndex(row => row === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    rows[next]?.focus()
  }
  function rootRow(title: string, value: string, next: 'models' | 'efforts', disabled = false): unknown {
    return h('button', { type: 'button', role: 'menuitem', className: 'dsh-tp-model-cell', 'aria-label': `选择${title}`, disabled,
      onClick: () => setPane(next),
    }, h('span', null, title), h('span', { className: 'dsh-tp-model-cell-value dsh-tp-muted' }, value), h(IconChevronRightOutlineRegular, { size: 14, className: 'dsh-tp-chevron' }))
  }
  return h('div', { className: 'dsh-tp-model' }, h(Menu, {
    open, onClose: () => setOpen(false), portal: true, side: 'top', align: 'end', compact: true, getAnchorRect,
    className: 'dsh-tp-model-anchor', listClassName: 'dsh-tp-popup dsh-tp-model-menu',
    anchor: h('button', {
      type: 'button', ref: trigger, className: 'dsh-tp-model-trigger', 'aria-label': `模型：${label}${effortLabel ? ` · ${effortLabel}` : ''}`,
      'aria-expanded': open, 'aria-haspopup': 'menu', onClick: () => { setOpen(value => !value); setPane('root'); setQuery('') },
    }, h('span', { className: 'dsh-tp-model-label' }, label), effortLabel ? h('span', { className: 'dsh-tp-model-effort dsh-tp-muted' }, effortLabel) : null,
      h(IconChevronDownOutlineRegular, { size: 14, className: `dsh-tp-chevron${open ? ' dsh-tp-chevron-open' : ''}` }),
    ),
  }, h('div', { ref: menuRoot, className: 'dsh-tp dsh-tp-menu-content', 'aria-label': '模型与推理等级', onKeyDown: keys },
    state.status === 'loading' ? h('p', { role: 'status', className: 'dsh-tp-muted' }, '正在加载模型…') : null,
    state.status === 'error' ? h('div', { role: 'alert' }, '模型目录加载失败。', h('button', { type: 'button', onClick: () => { catalog.invalidate(); void catalog.load() } }, '重试')) : null,
    pane === 'root' ? h('div', null,
      rootRow('模型', label, 'models', state.status !== 'ready'),
      rootRow('推理等级', effortLabel ?? '—', 'efforts', state.status !== 'ready' || !reasoning),
      current && state.status === 'ready' && !reasoning ? h('p', { className: 'dsh-tp-muted' }, '当前模型未提供推理等级。') : null,
    ) : null,
    pane === 'models' ? h('div', null,
      count > 4 ? h('input', { className: 'dsh-tp-model-search', 'aria-label': '搜索模型', value: query, placeholder: '搜索模型', autoFocus: true, style: { outline: 'none', boxShadow: 'none' },
        onChange: (event: { currentTarget: { value: string } }) => setQuery(event.currentTarget.value),
      }) : null,
      h('div', { className: 'dsh-tp-model-list' }, ...groups.map(group => h(MenuGroup, { key: group.id, label: group.name },
        ...group.models.map(model => h('button', {
          type: 'button', role: 'menuitemradio', key: model.id, className: 'dsh-tp-model-row', 'aria-checked': current?.provider === group.id && current.model === model.id,
          disabled: state.status !== 'ready', onClick: () => chooseModel(current?.provider === group.id && current.model === model.id ? current : {
            provider: group.id, model: model.id, ...(model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort }),
          }),
        }, model.name, current?.provider === group.id && current.model === model.id ? ' ✓' : null)),
      ))),
      state.status === 'ready' && groups.length === 0 ? h('p', { role: 'status' }, count ? '没有匹配的模型。' : '尚无可选模型，请先在 DSH 中配置。') : null,
      ...state.failures.map(failure => h('p', { key: failure.id, className: 'dsh-tp-muted' }, `${failure.name}：目录暂不可用`)),
    ) : null,
    pane === 'efforts' ? h(MenuGroup, { label: '推理等级' }, ...efforts.map(effort => h('button', {
      type: 'button', role: 'menuitemradio', className: 'dsh-tp-model-row', key: effort.id ?? 'provider-default', disabled: state.status !== 'ready',
      'aria-checked': effectiveEffort === effort.id, onClick: () => chooseEffort(effort.id),
    }, effort.name, effectiveEffort === effort.id ? ' ✓' : null))) : null,
  )))
}
