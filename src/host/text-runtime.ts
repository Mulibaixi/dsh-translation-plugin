import { captureText, type RuntimeContentRecord } from '../memory/runtime-content.js'
import type { ModelSelection } from '../shared/contracts.js'
import type {
  AcceptedOperation, AttemptReceipt, DomainErrorCode, DomainResult, ExtractionWork,
  FinalizePlan, ManualResult, MaterialReceipt, PreparedText, RuntimeAttempt,
  RuntimeContentRef, RuntimeEvent, RuntimeFinalPointer, RuntimeOperation, RuntimeRevision,
  RuntimeSession, RuntimeTopic, RuntimeUnit, TextCapabilityEvidence, TextExecutionAdapter,
  TextExecutionEvent, TextExecutionPacket, TextSubmission, TranslationRuntimePort, UnitBasis,
} from '../shared/domain-contracts.js'

interface OperationRecord {
  envelope: TextSubmission
  view: RuntimeOperation
  acceptance_signature: string | null
  prepared: PreparedText | null
}

interface RequestClaim {
  kind: 'topic' | 'session' | 'material'
  signature: string
  receipt: RuntimeTopic | RuntimeSession | MaterialReceipt
}

interface RuntimeState {
  topics: Map<string, RuntimeTopic>
  sessions: Map<string, RuntimeSession>
  units: Map<string, RuntimeUnit>
  operations: Map<string, OperationRecord>
  attempts: Map<string, RuntimeAttempt>
  revisions: Map<string, RuntimeRevision>
  contents: Map<string, RuntimeContentRecord>
  requests: Map<string, RequestClaim>
  dispatch_requests: Map<string, { signature: string; receipt: AttemptReceipt }>
  final_requests: Map<string, RuntimeFinalPointer>
  extraction: Map<string, ExtractionWork>
  events: RuntimeEvent[]
}

type TerminalEvent = Extract<TextExecutionEvent, { type: 'terminal' }>
type Usage = RuntimeAttempt['usage']

function mergeUsage(previous: Usage, event: Extract<TextExecutionEvent, { type: 'usage' }>): Usage {
  return {
    input_tokens: event.input_tokens ?? previous?.input_tokens ?? null,
    output_tokens: event.output_tokens ?? previous?.output_tokens ?? null,
  }
}

class DomainFault extends Error {
  constructor(readonly code: DomainErrorCode, message: string) { super(message) }
}

function fail(code: DomainErrorCode, message: string): never { throw new DomainFault(code, message) }

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input', 'Expected an object')
}

function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    fail('invalid_input', 'Invalid identity')
  }
}

function number(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('invalid_input', 'Invalid version or limit')
}

function text(value: unknown, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > 2_000_000 || (!allowEmpty && !value.trim())) {
    fail('invalid_input', 'Invalid text material')
  }
}

function model(value: unknown): asserts value is ModelSelection {
  object(value)
  text(value.providerId)
  text(value.modelId)
  if (value.providerId.length > 512 || value.modelId.length > 512) fail('invalid_input', 'Invalid model route')
  number(value.configVersion)
  if (value.reasoningEffort !== undefined) {
    text(value.reasoningEffort)
    if (value.reasoningEffort.length > 64) fail('invalid_input', 'Invalid reasoning effort')
  }
}

function sameVersion(actual: number, expected: unknown): void {
  number(expected)
  if (actual !== expected) fail('stale_version', 'Expected version no longer matches')
}

function signature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(signature).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${signature(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function snapshot<T>(value: T): T { return freeze(structuredClone(value)) }

/**
 * A single Host instance owns these maps. Copy-on-write commits are synchronous:
 * acceptance, final selection, events and extraction registration commit together.
 * No filesystem, DSH RPC, provider adapter or restart recovery is installed here.
 */
export class TextTranslationRuntime implements TranslationRuntimePort {
  private state: RuntimeState = {
    topics: new Map(), sessions: new Map(), units: new Map(), operations: new Map(),
    attempts: new Map(), revisions: new Map(), contents: new Map(), requests: new Map(),
    dispatch_requests: new Map(), final_requests: new Map(), extraction: new Map(), events: [],
  }
  private readonly controllers = new Map<string, AbortController>()
  private readonly policyEpoch = 1
  private transactionActive = false

  constructor(private readonly adapter?: TextExecutionAdapter) {}

  private result<T>(action: () => T): DomainResult<T> {
    try { return snapshot({ ok: true as const, value: action() }) }
    catch (error) {
      const fault = error instanceof DomainFault ? error : new DomainFault('internal_error', 'Runtime operation failed')
      return snapshot({ ok: false as const, error: { code: fault.code, message: fault.message } })
    }
  }

  private read<I, T>(input: I, action: (request: I) => T): DomainResult<T> {
    return this.result(() => {
      object(input)
      let request: I
      try { request = structuredClone(input) } catch { fail('invalid_input', 'Input must contain plain data') }
      return action(request)
    })
  }

  private write<I, T>(input: I, action: (state: RuntimeState, request: I, tx: string) => T): DomainResult<T> {
    return this.read(input, request => {
      if (this.transactionActive) fail('busy', 'Another business transaction is active')
      this.transactionActive = true
      try {
        const staged = structuredClone(this.state)
        const value = action(staged, request, this.newId('transaction'))
        const detached = snapshot(value)
        this.state = staged
        return detached
      } finally { this.transactionActive = false }
    })
  }

  private newId(kind: string): string { return `${kind}:${crypto.randomUUID()}` }

  private topic(state: RuntimeState, topicId: string): RuntimeTopic {
    id(topicId)
    const value = state.topics.get(topicId)
    if (!value) fail('not_found', 'Topic not registered')
    return value
  }

  private session(state: RuntimeState, sessionId: string, active = true): RuntimeSession {
    id(sessionId)
    const value = state.sessions.get(sessionId)
    if (!value) fail('not_found', 'Translation session not registered')
    if (active && value.lifecycle !== 'active') fail('invalid_state', 'Translation session is archived')
    return value
  }

  private unit(state: RuntimeState, unitId: string): RuntimeUnit {
    id(unitId)
    const value = state.units.get(unitId)
    if (!value) fail('not_found', 'Unit not registered')
    return value
  }

  private operation(state: RuntimeState, operationId: string): OperationRecord {
    id(operationId)
    const value = state.operations.get(operationId)
    if (!value) fail('not_found', 'Operation not received')
    return value
  }

  private basis(state: RuntimeState, expected: UnitBasis): RuntimeUnit {
    object(expected)
    const unit = this.unit(state, expected.unit_id)
    sameVersion(unit.unit_version, expected.unit_version)
    sameVersion(unit.source_version, expected.source_version)
    sameVersion(unit.instruction_version, expected.instruction_version)
    sameVersion(unit.final_pointer_version, expected.final_pointer_version)
    return unit
  }

  private contents(state: RuntimeState, topicId: string, ref: RuntimeContentRef): string {
    object(ref)
    id(ref.content_id)
    number(ref.code_points)
    const content = state.contents.get(ref.content_id)
    if (!content) fail('not_found', 'Content is unavailable')
    if (content.topic_id !== topicId) fail('identity_mismatch', 'Content belongs to another topic')
    sameVersion(content.ref.code_points, ref.code_points)
    return content.text
  }

  private capture(state: RuntimeState, topicId: string, value: string): RuntimeContentRef {
    return captureText(state.contents, this.newId('content'), topicId, value)
  }

  private event(state: RuntimeState, tx: string, event: Omit<RuntimeEvent, 'event_id' | 'cursor' | 'transaction_id'>): RuntimeEvent {
    const value = { ...event, transaction_id: tx, event_id: this.newId('event'), cursor: state.events.length + 1 }
    state.events.push(value)
    return value
  }

  private claim<T extends RequestClaim['receipt']>(
    state: RuntimeState, operationId: string, kind: RequestClaim['kind'], payload: unknown,
  ): T | null {
    id(operationId)
    const prior = state.requests.get(operationId)
    if (!prior) return null
    if (prior.kind !== kind || prior.signature !== signature(payload)) fail('idempotency_conflict', 'Operation identity already has different material')
    return prior.receipt as T
  }

  capabilities(): ReturnType<TranslationRuntimePort['capabilities']> {
    return this.result(() => ({
      domain_version: 1, storage: 'runtime_only', durable_transactions: false,
      restart_recovery: false, client_rpc: false, execution_adapter_installed: !!this.adapter,
      execution_requires: ['verified exact route', 'runtime-only save boundary', 'reconstructable request log'],
      manual_text: true,
      unsupported: ['durable storage', 'files', 'partial final', 'batch', 'multi-model help', 'memory extraction', 'unknown-outcome retry'],
    } as const))
  }

  createTopic(input: Parameters<TranslationRuntimePort['createTopic']>[0]): ReturnType<TranslationRuntimePort['createTopic']> {
    return this.write(input, (state, request, tx) => {
      text(request.name)
      const prior = this.claim<RuntimeTopic>(state, request.operation_id, 'topic', request)
      if (prior) return prior
      const topic: RuntimeTopic = {
        topic_id: this.newId('topic'), name: request.name, topic_version: 1,
        next_sequence: 0, main_session_ids: [],
      }
      state.topics.set(topic.topic_id, topic)
      state.requests.set(request.operation_id, { kind: 'topic', signature: signature(request), receipt: topic })
      this.event(state, tx, { type: 'topic.created', topic_id: topic.topic_id, operation_id: request.operation_id })
      return topic
    })
  }

  bindMain(input: Parameters<TranslationRuntimePort['bindMain']>[0]): ReturnType<TranslationRuntimePort['bindMain']> {
    return this.write(input, (state, request, tx) => {
      const topic = this.topic(state, request.topic_id)
      id(request.main_session_id)
      sameVersion(topic.topic_version, request.expected_topic_version)
      if (topic.main_session_ids.includes(request.main_session_id)) return topic
      const next = { ...topic, topic_version: topic.topic_version + 1, main_session_ids: [...topic.main_session_ids, request.main_session_id] }
      state.topics.set(topic.topic_id, next)
      this.event(state, tx, { type: 'topic.main_bound', topic_id: topic.topic_id })
      return next
    })
  }

  createSession(input: Parameters<TranslationRuntimePort['createSession']>[0]): ReturnType<TranslationRuntimePort['createSession']> {
    return this.write(input, (state, request, tx) => {
      const prior = this.claim<RuntimeSession>(state, request.operation_id, 'session', request)
      if (prior) return prior
      const topic = this.topic(state, request.topic_id)
      sameVersion(topic.topic_version, request.expected_topic_version)
      if (request.mode !== 'normal' && request.mode !== 'quick') fail('invalid_input', 'Invalid session mode')
      number(request.max_source_code_points, 1)
      if (request.max_source_code_points > 1_000_000) fail('invalid_input', 'Source limit is too large')
      number(topic.next_sequence + 1)
      const session: RuntimeSession = {
        translation_session_id: this.newId('session'), topic_id: topic.topic_id,
        sequence: topic.next_sequence, mode: request.mode, session_version: 1,
        lifecycle: 'active', max_source_code_points: request.max_source_code_points, unit_ids: [],
      }
      state.sessions.set(session.translation_session_id, session)
      state.topics.set(topic.topic_id, { ...topic, topic_version: topic.topic_version + 1, next_sequence: topic.next_sequence + 1 })
      state.requests.set(request.operation_id, { kind: 'session', signature: signature(request), receipt: session })
      this.event(state, tx, { type: 'session.created', topic_id: topic.topic_id, translation_session_id: session.translation_session_id, operation_id: request.operation_id })
      return session
    })
  }

  setSessionLifecycle(input: Parameters<TranslationRuntimePort['setSessionLifecycle']>[0]): ReturnType<TranslationRuntimePort['setSessionLifecycle']> {
    const result = this.write(input, (state, request, tx) => {
      const session = this.session(state, request.translation_session_id, false)
      sameVersion(session.session_version, request.expected_session_version)
      if (request.lifecycle !== 'active' && request.lifecycle !== 'archived') fail('invalid_input', 'Invalid session lifecycle')
      if (request.lifecycle === session.lifecycle) return session
      const next = { ...session, lifecycle: request.lifecycle, session_version: session.session_version + 1 }
      state.sessions.set(session.translation_session_id, next)
      if (next.lifecycle === 'archived') {
        for (const record of state.operations.values()) {
          if (record.view.translation_session_id !== session.translation_session_id || record.view.admission !== 'accepted') continue
          record.view = { ...record.view, operation_version: record.view.operation_version + 1, preparation: 'blocked', blocked_reason: 'session_archived' }
        }
        for (const attempt of state.attempts.values()) {
          if (attempt.packet.translation_session_id === session.translation_session_id) this.markCancel(state, tx, attempt)
        }
      }
      this.event(state, tx, { type: `session.${next.lifecycle}`, topic_id: session.topic_id, translation_session_id: session.translation_session_id })
      return next
    })
    if (result.ok && result.value.lifecycle === 'archived') this.abortCancelled()
    return result
  }

  upgradeSession(input: Parameters<TranslationRuntimePort['upgradeSession']>[0]): ReturnType<TranslationRuntimePort['upgradeSession']> {
    return this.write(input, (state, request, tx) => {
      const session = this.session(state, request.translation_session_id)
      sameVersion(session.session_version, request.expected_session_version)
      id(request.main_session_id)
      if (!this.topic(state, session.topic_id).main_session_ids.includes(request.main_session_id)) fail('identity_mismatch', 'Main session is not linked to the topic')
      if (session.mode === 'normal') return session
      if (this.busy(state, session.translation_session_id)) fail('busy', 'Settle outstanding quick execution before upgrading')
      const next: RuntimeSession = { ...session, mode: 'normal', session_version: session.session_version + 1 }
      state.sessions.set(session.translation_session_id, next)
      this.event(state, tx, { type: 'session.upgraded', topic_id: session.topic_id, translation_session_id: session.translation_session_id })
      return next
    })
  }

  private validateEnvelope(request: TextSubmission): void {
    id(request.operation_id)
    id(request.topic_id)
    id(request.translation_session_id)
    if (request.main_session_id !== undefined) id(request.main_session_id)
    number(request.expected_session_version)
    if (request.draft_version !== undefined) number(request.draft_version, 1)
    text(request.source_text)
    text(request.instruction, true)
    text(request.target_language)
    if (!['quick_send', 'normal_send', 'manual_save', 'explicit_revision'].includes(request.trigger)) fail('invalid_input', 'Invalid submission trigger')
    if (request.task_type !== 'translation' && request.task_type !== 'polish') fail('invalid_input', 'Invalid task type')
    if (request.model !== undefined) model(request.model)
    if (request.max_attempts !== undefined) {
      number(request.max_attempts, 1)
      if (request.max_attempts > 3) fail('unsupported', 'At most three explicitly authorized attempts are supported')
    }
    if (request.target !== undefined) object(request.target)
  }

  private validateIdentity(state: RuntimeState, envelope: TextSubmission): RuntimeSession {
    const session = this.session(state, envelope.translation_session_id)
    if (session.topic_id !== envelope.topic_id) fail('identity_mismatch', 'Session belongs to another topic')
    const topic = this.topic(state, session.topic_id)
    if (session.mode === 'normal') {
      if (!envelope.main_session_id || !topic.main_session_ids.includes(envelope.main_session_id)) fail('identity_mismatch', 'Normal operation requires an explicitly linked main session')
      if (envelope.trigger === 'quick_send') fail('invalid_state', 'Quick send cannot target a normal session')
    } else {
      if (envelope.main_session_id !== undefined) fail('identity_mismatch', 'Quick execution does not have a responsible main session')
      if (envelope.trigger === 'normal_send' || envelope.task_type === 'polish') fail('invalid_state', 'This operation requires normal mode')
    }
    return session
  }

  receive(input: TextSubmission): ReturnType<TranslationRuntimePort['receive']> {
    return this.write(input, (state, request, tx) => {
      this.validateEnvelope(request)
      const prior = this.claim<MaterialReceipt>(state, request.operation_id, 'material', request)
      if (prior) return prior
      const session = this.validateIdentity(state, request)
      sameVersion(session.session_version, request.expected_session_version)
      if (request.target) {
        const unit = this.basis(state, request.target)
        if (unit.translation_session_id !== session.translation_session_id) fail('identity_mismatch', 'Target unit belongs to another session')
      } else if (request.trigger === 'explicit_revision') fail('invalid_input', 'Explicit revision requires a target unit')
      const intent = request.trigger === 'manual_save' ? 'manual_save' : session.mode === 'quick' ? 'generate' : null
      const receipt: MaterialReceipt = {
        operation_id: request.operation_id, operation_version: 1,
        source_ref: this.capture(state, session.topic_id, request.source_text),
        instruction_ref: this.capture(state, session.topic_id, request.instruction),
        ...(request.draft_version !== undefined ? { draft_version: request.draft_version } : {}),
        storage: 'runtime_only',
      }
      state.operations.set(request.operation_id, {
        envelope: request, acceptance_signature: null, prepared: null,
        view: {
          operation_id: request.operation_id, topic_id: request.topic_id,
          translation_session_id: request.translation_session_id,
          ...(request.main_session_id ? { main_session_id: request.main_session_id } : {}),
          operation_version: 1, intent, admission: 'pending', preparation: 'pending',
          preparation_version: 0, blocked_reason: null, material_receipt: receipt, receipt: null, attempt_ids: [], revision_ids: [],
        },
      })
      state.requests.set(request.operation_id, { kind: 'material', signature: signature(request), receipt })
      this.event(state, tx, { type: 'material.received', topic_id: request.topic_id, translation_session_id: request.translation_session_id, operation_id: request.operation_id })
      return receipt
    })
  }

  decide(input: Parameters<TranslationRuntimePort['decide']>[0]): ReturnType<TranslationRuntimePort['decide']> {
    return this.write(input, (state, request, tx) => {
      const record = this.operation(state, request.operation_id)
      sameVersion(record.view.operation_version, request.expected_operation_version)
      const session = this.validateIdentity(state, record.envelope)
      id(request.main_session_id)
      if (session.mode !== 'normal' || record.envelope.main_session_id !== request.main_session_id) fail('identity_mismatch', 'Intent must come from the frozen responsible main session')
      if (record.view.admission !== 'pending' || record.view.intent === 'manual_save') fail('invalid_state', 'Operation already has an execution decision')
      if (!['discuss', 'clarify', 'generate'].includes(request.intent)) fail('invalid_input', 'Invalid main intent')
      if (record.view.intent === request.intent) return record.view
      record.view = { ...record.view, intent: request.intent, operation_version: record.view.operation_version + 1 }
      this.event(state, tx, { type: `intent.${request.intent}`, topic_id: session.topic_id, translation_session_id: session.translation_session_id, operation_id: request.operation_id })
      return record.view
    })
  }

  private capability(route: ModelSelection, session: RuntimeSession, sourceLength: number): TextCapabilityEvidence {
    if (!this.adapter) fail('execution_unavailable', 'No text execution adapter is installed')
    model(route)
    let evidence: TextCapabilityEvidence
    try { evidence = snapshot(this.adapter.capabilities(snapshot(route))) }
    catch { fail('execution_unavailable', 'Execution capability could not be confirmed') }
    object(evidence)
    model(evidence.route)
    if (evidence.verified !== true || signature(evidence.route) !== signature(route) || !Array.isArray(evidence.modes) || !evidence.modes.includes(session.mode)) {
      fail('execution_unavailable', 'The exact route and mode have no verified capability')
    }
    text(evidence.adapter_generation)
    number(evidence.max_source_code_points, 1)
    if (evidence.runtime_only_confirmed !== true || evidence.reconstructable_log_confirmed !== true) fail('policy_unconfirmed', 'Runtime-only execution and request logging are unconfirmed')
    if (sourceLength > evidence.max_source_code_points) fail('invalid_input', 'Source exceeds the verified route limit')
    return evidence
  }

  private validateManual(result: ManualResult): void {
    object(result)
    text(result.text)
    if (result.completeness !== 'complete' && result.completeness !== 'incomplete') fail('unsupported', 'Only complete or incomplete text revisions are supported')
    if (typeof result.checks_passed !== 'boolean') fail('invalid_input', 'An explicit result assessment is required')
  }

  accept(input: Parameters<TranslationRuntimePort['accept']>[0]): ReturnType<TranslationRuntimePort['accept']> {
    return this.write(input, (state, request, tx) => {
      const record = this.operation(state, request.operation_id)
      const requestSignature = signature(request)
      if (record.view.receipt) {
        if (record.acceptance_signature !== requestSignature) fail('idempotency_conflict', 'Acceptance identity already has different material')
        return record.view.receipt
      }
      sameVersion(record.view.operation_version, request.expected_operation_version)
      const envelope = record.envelope
      const session = this.validateIdentity(state, envelope)
      sameVersion(session.session_version, request.expected_session_version)
      // Receiving materials or discussing them never crosses admission.
      if (record.view.intent !== 'generate' && record.view.intent !== 'manual_save') fail('invalid_state', 'Discussion or clarification cannot be accepted as execution')
      const length = Array.from(envelope.source_text).length
      if (length > session.max_source_code_points) fail('invalid_input', 'Source exceeds the session limit')
      if (record.view.intent === 'generate') {
        if (request.manual_result !== undefined) fail('invalid_input', 'Generated operations cannot contain manual results')
        if (!envelope.model) fail('invalid_input', 'Generation requires an explicit model route')
        this.capability(envelope.model, session, length)
      } else {
        if (!request.manual_result) fail('invalid_input', 'Manual save requires a result')
        this.validateManual(request.manual_result)
      }
      let unit: RuntimeUnit
      let previousFinal: RuntimeFinalPointer | null = null
      if (envelope.target) {
        if (request.advance !== undefined) fail('invalid_input', 'A revision cannot advance to another unit')
        unit = this.basis(state, envelope.target)
        if (unit.translation_session_id !== session.translation_session_id) fail('identity_mismatch', 'Target unit belongs to another session')
        if (this.contents(state, session.topic_id, unit.source_ref) !== envelope.source_text || this.contents(state, session.topic_id, unit.instruction_ref) !== envelope.instruction || unit.target_language !== envelope.target_language || unit.task_type !== envelope.task_type) {
          fail('stale_version', 'Revision material no longer matches the target unit')
        }
        unit = { ...unit, unit_version: unit.unit_version + 1, latest_candidate_order: unit.latest_candidate_order + 1 }
      } else {
        const previousId = session.unit_ids.at(-1)
        if (previousId) {
          if (!request.advance || request.advance.unit_id !== previousId) fail('invalid_input', 'A frozen plan for the previous unit is required')
          previousFinal = this.finalizePrevious(state, tx, session, request.advance)
        } else if (request.advance !== undefined) fail('identity_mismatch', 'There is no previous unit to advance')
        unit = {
          unit_id: this.newId('unit'), topic_id: session.topic_id,
          translation_session_id: session.translation_session_id, unit_order: session.unit_ids.length,
          task_type: envelope.task_type, target_language: envelope.target_language,
          source_ref: record.view.material_receipt.source_ref,
          instruction_ref: record.view.material_receipt.instruction_ref,
          unit_version: 1, source_version: 1, instruction_version: 1,
          latest_candidate_order: 1, final_pointer_version: 0, final_pointer: null,
        }
        this.event(state, tx, { type: 'unit.created', topic_id: session.topic_id, translation_session_id: session.translation_session_id, unit_id: unit.unit_id, operation_id: envelope.operation_id })
      }
      state.units.set(unit.unit_id, unit)
      const nextSession = {
        ...session, session_version: session.session_version + 1,
        unit_ids: envelope.target ? session.unit_ids : [...session.unit_ids, unit.unit_id],
      }
      state.sessions.set(session.translation_session_id, nextSession)
      const receipt: AcceptedOperation = {
        operation_id: envelope.operation_id, unit_id: unit.unit_id,
        candidate_order: unit.latest_candidate_order, source_version: unit.source_version,
        instruction_version: unit.instruction_version, session_version: nextSession.session_version,
        operation_version: record.view.operation_version + 1, previous_final: previousFinal,
        ...(!envelope.target && envelope.draft_version !== undefined ? { consumed_draft_version: envelope.draft_version } : {}),
        storage: 'runtime_only',
      }
      record.acceptance_signature = requestSignature
      record.view = { ...record.view, admission: 'accepted', operation_version: receipt.operation_version, receipt }
      if (request.manual_result) {
        const revision: RuntimeRevision = {
          revision_id: this.newId('revision'), operation_id: envelope.operation_id, unit_id: unit.unit_id,
          candidate_order: unit.latest_candidate_order, attempt_order: 0, kind: 'manual',
          source_version: unit.source_version, instruction_version: unit.instruction_version,
          content_ref: this.capture(state, session.topic_id, request.manual_result.text),
          completeness: request.manual_result.completeness, checks_passed: request.manual_result.checks_passed, late: false,
        }
        state.revisions.set(revision.revision_id, revision)
        record.view = { ...record.view, revision_ids: [revision.revision_id] }
        this.event(state, tx, { type: 'revision.recorded', topic_id: session.topic_id, translation_session_id: session.translation_session_id, unit_id: unit.unit_id, operation_id: envelope.operation_id, revision_id: revision.revision_id })
      }
      this.event(state, tx, { type: 'operation.accepted', topic_id: session.topic_id, translation_session_id: session.translation_session_id, unit_id: unit.unit_id, operation_id: envelope.operation_id })
      return receipt
    })
  }

  private finalizePrevious(state: RuntimeState, tx: string, session: RuntimeSession, plan: FinalizePlan): RuntimeFinalPointer | null {
    const unit = this.basis(state, plan)
    if (unit.translation_session_id !== session.translation_session_id) fail('identity_mismatch', 'Previous unit belongs to another session')
    if (!['automatic', 'keep_unfinished', 'keep_final'].includes(plan.action)) fail('invalid_input', 'Invalid finalization plan')
    if (plan.action === 'keep_unfinished') return unit.final_pointer
    if (plan.action === 'keep_final') {
      if (!unit.final_pointer) fail('invalid_state', 'There is no final selection to keep')
      if (plan.revision_id !== unit.final_pointer.revision_id) fail('stale_version', 'Final selection does not match the frozen plan')
      return unit.final_pointer
    }
    if (unit.final_pointer?.selection === 'user_fixed') {
      if (plan.revision_id !== unit.final_pointer.revision_id) fail('invalid_state', 'A user-fixed final cannot be automatically replaced')
      return unit.final_pointer
    }
    id(plan.revision_id)
    const revision = state.revisions.get(plan.revision_id)
    if (!revision || revision.unit_id !== unit.unit_id) fail('identity_mismatch', 'Candidate belongs to another unit or is unavailable')
    this.requireComplete(revision)
    if (revision.late || revision.candidate_order !== unit.latest_candidate_order || revision.source_version !== unit.source_version || revision.instruction_version !== unit.instruction_version) fail('incomplete_result', 'The latest admitted candidate is not currently qualified')
    const record = this.operation(state, revision.operation_id)
    const latestAttemptId = record.view.attempt_ids.at(-1)
    if (revision.kind === 'machine') {
      const attempt = latestAttemptId ? state.attempts.get(latestAttemptId) : undefined
      if (!attempt || attempt.status !== 'completed' || attempt.cancel_requested || attempt.revision_id !== revision.revision_id) fail('incomplete_result', 'The latest attempt has no qualified complete result')
    } else if (record.view.revision_ids.at(-1) !== revision.revision_id) fail('incomplete_result', 'A newer manual candidate exists')
    return this.setFinal(state, tx, unit, revision, 'automatic')
  }

  private requireComplete(revision: RuntimeRevision): void {
    if (revision.completeness !== 'complete' || !revision.checks_passed) fail('incomplete_result', 'Only checked complete results can be final')
  }

  private supersedeExtraction(state: RuntimeState, unitId: string): void {
    for (const [key, item] of state.extraction) {
      if (item.unit_id === unitId && item.state === 'pending') state.extraction.set(key, { ...item, state: 'superseded' })
    }
  }

  private setFinal(state: RuntimeState, tx: string, unit: RuntimeUnit, revision: RuntimeRevision, selection: RuntimeFinalPointer['selection']): RuntimeFinalPointer {
    const validity = revision.source_version === unit.source_version && revision.instruction_version === unit.instruction_version ? 'current' : 'review_required'
    const prior = unit.final_pointer
    if (prior?.revision_id === revision.revision_id && prior.selection === selection && prior.validity === validity) return prior
    const final: RuntimeFinalPointer = {
      revision_id: revision.revision_id, source_version: revision.source_version,
      instruction_version: revision.instruction_version, final_pointer_version: unit.final_pointer_version + 1,
      selection, completeness: 'complete', validity,
    }
    state.units.set(unit.unit_id, { ...unit, unit_version: unit.unit_version + 1, final_pointer_version: final.final_pointer_version, final_pointer: final })
    this.supersedeExtraction(state, unit.unit_id)
    const event = this.event(state, tx, {
      type: 'final.selected', topic_id: unit.topic_id, translation_session_id: unit.translation_session_id,
      unit_id: unit.unit_id, revision_id: revision.revision_id, final_pointer_version: final.final_pointer_version,
    })
    this.event(state, tx, { type: 'dependencies.invalidated', topic_id: unit.topic_id, translation_session_id: unit.translation_session_id, unit_id: unit.unit_id })
    // Quick selection never schedules learning. Review-required evidence is not eligible either.
    if (this.session(state, unit.translation_session_id, false).mode === 'normal' && validity === 'current') {
      const work: ExtractionWork = {
        queue_id: this.newId('extraction'), topic_id: unit.topic_id,
        translation_session_id: unit.translation_session_id, unit_id: unit.unit_id,
        source_version: revision.source_version, instruction_version: revision.instruction_version,
        final_pointer_version: final.final_pointer_version, revision_id: revision.revision_id,
        trigger_event_id: event.event_id, state: 'pending',
      }
      state.extraction.set(work.queue_id, work)
      this.event(state, tx, { type: 'extraction.requested', topic_id: unit.topic_id, translation_session_id: unit.translation_session_id, unit_id: unit.unit_id, revision_id: revision.revision_id, final_pointer_version: final.final_pointer_version })
    }
    return final
  }

  selectFinal(input: Parameters<TranslationRuntimePort['selectFinal']>[0]): ReturnType<TranslationRuntimePort['selectFinal']> {
    return this.write(input, (state, request, tx) => {
      id(request.unit_id)
      id(request.revision_id)
      number(request.expected_final_pointer_version)
      const requestSignature = signature(request)
      const prior = state.final_requests.get(requestSignature)
      if (prior) return prior
      const unit = this.unit(state, request.unit_id)
      this.session(state, unit.translation_session_id)
      sameVersion(unit.final_pointer_version, request.expected_final_pointer_version)
      const revision = state.revisions.get(request.revision_id)
      if (!revision || revision.unit_id !== unit.unit_id) fail('identity_mismatch', 'Revision belongs to another unit or is unavailable')
      this.requireComplete(revision)
      const final = this.setFinal(state, tx, unit, revision, 'user_fixed')
      state.final_requests.set(requestSignature, final)
      return final
    })
  }

  changeSource(input: Parameters<TranslationRuntimePort['changeSource']>[0]): ReturnType<TranslationRuntimePort['changeSource']> {
    return this.write(input, (state, request, tx) => {
      const unit = this.basis(state, request.basis)
      const session = this.session(state, unit.translation_session_id)
      if (request.source_text === undefined && request.instruction === undefined) fail('invalid_input', 'Source or instruction change is required')
      let sourceChanged = false
      let instructionChanged = false
      if (request.source_text !== undefined) {
        text(request.source_text)
        if (Array.from(request.source_text).length > session.max_source_code_points) fail('invalid_input', 'Source exceeds the session limit')
        sourceChanged = request.source_text !== this.contents(state, unit.topic_id, unit.source_ref)
      }
      if (request.instruction !== undefined) {
        text(request.instruction, true)
        instructionChanged = request.instruction !== this.contents(state, unit.topic_id, unit.instruction_ref)
      }
      if (!sourceChanged && !instructionChanged) return unit
      const pointerChanged = unit.final_pointer !== null && unit.final_pointer.validity !== 'review_required'
      const pointerVersion = unit.final_pointer_version + (pointerChanged ? 1 : 0)
      const next: RuntimeUnit = {
        ...unit, unit_version: unit.unit_version + 1,
        source_version: unit.source_version + (sourceChanged ? 1 : 0),
        instruction_version: unit.instruction_version + (instructionChanged ? 1 : 0),
        source_ref: sourceChanged ? this.capture(state, unit.topic_id, request.source_text!) : unit.source_ref,
        instruction_ref: instructionChanged ? this.capture(state, unit.topic_id, request.instruction!) : unit.instruction_ref,
        final_pointer_version: pointerVersion,
        final_pointer: unit.final_pointer ? { ...unit.final_pointer, final_pointer_version: pointerVersion, validity: 'review_required' } : null,
      }
      state.units.set(unit.unit_id, next)
      state.sessions.set(session.translation_session_id, { ...session, session_version: session.session_version + 1 })
      for (const record of state.operations.values()) {
        if (record.view.receipt?.unit_id !== unit.unit_id || record.view.intent !== 'generate') continue
        record.prepared = null
        record.view = { ...record.view, operation_version: record.view.operation_version + 1, preparation: 'blocked', blocked_reason: 'source_changed' }
      }
      this.supersedeExtraction(state, unit.unit_id)
      this.event(state, tx, { type: sourceChanged ? 'source.changed' : 'requirements.changed', topic_id: unit.topic_id, translation_session_id: unit.translation_session_id, unit_id: unit.unit_id })
      if (sourceChanged && instructionChanged) this.event(state, tx, { type: 'requirements.changed', topic_id: unit.topic_id, translation_session_id: unit.translation_session_id, unit_id: unit.unit_id })
      this.event(state, tx, { type: 'dependencies.invalidated', topic_id: unit.topic_id, translation_session_id: unit.translation_session_id, unit_id: unit.unit_id, final_pointer_version: pointerVersion })
      return next
    })
  }

  private acceptedUnit(state: RuntimeState, record: OperationRecord): RuntimeUnit {
    if (!record.view.receipt || record.view.intent !== 'generate') fail('invalid_state', 'Only an accepted generation can execute')
    const unit = this.unit(state, record.view.receipt.unit_id)
    this.validateIdentity(state, record.envelope)
    if (unit.source_version !== record.view.receipt.source_version || unit.instruction_version !== record.view.receipt.instruction_version || unit.latest_candidate_order !== record.view.receipt.candidate_order) fail('stale_version', 'Accepted source or candidate basis has changed')
    return unit
  }

  prepare(input: Parameters<TranslationRuntimePort['prepare']>[0]): ReturnType<TranslationRuntimePort['prepare']> {
    const result = this.write(input, (state, request, tx) => {
      const record = this.operation(state, request.operation_id)
      sameVersion(record.view.operation_version, request.expected_operation_version)
      const unit = this.acceptedUnit(state, record)
      const session = this.session(state, unit.translation_session_id)
      const route = record.envelope.model
      if (!route) fail('invalid_input', 'Generation requires an explicit model route')
      const capability = this.capability(route, session, unit.source_ref.code_points)
      const prepared: PreparedText = {
        operation_id: request.operation_id, preparation_version: record.view.preparation_version + 1,
        unit_id: unit.unit_id, source_version: unit.source_version, instruction_version: unit.instruction_version,
        model: route, adapter_generation: capability.adapter_generation, policy_epoch: this.policyEpoch,
      }
      record.prepared = prepared
      record.view = { ...record.view, preparation: 'ready', preparation_version: prepared.preparation_version, blocked_reason: null, operation_version: record.view.operation_version + 1 }
      this.event(state, tx, { type: 'operation.prepared', topic_id: unit.topic_id, translation_session_id: unit.translation_session_id, unit_id: unit.unit_id, operation_id: request.operation_id })
      return prepared
    })
    if (!result.ok) this.blockPreparation(input, result.error.code)
    return result
  }

  private blockPreparation(input: { operation_id: string; expected_operation_version?: number }, reason: string): void {
    // A post-admission capability failure does not undo the accepted transaction.
    this.write(input, (state, request, tx) => {
      const record = this.operation(state, request.operation_id)
      if (record.view.admission !== 'accepted' || record.view.intent !== 'generate' || (request.expected_operation_version !== undefined && record.view.operation_version !== request.expected_operation_version)) return null
      record.prepared = null
      record.view = { ...record.view, preparation: 'blocked', blocked_reason: reason, operation_version: record.view.operation_version + 1 }
      this.event(state, tx, { type: 'operation.blocked', topic_id: record.view.topic_id, translation_session_id: record.view.translation_session_id, operation_id: request.operation_id })
      return null
    })
  }

  private busy(state: RuntimeState, sessionId: string): boolean {
    return [...state.attempts.values()].some(attempt => attempt.packet.translation_session_id === sessionId && (attempt.status === 'running' || attempt.status === 'unknown'))
  }

  dispatch(input: Parameters<TranslationRuntimePort['dispatch']>[0]): ReturnType<TranslationRuntimePort['dispatch']> {
    let startId: string | null = null
    const result = this.write(input, (state, request, tx) => {
      id(request.attempt_request_id)
      id(request.operation_id)
      const requestSignature = signature(request)
      const prior = state.dispatch_requests.get(request.attempt_request_id)
      if (prior) {
        if (prior.signature !== requestSignature) fail('idempotency_conflict', 'Attempt request already has different material')
        return prior.receipt
      }
      const record = this.operation(state, request.operation_id)
      const unit = this.acceptedUnit(state, record)
      const session = this.session(state, unit.translation_session_id)
      if (!this.adapter) fail('execution_unavailable', 'No text execution adapter is installed')
      if (record.view.preparation !== 'ready' || !record.prepared) fail('invalid_state', 'Operation is not prepared')
      sameVersion(record.prepared.preparation_version, request.expected_preparation_version)
      const evidence = this.capability(record.prepared.model, session, unit.source_ref.code_points)
      if (evidence.adapter_generation !== record.prepared.adapter_generation || record.prepared.policy_epoch !== this.policyEpoch) fail('stale_version', 'Prepared execution capability has changed')
      if (this.busy(state, session.translation_session_id)) fail('busy', 'This session has running or unknown execution')
      const latestId = record.view.attempt_ids.at(-1)
      if (!latestId) {
        if (request.reason !== 'initial') fail('invalid_input', 'First dispatch requires an initial decision')
      } else {
        const latest = state.attempts.get(latestId)!
        if (request.reason !== 'known_failure_retry' || !['failed', 'cancelled'].includes(latest.status) || !['not_sent', 'finished', 'stopped'].includes(latest.provider_state)) fail('invalid_state', 'Only explicitly authorized known-failure retries are supported')
      }
      if (record.view.attempt_ids.length >= (record.envelope.max_attempts ?? 1)) fail('invalid_state', 'Authorized attempt budget is exhausted')
      const attemptId = this.newId('attempt')
      const attemptOrder = record.view.attempt_ids.length + 1
      const packet: TextExecutionPacket = {
        ...record.prepared, attempt_id: attemptId, candidate_order: unit.latest_candidate_order,
        attempt_order: attemptOrder, topic_id: unit.topic_id, translation_session_id: session.translation_session_id,
        mode: session.mode, task_type: unit.task_type, target_language: unit.target_language,
        source_text: this.contents(state, unit.topic_id, unit.source_ref),
        instruction: this.contents(state, unit.topic_id, unit.instruction_ref),
        prompt_version: 'text-runtime-v1', memory_refs: [], tool_names: [], main_history: [],
      }
      const attempt: RuntimeAttempt = {
        attempt_id: attemptId, attempt_request_id: request.attempt_request_id, operation_id: request.operation_id,
        unit_id: unit.unit_id, candidate_order: unit.latest_candidate_order, attempt_order: attemptOrder,
        source_version: unit.source_version, instruction_version: unit.instruction_version,
        status: 'running', provider_state: 'unknown', cancel_requested: false,
        packet, revision_id: null, failure_stage: null, usage: null,
      }
      state.attempts.set(attemptId, attempt)
      record.view = { ...record.view, attempt_ids: [...record.view.attempt_ids, attemptId], operation_version: record.view.operation_version + 1 }
      const receipt: AttemptReceipt = { attempt_id: attemptId, operation_id: request.operation_id, attempt_order: attemptOrder, storage: 'runtime_only' }
      state.dispatch_requests.set(request.attempt_request_id, { signature: requestSignature, receipt })
      this.event(state, tx, { type: 'attempt.dispatch_intent', topic_id: unit.topic_id, translation_session_id: session.translation_session_id, unit_id: unit.unit_id, operation_id: request.operation_id })
      startId = attemptId
      return receipt
    })
    if (result.ok && startId) {
      const attemptId: string = startId
      const controller = new AbortController()
      this.controllers.set(attemptId, controller)
      void Promise.resolve().then(() => this.runAttempt(attemptId, controller))
    }
    if (!result.ok && ['execution_unavailable', 'policy_unconfirmed'].includes(result.error.code)) this.blockPreparation(input, result.error.code)
    return result
  }

  private markCancel(state: RuntimeState, tx: string, attempt: RuntimeAttempt): RuntimeAttempt {
    if (!['running', 'unknown', 'queued'].includes(attempt.status) || attempt.cancel_requested) return attempt
    const next: RuntimeAttempt = { ...attempt, cancel_requested: true, status: 'unknown', provider_state: 'unknown', failure_stage: 'cancel' }
    state.attempts.set(attempt.attempt_id, next)
    this.event(state, tx, { type: 'attempt.cancel_requested', topic_id: attempt.packet.topic_id, translation_session_id: attempt.packet.translation_session_id, unit_id: attempt.unit_id, operation_id: attempt.operation_id })
    return next
  }

  private abortCancelled(): void {
    for (const [attemptId, controller] of this.controllers) {
      if (this.state.attempts.get(attemptId)?.cancel_requested) controller.abort()
    }
  }

  cancel(input: Parameters<TranslationRuntimePort['cancel']>[0]): ReturnType<TranslationRuntimePort['cancel']> {
    const result = this.write(input, (state, request, tx) => {
      id(request.attempt_id)
      const attempt = state.attempts.get(request.attempt_id)
      if (!attempt) fail('not_found', 'Attempt not registered')
      return this.markCancel(state, tx, attempt)
    })
    if (result.ok && result.value.cancel_requested) this.abortCancelled()
    return result
  }

  private async runAttempt(attemptId: string, controller: AbortController): Promise<void> {
    let body = ''
    let terminal: TerminalEvent | null = null
    let usage: Usage = null
    let failure: 'stream' | 'protocol' | null = null
    try {
      const attempt = this.state.attempts.get(attemptId)
      if (!attempt || !this.adapter) return
      if (controller.signal.aborted) {
        // The provider has not been entered, so this cancellation has known evidence.
        this.settleAttempt(attemptId, '', { type: 'terminal', reason: 'aborted', completeness: 'incomplete', checks_passed: false, provider_state: 'stopped' }, usage, null, true)
        return
      }
      for await (const raw of this.adapter.execute(snapshot(attempt.packet), controller.signal)) {
        const event = structuredClone(raw)
        object(event)
        if (terminal) { failure = 'protocol'; break }
        if (event.type === 'text') {
          text(event.text, true)
          if (body.length + event.text.length > 2_000_000) { failure = 'protocol'; break }
          body += event.text
        } else if (event.type === 'usage') {
          if (event.input_tokens !== undefined) number(event.input_tokens)
          if (event.output_tokens !== undefined) number(event.output_tokens)
          usage = mergeUsage(usage, event)
        } else if (event.type === 'terminal') {
          if (!['stop', 'error', 'aborted', 'max_tokens'].includes(event.reason) || !['complete', 'incomplete'].includes(event.completeness) || typeof event.checks_passed !== 'boolean' || !['finished', 'stopped', 'unknown'].includes(event.provider_state)) {
            failure = 'protocol'; break
          }
          terminal = event
        } else { failure = 'protocol'; break }
      }
      if (!terminal && !failure) failure = 'protocol'
    } catch { failure = 'stream' }
    finally {
      this.settleAttempt(attemptId, body, terminal, usage, failure)
      this.controllers.delete(attemptId)
    }
  }

  private settleAttempt(attemptId: string, body: string, terminal: TerminalEvent | null, usage: Usage, failure: 'stream' | 'protocol' | null, notSent = false): void {
    this.write({ attempt_id: attemptId }, (state, request, tx) => {
      const attempt = state.attempts.get(request.attempt_id)
      if (!attempt || attempt.revision_id !== null || !['running', 'unknown'].includes(attempt.status)) return null
      const unit = this.unit(state, attempt.unit_id)
      const session = this.session(state, unit.translation_session_id, false)
      const record = this.operation(state, attempt.operation_id)
      const late = attempt.cancel_requested || attempt.status !== 'running' || session.lifecycle !== 'active' || unit.latest_candidate_order !== attempt.candidate_order || unit.source_version !== attempt.source_version || unit.instruction_version !== attempt.instruction_version
      const complete = !failure && terminal?.reason === 'stop' && terminal.provider_state === 'finished' && terminal.completeness === 'complete' && terminal.checks_passed === true && !!body.trim()
      let revision: RuntimeRevision | null = null
      if (body) {
        revision = {
          revision_id: this.newId('revision'), operation_id: attempt.operation_id, unit_id: attempt.unit_id,
          candidate_order: attempt.candidate_order, attempt_order: attempt.attempt_order, attempt_id: attempt.attempt_id,
          kind: 'machine', source_version: attempt.source_version, instruction_version: attempt.instruction_version,
          content_ref: this.capture(state, unit.topic_id, body), completeness: complete ? 'complete' : 'incomplete',
          checks_passed: complete, late,
        }
        state.revisions.set(revision.revision_id, revision)
        record.view = { ...record.view, operation_version: record.view.operation_version + 1, revision_ids: [...record.view.revision_ids, revision.revision_id] }
        this.event(state, tx, { type: late ? 'revision.late_recorded' : 'revision.recorded', topic_id: unit.topic_id, translation_session_id: unit.translation_session_id, unit_id: unit.unit_id, operation_id: attempt.operation_id, revision_id: revision.revision_id })
      }
      const providerState = notSent ? 'not_sent' : terminal?.provider_state ?? 'unknown'
      const status = !terminal || providerState === 'unknown' ? 'unknown'
        : attempt.cancel_requested || terminal.reason === 'aborted' ? 'cancelled'
          : complete ? 'completed' : 'failed'
      state.attempts.set(attempt.attempt_id, {
        ...attempt, status, provider_state: providerState, revision_id: revision?.revision_id ?? null,
        failure_stage: failure ?? (status === 'cancelled' ? 'cancel' : status === 'failed' ? 'stream' : null), usage,
      })
      this.event(state, tx, { type: `attempt.${status}`, topic_id: unit.topic_id, translation_session_id: unit.translation_session_id, unit_id: unit.unit_id, operation_id: attempt.operation_id })
      return null
    })
  }

  inspect(input: Parameters<TranslationRuntimePort['inspect']>[0]): ReturnType<TranslationRuntimePort['inspect']> {
    return this.read(input, request => this.operation(this.state, request.operation_id).view)
  }

  getSnapshot(input: Parameters<TranslationRuntimePort['getSnapshot']>[0]): ReturnType<TranslationRuntimePort['getSnapshot']> {
    return this.read(input, request => {
      const state = this.state
      const session = this.session(state, request.translation_session_id, false)
      const cursor = request.after_cursor ?? 0
      number(cursor)
      if (cursor > state.events.length) fail('stale_version', 'Event cursor is ahead of this runtime')
      const units = session.unit_ids.map(unitId => this.unit(state, unitId))
      const ids = new Set(session.unit_ids)
      return {
        session, topic: this.topic(state, session.topic_id), units,
        operations: [...state.operations.values()].map(record => record.view).filter(operation => operation.translation_session_id === session.translation_session_id),
        attempts: [...state.attempts.values()].filter(attempt => ids.has(attempt.unit_id)),
        revisions: [...state.revisions.values()].filter(revision => ids.has(revision.unit_id)),
        extraction_queue: [...state.extraction.values()].filter(item => item.translation_session_id === session.translation_session_id),
        events: state.events.filter(event => event.cursor > cursor && (event.translation_session_id === session.translation_session_id || (event.topic_id === session.topic_id && event.translation_session_id === undefined))),
        cursor: state.events.length, storage: 'runtime_only' as const,
      }
    })
  }

  readContent(input: Parameters<TranslationRuntimePort['readContent']>[0]): ReturnType<TranslationRuntimePort['readContent']> {
    return this.read(input, request => {
      this.topic(this.state, request.topic_id)
      return this.contents(this.state, request.topic_id, request.content_ref)
    })
  }
}
