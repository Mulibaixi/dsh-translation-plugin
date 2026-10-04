import type { AttemptStatus, ModelSelection, TranslationMode } from './contracts.js'

/** Plugin-owned, Host-only contracts. These are not DSH Remote/RPC definitions. */
export type DomainErrorCode =
  | 'invalid_input' | 'not_found' | 'identity_mismatch' | 'stale_version'
  | 'idempotency_conflict' | 'invalid_state' | 'execution_unavailable'
  | 'policy_unconfirmed' | 'unsupported' | 'incomplete_result' | 'busy' | 'internal_error'

export type DomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: DomainErrorCode; readonly message: string } }

export interface RuntimeContentRef {
  readonly content_id: string
  readonly code_points: number
}

export interface RuntimeTopic {
  readonly topic_id: string
  readonly name: string
  readonly topic_version: number
  readonly next_sequence: number
  readonly main_session_ids: readonly string[]
}

export interface RuntimeSession {
  readonly translation_session_id: string
  readonly topic_id: string
  readonly sequence: number
  readonly mode: TranslationMode
  readonly session_version: number
  readonly lifecycle: 'active' | 'archived'
  readonly max_source_code_points: number
  readonly unit_ids: readonly string[]
}

export interface UnitBasis {
  readonly unit_id: string
  readonly unit_version: number
  readonly source_version: number
  readonly instruction_version: number
  readonly final_pointer_version: number
}

export interface RuntimeUnit extends UnitBasis {
  readonly topic_id: string
  readonly translation_session_id: string
  readonly unit_order: number
  readonly task_type: 'translation' | 'polish'
  readonly target_language: string
  readonly source_ref: RuntimeContentRef
  readonly instruction_ref: RuntimeContentRef
  readonly latest_candidate_order: number
  readonly final_pointer: RuntimeFinalPointer | null
}

export interface RuntimeFinalPointer {
  readonly revision_id: string
  readonly source_version: number
  readonly instruction_version: number
  readonly final_pointer_version: number
  readonly selection: 'automatic' | 'user_fixed'
  readonly completeness: 'complete'
  readonly validity: 'current' | 'review_required'
}

export interface TextSubmission {
  readonly operation_id: string
  readonly topic_id: string
  readonly translation_session_id: string
  readonly main_session_id?: string
  readonly trigger: 'quick_send' | 'normal_send' | 'manual_save' | 'explicit_revision'
  readonly expected_session_version: number
  readonly draft_version?: number
  readonly source_text: string
  readonly instruction: string
  readonly target_language: string
  readonly task_type: 'translation' | 'polish'
  readonly model?: ModelSelection
  readonly target?: UnitBasis
  readonly max_attempts?: number
}

export interface MaterialReceipt {
  readonly operation_id: string
  readonly operation_version: number
  readonly source_ref: RuntimeContentRef
  readonly instruction_ref: RuntimeContentRef
  readonly draft_version?: number
  readonly storage: 'runtime_only'
}

export type RuntimeIntent = 'discuss' | 'clarify' | 'generate' | 'manual_save'

export interface FinalizePlan extends UnitBasis {
  readonly action: 'automatic' | 'keep_unfinished' | 'keep_final'
  readonly revision_id?: string
}

export interface AcceptedOperation {
  readonly operation_id: string
  readonly unit_id: string
  readonly candidate_order: number
  readonly consumed_draft_version?: number
  readonly source_version: number
  readonly instruction_version: number
  readonly session_version: number
  readonly operation_version: number
  readonly previous_final: RuntimeFinalPointer | null
  readonly storage: 'runtime_only'
}

export interface ManualResult {
  readonly text: string
  readonly completeness: 'complete' | 'incomplete'
  /** Explicit assessment supplied by the trusted Host caller, not inferred from nonempty text. */
  readonly checks_passed: boolean
}

export interface RuntimeOperation {
  readonly operation_id: string
  readonly topic_id: string
  readonly translation_session_id: string
  readonly main_session_id?: string
  readonly operation_version: number
  readonly intent: RuntimeIntent | null
  readonly admission: 'pending' | 'accepted'
  readonly preparation: 'pending' | 'ready' | 'blocked'
  readonly preparation_version: number
  readonly blocked_reason: string | null
  readonly material_receipt: MaterialReceipt
  readonly receipt: AcceptedOperation | null
  readonly attempt_ids: readonly string[]
  readonly revision_ids: readonly string[]
}

export interface PreparedText {
  readonly operation_id: string
  readonly preparation_version: number
  readonly unit_id: string
  readonly source_version: number
  readonly instruction_version: number
  readonly model: ModelSelection
  readonly adapter_generation: string
  readonly policy_epoch: number
}

export interface TextExecutionPacket extends PreparedText {
  readonly attempt_id: string
  readonly candidate_order: number
  readonly attempt_order: number
  readonly topic_id: string
  readonly translation_session_id: string
  readonly mode: TranslationMode
  readonly task_type: 'translation' | 'polish'
  readonly target_language: string
  readonly source_text: string
  readonly instruction: string
  readonly prompt_version: 'text-runtime-v1'
  readonly memory_refs: readonly never[]
  readonly tool_names: readonly never[]
  readonly main_history: readonly never[]
}

export type ProviderState = 'not_sent' | 'acknowledged' | 'finished' | 'stopped' | 'unknown'

export interface RuntimeAttempt {
  readonly attempt_id: string
  readonly attempt_request_id: string
  readonly operation_id: string
  readonly unit_id: string
  readonly candidate_order: number
  readonly attempt_order: number
  readonly status: AttemptStatus
  readonly provider_state: ProviderState
  readonly cancel_requested: boolean
  readonly source_version: number
  readonly instruction_version: number
  readonly packet: TextExecutionPacket
  readonly revision_id: string | null
  readonly failure_stage: 'stream' | 'protocol' | 'cancel' | null
  readonly usage: { readonly input_tokens: number | null; readonly output_tokens: number | null } | null
}

export interface RuntimeRevision {
  readonly revision_id: string
  readonly operation_id: string
  readonly unit_id: string
  readonly candidate_order: number
  readonly attempt_order: number
  readonly attempt_id?: string
  readonly kind: 'machine' | 'manual'
  readonly source_version: number
  readonly instruction_version: number
  readonly content_ref: RuntimeContentRef
  readonly completeness: 'complete' | 'incomplete'
  readonly checks_passed: boolean
  readonly late: boolean
}

export interface AttemptReceipt {
  readonly attempt_id: string
  readonly operation_id: string
  readonly attempt_order: number
  readonly storage: 'runtime_only'
}

export interface RuntimeEvent {
  readonly event_id: string
  readonly cursor: number
  readonly transaction_id: string
  readonly type: string
  readonly topic_id: string
  readonly translation_session_id?: string
  readonly unit_id?: string
  readonly operation_id?: string
  readonly revision_id?: string
  readonly final_pointer_version?: number
}

export interface ExtractionWork {
  readonly queue_id: string
  readonly topic_id: string
  readonly translation_session_id: string
  readonly unit_id: string
  readonly source_version: number
  readonly instruction_version: number
  readonly final_pointer_version: number
  readonly revision_id: string
  readonly trigger_event_id: string
  readonly state: 'pending' | 'superseded'
}

export interface RuntimeSnapshot {
  readonly session: RuntimeSession
  readonly topic: RuntimeTopic
  readonly units: readonly RuntimeUnit[]
  readonly operations: readonly RuntimeOperation[]
  readonly attempts: readonly RuntimeAttempt[]
  readonly revisions: readonly RuntimeRevision[]
  readonly extraction_queue: readonly ExtractionWork[]
  readonly events: readonly RuntimeEvent[]
  readonly cursor: number
  readonly storage: 'runtime_only'
}

export interface TextCapabilityEvidence {
  readonly verified: boolean
  readonly route: ModelSelection
  readonly adapter_generation: string
  readonly modes: readonly TranslationMode[]
  readonly runtime_only_confirmed: boolean
  readonly reconstructable_log_confirmed: boolean
  readonly max_source_code_points: number
}

export type TextExecutionEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'usage'; readonly input_tokens?: number; readonly output_tokens?: number }
  | {
      readonly type: 'terminal'
      readonly reason: 'stop' | 'error' | 'aborted' | 'max_tokens'
      readonly completeness: 'complete' | 'incomplete'
      readonly checks_passed: boolean
      readonly provider_state: 'finished' | 'stopped' | 'unknown'
    }

/** No implementation is installed by the plugin. A future adapter must verify DSH contracts. */
export interface TextExecutionAdapter {
  capabilities(route: ModelSelection): TextCapabilityEvidence
  execute(packet: TextExecutionPacket, signal: AbortSignal): AsyncIterable<TextExecutionEvent>
}

export interface RuntimeCapabilities {
  readonly domain_version: 1
  readonly storage: 'runtime_only'
  readonly durable_transactions: false
  readonly restart_recovery: false
  readonly client_rpc: false
  readonly execution_adapter_installed: boolean
  readonly execution_requires: readonly string[]
  readonly manual_text: true
  readonly unsupported: readonly string[]
}

export interface TranslationRuntimePort {
  capabilities(): DomainResult<RuntimeCapabilities>
  createTopic(input: { operation_id: string; name: string }): DomainResult<RuntimeTopic>
  bindMain(input: { topic_id: string; main_session_id: string; expected_topic_version: number }): DomainResult<RuntimeTopic>
  createSession(input: {
    operation_id: string; topic_id: string; expected_topic_version: number
    mode: TranslationMode; max_source_code_points: number
  }): DomainResult<RuntimeSession>
  setSessionLifecycle(input: {
    translation_session_id: string; expected_session_version: number; lifecycle: 'active' | 'archived'
  }): DomainResult<RuntimeSession>
  upgradeSession(input: {
    translation_session_id: string; expected_session_version: number; main_session_id: string
  }): DomainResult<RuntimeSession>
  receive(input: TextSubmission): DomainResult<MaterialReceipt>
  decide(input: {
    operation_id: string; expected_operation_version: number; main_session_id: string
    intent: 'discuss' | 'clarify' | 'generate'
  }): DomainResult<RuntimeOperation>
  accept(input: {
    operation_id: string; expected_operation_version: number; expected_session_version: number
    advance?: FinalizePlan; manual_result?: ManualResult
  }): DomainResult<AcceptedOperation>
  prepare(input: { operation_id: string; expected_operation_version: number }): DomainResult<PreparedText>
  dispatch(input: {
    operation_id: string; attempt_request_id: string; expected_preparation_version: number
    reason: 'initial' | 'known_failure_retry'
  }): DomainResult<AttemptReceipt>
  cancel(input: { attempt_id: string }): DomainResult<RuntimeAttempt>
  changeSource(input: {
    basis: UnitBasis; source_text?: string; instruction?: string
  }): DomainResult<RuntimeUnit>
  selectFinal(input: {
    unit_id: string; revision_id: string; expected_final_pointer_version: number
  }): DomainResult<RuntimeFinalPointer>
  inspect(input: { operation_id: string }): DomainResult<RuntimeOperation>
  getSnapshot(input: { translation_session_id: string; after_cursor?: number }): DomainResult<RuntimeSnapshot>
  readContent(input: { topic_id: string; content_ref: RuntimeContentRef }): DomainResult<string>
}
