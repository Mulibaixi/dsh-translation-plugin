import { decodeRoute, type ModelRoute } from './sessions.js'

export interface CatalogModel { readonly id: string; readonly name: string; readonly reasoning?: { readonly defaultEffort?: string; readonly efforts: readonly { readonly id: string; readonly name: string }[] } }
export interface CatalogGroup { readonly id: string; readonly name: string; readonly models: readonly CatalogModel[] }
export interface CatalogState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly groups: readonly CatalogGroup[]
  readonly defaultModel: ModelRoute | null
  readonly failures: readonly { readonly id: string; readonly name: string }[]
}
export interface ModelCatalogPort { modelCatalog(): Promise<unknown> }

/** A directory entry alone does not grant execution; Host separately checks its route. */
export function catalogAllowsRoute(state: CatalogState, route: ModelRoute | null): boolean {
  if (state.status !== 'ready' || !route) return false
  const model = state.groups.find(group => group.id === route.provider)?.models.find(model => model.id === route.model)
  if (!model) return false
  return route.reasoningEffort === undefined || !!model.reasoning?.efforts.some(effort => effort.id === route.reasoningEffort)
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function parseCatalog(response: unknown): Omit<CatalogState, 'status'> | undefined {
  if (!object(response) || response.ok !== true || !object(response.value)) return undefined
  const value = response.value
  if (!Array.isArray(value.groups) || !Array.isArray(value.failures)) return undefined
  const defaultModel = decodeRoute(value.default)
  if (defaultModel === undefined) return undefined
  const groups: CatalogGroup[] = []
  for (const group of value.groups) {
    if (!object(group) || typeof group.id !== 'string' || typeof group.name !== 'string' || !Array.isArray(group.models)) return undefined
    const models: CatalogModel[] = []
    for (const model of group.models) {
      if (!object(model) || typeof model.id !== 'string' || typeof model.name !== 'string') return undefined
      let reasoning: CatalogModel['reasoning']
      if (model.reasoning !== undefined) {
        if (!object(model.reasoning) || !Array.isArray(model.reasoning.efforts) ||
          (model.reasoning.defaultEffort !== undefined && typeof model.reasoning.defaultEffort !== 'string')) return undefined
        const efforts: { id: string; name: string }[] = []
        for (const effort of model.reasoning.efforts) {
          if (!object(effort) || typeof effort.id !== 'string' || typeof effort.name !== 'string') return undefined
          efforts.push({ id: effort.id, name: effort.name })
        }
        reasoning = { efforts, ...(model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }) }
      }
      models.push({ id: model.id, name: model.name, ...(reasoning === undefined ? {} : { reasoning }) })
    }
    groups.push({ id: group.id, name: group.name, models })
  }
  const failures: { id: string; name: string }[] = []
  for (const failure of value.failures) {
    if (!object(failure) || typeof failure.id !== 'string' || typeof failure.name !== 'string') return undefined
    failures.push({ id: failure.id, name: failure.name })
  }
  const priority = (id: string): number => id === 'deepseek-account' ? 0 : id === 'deepseek' ? 1 : 2
  groups.sort((a, b) => priority(a.id) - priority(b.id))
  return { groups, defaultModel, failures }
}

/** 与主窗口使用相同的 Host 目录 RPC；选择操作仅写本插件翻译会话。 */
export class ModelCatalog {
  private state: CatalogState = { status: 'idle', groups: [], defaultModel: null, failures: [] }
  private readonly listeners = new Set<() => void>()
  private pending: Promise<void> | undefined
  private generation = 0
  private disposed = false
  constructor(private readonly port: ModelCatalogPort) {}
  getSnapshot(): CatalogState { return this.state }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private emit(): void { if (!this.disposed) for (const fn of this.listeners) fn() }
  load(): Promise<void> {
    if (this.pending) return this.pending
    if (this.state.status === 'ready') return Promise.resolve()
    if (this.disposed) return Promise.resolve()
    const generation = this.generation
    this.state = { ...this.state, status: 'loading' }; this.emit()
    this.pending = Promise.resolve().then(() => this.port.modelCatalog()).then(response => {
      if (this.disposed || generation !== this.generation) return
      const decoded = parseCatalog(response)
      if (!decoded) throw new Error('invalid catalog')
      this.state = { ...decoded, status: 'ready' }; this.emit()
    }).catch(() => {
      if (!this.disposed && generation === this.generation) { this.state = { ...this.state, status: 'error' }; this.emit() }
    }).finally(() => { if (generation === this.generation) this.pending = undefined })
    return this.pending
  }
  invalidate(clear = false): void {
    this.generation++; this.pending = undefined
    this.state = { ...this.state, status: 'idle', ...(clear ? { groups: [], defaultModel: null, failures: [] } : {}) }; this.emit()
  }
  dispose(): void { this.disposed = true; this.generation++; this.listeners.clear() }
}

export function matchesModel(name: string, query: string): boolean {
  const needle = Array.from(query.trim().toLocaleLowerCase())
  let index = 0
  for (const char of name.toLocaleLowerCase()) if (char === needle[index]) index++
  return index === needle.length
}
