import type { TranslationSourceRange } from './translation-source-read.js'

/** Fixed evidence identity. Final offsets address the ordered manifest projection. */
export interface EvidenceReadRequest {
  readonly ownerId: string
  readonly topicId: string
  readonly sessionId: string
  readonly unitId: string
  readonly sourceVersion: number
  readonly side: 'source' | 'final'
  readonly range: TranslationSourceRange | null
  readonly revisionId: string | null
  readonly selectionEventId: string | null
}
export interface EvidenceReadyResult {
  readonly status: 'ready'
  readonly request: EvidenceReadRequest
  readonly range: TranslationSourceRange
  readonly totalCodePoints: number
  readonly sourceVersion: number
  readonly manifestRevisionId: string | null
  readonly text: string
}
export interface EvidenceUnavailableResult {
  readonly status: 'unloaded' | 'missing' | 'corrupt' | 'forbidden'
  /** Null only when a legacy reference cannot establish a fixed readable identity. */
  readonly request: EvidenceReadRequest | null
  readonly reason: string
  readonly totalCodePoints?: number
}
export type EvidenceReadResult = EvidenceReadyResult | EvidenceUnavailableResult
