import { MEMORY_LEARNING_GUIDE, MEMORY_LEARNING_TRIGGER } from '../shared/memory-learning.js'
import { TRANSLATION_TASK_GUIDANCE } from '../shared/translation-task.js'

/** Explicit names keep SDK tool definitions opaque and preserve the original execution context. */
const groups = {
  source: { description: 'Read supplied source and numbered units in opened translation Sessions.', tools: ['translation_read_source', 'translation_read_unit'] },
  memory_read: { description: 'Read applicable settings/terms; search current-topic memory and opened Session records. File semantic search uses manually selected original content; literal record search also reads excluded code, structure and current translations.', tools: ['translation_list_settings', 'translation_list_terms', 'translation_query_terms', 'translation_list_topic_archive', 'translation_query_archive', 'translation_search_memory', 'translation_record_find', 'translation_record_read'] },
  direct: { description: 'Translate, review and deliver through the Session record; submit reusable asset proposals. Standalone file export is optional and only on explicit user request.', tools: ['translation_translate', 'translation_read_result', 'translation_extract_assets', 'translation_submit_proposals', 'translation_save_result', 'translation_open_file'], requires: ['source', 'memory_read'] },
  file_jobs: { description: 'Discover saved files across reloads; read/revise actual legacy FileJobs jobIds or settle existing jobs. Legacy record retranslation is retired. Direct results use direct with their unit target.', tools: ['translation_file_list', 'translation_file_read_review', 'translation_file_submit_review', 'translation_file_revise'], requires: ['source'] },
  analysis: { description: 'Start/query independent terminology analysis.', tools: ['translation_analyze_terminology', 'translation_analysis_status', 'translation_analysis_read'] },
  document_prepare: { description: 'Legacy document preparation audit and explicit recovery; new files use direct.', tools: ['translation_batch_prepare', 'translation_batch_set_preparation', 'translation_batch_preparation_status', 'translation_batch_read_preparation'], requires: ['source', 'memory_read', 'analysis'] },
  document_plan: { description: 'Legacy document plans and capacity; new files use direct.', tools: ['translation_batch_suggest_plan', 'translation_batch_set_plan', 'translation_batch_plan_status', 'translation_batch_read_plan'], requires: ['document_prepare'] },
  document_execute: { description: 'Legacy execution/query/control and explicit recovery of original unknown tasks.', tools: ['translation_batch_status', 'translation_batch_pause', 'translation_batch_cancel'], requires: ['source'] },
  document_review: { description: 'Legacy document review audits and explicit recovery.', tools: ['translation_batch_review_status', 'translation_batch_review_read', 'translation_batch_review_begin', 'translation_batch_review_submit', 'translation_batch_review_revise', 'translation_batch_review_observe'], requires: ['source', 'memory_read'] },
  document_terms: { description: 'Legacy completed-task term audits; new file assets use translation_submit_proposals and the four pending asset archives.', tools: ['translation_batch_task_terms'], requires: ['source'] },
  correction: { description: 'Correct short/document source and review corrected preparation; query unknown corrections.', tools: ['translation_correct_source', 'translation_batch_correct_source', 'translation_batch_correction_status', 'translation_batch_review_preparation_correction'], requires: ['direct', 'document_prepare'] },
  reference_read: { description: 'Read/search current topic text originals and select task context.', tools: ['translation_reference_files', 'translation_reference_file_read', 'translation_reference_file_search', 'translation_reference_select'] },
  learning_sources: { description: 'Discover real main-chat learning attachments and bind their destination topic.', tools: ['translation_reference_inputs', 'translation_reference_bind'] },
  reference_segment: { description: 'Prepare two independent full-file native annotations and parallel cross-reviews, inspect unresolved original ranges, then commit one complete semantic plan. Manual inspection/correction tools remain available.', tools: ['translation_reference_segment_prepare', 'translation_reference_segment_commit', 'translation_reference_segmentation_read', 'translation_reference_segment'], requires: ['reference_read'] },
  record_segment: { description: 'Read an explicitly selected historical file original with anchors; mark semantic blocks and embedding exclusions without changing the original.', tools: ['translation_record_segmentation_read', 'translation_record_segment'] },
  memory_write: { description: 'Build topic memory from user-provided learning materials; maintain settings and propose terms/entities/facts/relations. Loading returns memoryGuide; also load learning_sources for main-chat attachments.', tools: ['translation_upsert_setting', 'translation_remove_setting', 'translation_upsert_term', 'translation_upsert_archive'], requires: ['memory_read', 'reference_read'] },
  sessions: { description: 'Create sessions; rename topics; change remarks/archive state.', tools: ['translation_create_session', 'translation_rename_topic', 'translation_set_session_remark', 'translation_archive_session'] },
} as const

export type TranslationToolGroup = keyof typeof groups
const permanentNames = new Set(['translation_list_sessions', 'translation_list_topics', 'translation_list_units', 'translation_read_units', 'translation_file_list'])
const groupForName = new Map<string, TranslationToolGroup>()
for (const [name, group] of Object.entries(groups)) for (const tool of group.tools) {
  if (groupForName.has(tool)) throw new Error(`Duplicate translation tool group: ${tool}`)
  groupForName.set(tool, name as TranslationToolGroup)
}

export const MATERIAL_TOOL_GROUPS = { short: ['direct', 'reference_read'], file: ['direct', 'reference_read'] } as const
type ToolEntry = { readonly name: string; readonly definition: unknown; dispose?: (() => void) | undefined }

/** One actual Agent and one management connection own every registration in this directory. */
export class OnDemandTranslationTools {
  private readonly entries = new Map<string, ToolEntry>()
  private readonly selected = new Set<TranslationToolGroup>()
  private selectionAfterTurn: readonly TranslationToolGroup[] | undefined
  private readonly nextTurnRetained = new Set<TranslationToolGroup>()
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

  /** Whether this exact tool is registered for the step now assembling, not merely present in the directory. */
  has(name: string): boolean {
    return !this.disposed && this.entries.get(name)?.dispose !== undefined
  }

  /** Keep these groups registered through the following turn: a follow-up correction must reach the same tool. */
  retainNextTurn(groups: readonly TranslationToolGroup[]): void {
    if (this.disposed) return
    for (const group of this.expand(groups)) this.nextTurnRetained.add(group)
  }

  /** Only call after the SDK has settled the turn's complete tool-call batch. */
  finishTurn(retained: readonly TranslationToolGroup[]): void {
    if (this.disposed) return
    const keep = this.expand([...retained, ...(this.selectionAfterTurn ?? []), ...this.nextTurnRetained])
    this.selectionAfterTurn = undefined
    this.nextTurnRetained.clear()
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
      if (!Array.isArray(input.groups) || input.groups.some(group => typeof group !== 'string' || group !== 'file' && !Object.hasOwn(groups, group))) throw new Error('Unknown translation tool group. Call translation_load_tools with {} for the directory; new files and direct-result corrections use direct; only actual legacy jobs use file_jobs.')
      const requested = [...new Set(input.groups.flatMap(group => group === 'file' ? [...MATERIAL_TOOL_GROUPS.file] : [group]))] as TranslationToolGroup[]
      for (const group of requested) if (!groups[group].tools.some(name => this.entries.has(name))) throw new Error(`Translation tool group unavailable on this connection: ${group}`)
      this.activate(requested)
      // A loader may share a batch with another tool; never remove that tool before it executes.
      if (input.mode === 'select') this.selectionAfterTurn = requested
      return { loadedGroups: [...this.expand(requested)],
        ...(requested.includes('memory_write') || requested.includes('learning_sources') ? { memoryGuide: MEMORY_LEARNING_GUIDE } : {}),
        ...(this.selectionAfterTurn === undefined ? {} : { selectionAfterTurn: this.selectionAfterTurn }) }
    }
    return { groups: Object.entries(groups).filter(([, group]) => group.tools.some(name => this.entries.has(name))).map(([name, group]) => ({ name, purpose: group.description,
      active: this.selected.has(name as TranslationToolGroup) })) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) entry.dispose?.()
    this.entries.clear(); this.selected.clear(); this.selectionAfterTurn = undefined
  }
}

export const TRANSLATION_TOOL_LOADER_DESCRIPTION = TRANSLATION_TASK_GUIDANCE + '\n' + MEMORY_LEARNING_TRIGGER + ' Call this only when a required tool is absent from the CURRENT tool schemas. If translation_translate is already declared, use it directly without reloading direct. Groups may be retained for queued work or a follow-up turn; current schemas, not remembered availability, decide whether loading is needed. {} lists available groups without loading. With groups, only the requested groups and dependencies are acknowledged; memory_write/learning_sources also return the learning guide. translation_list_units, translation_read_units and translation_read_unit are always available for exact numbered targets in opened sidebar Sessions; reading a direct text/file unit exposes direct on the next request. Use translation_translate with that exact unit target and a new operationId for corrections; never reuse an old material requestId or legacy FileJobs jobId. New material and direct results use direct. file_jobs only inspects actual legacy jobs or settles already-running tasks; new legacy execution is retired. The file alias loads direct and reference_read. File results normally belong in the Session; translation_save_result/translation_open_file require an explicit separate export request. Loading only exposes tools; it does not authorize a different task. select changes the retained selection after the current turn settles, never during a tool batch.'
