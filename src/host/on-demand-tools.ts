/** Explicit names keep SDK tool definitions opaque and preserve the original execution context. */
const groups = {
  source: { description: 'Read supplied source and published units.', tools: ['translation_read_source', 'translation_read_unit'] },
  memory_read: { description: 'Read topic terminology and entity/fact/relation memory.', tools: ['translation_list_terms', 'translation_query_terms', 'translation_list_topic_archive', 'translation_query_archive'] },
  short: { description: 'Execute short text translation.', tools: ['translation_execute'], requires: ['source', 'memory_read'] },
  file_jobs: { description: 'Discover saved files across reloads, read/revise completed results, or explicitly retranslate exact units without old material delivery.', tools: ['translation_file_start', 'translation_file_list', 'translation_file_read_review', 'translation_file_submit_review', 'translation_file_revise', 'translation_file_retranslate'], requires: ['source'] },
  analysis: { description: 'Start/query independent terminology analysis.', tools: ['translation_analyze_terminology', 'translation_analysis_status', 'translation_analysis_read'] },
  document_prepare: { description: 'Legacy document preparation audit and explicit recovery; new files use file_jobs.', tools: ['translation_batch_prepare', 'translation_batch_set_preparation', 'translation_batch_preparation_status', 'translation_batch_read_preparation'], requires: ['source', 'memory_read', 'analysis'] },
  document_plan: { description: 'Legacy document plans and capacity; new files use file_jobs.', tools: ['translation_batch_suggest_plan', 'translation_batch_set_plan', 'translation_batch_plan_status', 'translation_batch_read_plan'], requires: ['document_prepare'] },
  document_execute: { description: 'Legacy execution/query/control and explicit recovery of original unknown tasks.', tools: ['translation_batch_execute', 'translation_batch_status', 'translation_batch_pause', 'translation_batch_cancel', 'translation_batch_resume', 'translation_batch_update'], requires: ['source'] },
  document_review: { description: 'Legacy document review audits and explicit recovery.', tools: ['translation_batch_review_status', 'translation_batch_review_read', 'translation_batch_review_begin', 'translation_batch_review_submit', 'translation_batch_review_revise', 'translation_batch_review_observe'], requires: ['source', 'memory_read'] },
  document_terms: { description: 'Legacy completed-task term audits; new file assets use proposal cards.', tools: ['translation_batch_task_terms'], requires: ['source'] },
  correction: { description: 'Correct short/document source and review corrected preparation; query unknown corrections.', tools: ['translation_correct_source', 'translation_batch_correct_source', 'translation_batch_correction_status', 'translation_batch_review_preparation_correction'], requires: ['short', 'document_prepare'] },
  reference_read: { description: 'Read published reference status/segments; select task context.', tools: ['translation_reference_status', 'translation_reference_segments', 'translation_reference_read', 'translation_reference_select'] },
  reference_import: { description: 'Import/review/publish/revoke user-requested reference material.', tools: ['translation_reference_inputs', 'translation_reference_bind', 'translation_reference_register', 'translation_reference_append', 'translation_reference_publish', 'translation_reference_revoke'], requires: ['reference_read'] },
  memory_write: { description: 'Propose/source-check topic terms and archive entries.', tools: ['translation_upsert_term', 'translation_upsert_archive'], requires: ['memory_read', 'reference_read'] },
  sessions: { description: 'Create sessions; rename topics; change remarks/archive state.', tools: ['translation_create_session', 'translation_rename_topic', 'translation_set_session_remark', 'translation_archive_session'] },
} as const

export type TranslationToolGroup = keyof typeof groups
const permanentNames = new Set(['translation_list_sessions', 'translation_list_topics', 'translation_file_list'])
const groupForName = new Map<string, TranslationToolGroup>()
for (const [name, group] of Object.entries(groups)) for (const tool of group.tools) {
  if (groupForName.has(tool)) throw new Error(`Duplicate translation tool group: ${tool}`)
  groupForName.set(tool, name as TranslationToolGroup)
}

export const MATERIAL_TOOL_GROUPS = { short: ['short'], file: ['file_jobs'] } as const
type ToolEntry = { readonly name: string; readonly definition: unknown; dispose?: (() => void) | undefined }

/** One actual Agent and one management connection own every registration in this directory. */
export class OnDemandTranslationTools {
  private readonly entries = new Map<string, ToolEntry>()
  private readonly selected = new Set<TranslationToolGroup>()
  private selectionAfterTurn: readonly TranslationToolGroup[] | undefined
  private disposed = false
  constructor(private readonly register: (definition: unknown) => () => void) {}

  add(name: string, definition: unknown): () => void {
    if (this.disposed || this.entries.has(name) || !permanentNames.has(name) && !groupForName.has(name)) throw new Error(`Invalid translation tool directory entry: ${name}`)
    const entry: ToolEntry = { name, definition }
    this.entries.set(name, entry)
    if (permanentNames.has(name)) entry.dispose = this.register(definition)
    return () => { entry.dispose?.(); entry.dispose = undefined; this.entries.delete(name) }
  }

  private expand(requested: readonly TranslationToolGroup[]): Set<TranslationToolGroup> {
    const result = new Set<TranslationToolGroup>()
    const visit = (name: TranslationToolGroup): void => {
      if (result.has(name)) return
      result.add(name)
      const group = groups[name] as { readonly requires?: readonly TranslationToolGroup[] }
      group.requires?.forEach(visit)
    }
    requested.forEach(visit)
    return result
  }

  activate(requested: readonly TranslationToolGroup[]): void {
    if (this.disposed) return
    const added: ToolEntry[] = []
    try {
      for (const group of this.expand(requested)) for (const name of groups[group].tools) {
        const entry = this.entries.get(name)
        if (entry && !entry.dispose) { entry.dispose = this.register(entry.definition); added.push(entry) }
      }
      this.expand(requested).forEach(group => this.selected.add(group))
    } catch (error) {
      for (const entry of added.reverse()) { entry.dispose?.(); entry.dispose = undefined }
      throw error
    }
  }

  /** Only call after the SDK has settled the turn's complete tool-call batch. */
  finishTurn(retained: readonly TranslationToolGroup[]): void {
    if (this.disposed) return
    const keep = this.expand([...retained, ...(this.selectionAfterTurn ?? [])])
    this.selectionAfterTurn = undefined
    for (const entry of this.entries.values()) if (!permanentNames.has(entry.name) && !keep.has(groupForName.get(entry.name)!)) {
      entry.dispose?.(); entry.dispose = undefined
    }
    this.selected.clear()
    keep.forEach(group => this.selected.add(group))
    this.activate([...keep])
  }

  load(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Tool loading requires an object.')
    const input = raw as Record<string, unknown>
    if (Object.keys(input).some(key => key !== 'groups' && key !== 'mode') || input.mode !== undefined && input.mode !== 'add' && input.mode !== 'select') throw new Error('Unknown tool-loading option.')
    if (input.groups !== undefined) {
      if (!Array.isArray(input.groups) || input.groups.some(group => typeof group !== 'string' || group !== 'file' && !Object.hasOwn(groups, group))) throw new Error('Unknown translation tool group. Call translation_load_tools with {} for the directory; file tasks and corrections use file_jobs.')
      const requested = [...new Set(input.groups.map(group => group === 'file' ? 'file_jobs' : group))] as TranslationToolGroup[]
      for (const group of requested) if (!groups[group].tools.some(name => this.entries.has(name))) throw new Error(`Translation tool group unavailable on this connection: ${group}`)
      this.activate(requested)
      // A loader may share a batch with another tool; never remove that tool before it executes.
      if (input.mode === 'select') this.selectionAfterTurn = requested
    }
    return { groups: Object.entries(groups).filter(([, group]) => group.tools.some(name => this.entries.has(name))).map(([name, group]) => ({ name, purpose: group.description,
      active: this.selected.has(name as TranslationToolGroup) })),
      activeTools: [...this.entries.values()].filter(entry => !!entry.dispose).map(entry => entry.name),
      ...(this.selectionAfterTurn === undefined ? {} : { selectionAfterTurn: this.selectionAfterTurn }),
      lifetime: 'Groups are reclaimed after the settled main turn; queued material and background tasks retain their required groups. select replaces the selection only at that safe boundary. Loading exposes schemas on the next model request; it does not authorize business operations.' }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) entry.dispose?.()
    this.entries.clear(); this.selected.clear(); this.selectionAfterTurn = undefined
  }
}

export const TRANSLATION_TOOL_LOADER_DESCRIPTION = 'Load translation tool groups for this Agent; {} lists the compact directory. For an existing file or a retry, use the always available translation_file_list to discover saved exact unit targets even after reload; successful discovery exposes file_jobs schemas on the next request. Use file_jobs (alias file) to read/revise saved completed results, explicitly retranslate an exact unit, or start newly delivered material. Never replay old material targets or ask the user for internal JSON. Other groups: short; sessions; memory_read/memory_write; reference_read/reference_import; source. Legacy document groups only inspect or explicitly recover original legacy tasks. Pass groups to add schemas before the next model request. select defers removal until the settled turn boundary.'
