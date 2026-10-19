/** Shared deletion vocabulary; execution stays in the owning stores until later phases. */
export type DeletionLevel = 'revision' | 'unit' | 'session' | 'topic' | 'plugin'
export type DeletionStatus = 'deleted' | 'blocked' | 'stale' | 'failed' | 'unknown'
export type DeletionPlaneStatus = 'deleted' | 'kept' | 'failed' | 'skipped'

export interface DeletionPlaneOutcome {
  readonly plane: string
  readonly status: DeletionPlaneStatus
  readonly message?: string
}

/** Future cross-store executor result; current single-store results use `DeletionStatus`. */
export interface DeletionOutcome {
  readonly operationId: string
  readonly status: DeletionStatus | 'partial'
  readonly planes: readonly DeletionPlaneOutcome[]
  readonly message: string
}

const prefixes: Readonly<Record<DeletionLevel, string>> = {
  revision: 'revision-delete', unit: 'unit-delete', session: 'session-delete', topic: 'topic-delete', plugin: 'plugin-delete',
}

/** Stable operation identity shared by the UI, the pending receipt and the storage token. */
export function deletionOperationId(level: DeletionLevel, makeId?: () => string): string {
  const suffix = makeId?.() ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`
  return `${prefixes[level]}:${suffix}`
}
