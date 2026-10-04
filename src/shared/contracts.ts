import type { TranslationRuntimePort } from './domain-contracts.js'

export type EntityId<T extends string> = string & { readonly __entity: T }

export type ProjectId = EntityId<'ProjectId'>
export type TranslationSessionId = EntityId<'TranslationSessionId'>
export type SourceUnitId = EntityId<'SourceUnitId'>
export type OperationId = EntityId<'OperationId'>
export type AttemptId = EntityId<'AttemptId'>
export type RevisionId = EntityId<'RevisionId'>

export type TranslationMode = 'normal' | 'quick'

export type AttemptStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

export interface ModelSelection {
  readonly providerId: string
  readonly modelId: string
  readonly configVersion: number
  readonly reasoningEffort?: string
}

export interface TranslationSession {
  readonly id: TranslationSessionId
  readonly projectId: ProjectId
  readonly mode: TranslationMode
  readonly mainSessionId?: string
  readonly modelOverride?: ModelSelection
  readonly contextEpoch: number
  readonly revision: number
}

export interface SourceUnit {
  readonly id: SourceUnitId
  readonly sessionId: TranslationSessionId
  readonly sourceVersion: number
  readonly instructionVersion: number
  readonly sourceText: string
  readonly instruction: string
  readonly order: number
}

export interface MemoryItem {
  readonly id: string
  readonly text: string
  readonly source: 'user' | 'approved'
}

export interface MemoryView {
  readonly id: string
  readonly epoch: number
  readonly items: readonly MemoryItem[]
}

export interface TranslationPacket {
  readonly schemaVersion: 1
  readonly attemptId: AttemptId
  readonly operationId: OperationId
  readonly mode: TranslationMode
  readonly sessionId: TranslationSessionId
  readonly unit: SourceUnit
  readonly model: ModelSelection
  readonly baseRevisionId?: RevisionId
  readonly memoryView: MemoryView
  readonly promptVersion: string
  readonly maxOutputTokens?: number
}

export interface TranslationAttempt {
  readonly id: AttemptId
  readonly operationId: OperationId
  readonly unitId: SourceUnitId
  readonly sourceVersion: number
  readonly instructionVersion: number
  readonly model: ModelSelection
  readonly status: AttemptStatus
  readonly createdAt: string
  readonly finishedAt?: string
}

export interface TranslationRevision {
  readonly id: RevisionId
  readonly unitId: SourceUnitId
  readonly kind: 'machine' | 'manual'
  readonly text: string
  readonly basedOnRevisionId?: RevisionId
  readonly attemptId?: AttemptId
  readonly sourceVersion: number
  readonly instructionVersion: number
  readonly createdAt: string
}

export interface MemoryRequest {
  readonly projectId: ProjectId
  readonly sessionId: TranslationSessionId
  readonly unitId: SourceUnitId
  readonly epoch: number
}

export interface MemoryPort {
  prepare(request: MemoryRequest): Promise<MemoryView>
}

export type TranslationChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'error' | 'aborted' }

export interface TranslationExecutorPort {
  execute(packet: TranslationPacket, signal: AbortSignal): AsyncIterable<TranslationChunk>
}

export interface TranslationSnapshot {
  readonly session: TranslationSession
  readonly units: readonly SourceUnit[]
  readonly attempts: readonly TranslationAttempt[]
  readonly revisions: readonly TranslationRevision[]
  readonly adoptedRevisionByUnit: Readonly<Record<string, RevisionId | undefined>>
  readonly cursor: number
}

export interface TranslationAppPort {
  getSnapshot(sessionId: TranslationSessionId): Promise<TranslationSnapshot>
  createUnit(input: {
    sessionId: TranslationSessionId
    expectedSessionRevision: number
    sourceText: string
    instruction: string
  }): Promise<SourceUnit>
  submit(input: {
    sessionId: TranslationSessionId
    unitId: SourceUnitId
    operationId: OperationId
    expectedSourceVersion: number
    expectedInstructionVersion: number
    baseRevisionId?: RevisionId
  }): Promise<{ attemptId: AttemptId }>
  cancel(attemptId: AttemptId): Promise<void>
  addManualRevision(input: {
    unitId: SourceUnitId
    text: string
    basedOnRevisionId?: RevisionId
    adopt: boolean
    expectedPointerVersion?: number
  }): Promise<TranslationRevision>
  adopt(input: {
    unitId: SourceUnitId
    revisionId: RevisionId
    expectedPointerVersion: number
  }): Promise<{ pointerVersion: number }>
}

export interface TranslationFrameworkServices {
  readonly contractVersion: 1
  readonly memory: MemoryPort
  readonly domainVersion: 1
  readonly runtime: TranslationRuntimePort
}
