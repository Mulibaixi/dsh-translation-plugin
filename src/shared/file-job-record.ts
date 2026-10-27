import type { FileJobProposal, FileJobSummary, FileJobWorker } from './file-jobs.js'

export const FILE_JOBS_STORAGE_PREFIX = 'dsh-translation-plugin:file-jobs:v1:'
export const fileJobsSessionPrefix = (sessionId: string): string => `${FILE_JOBS_STORAGE_PREFIX}${encodeURIComponent(sessionId)}:`
export interface FileJobTextVersion { readonly version: number; readonly text: string; readonly createdAt: string; readonly sourceVersion?: number; readonly baseVersion?: number; readonly deletion?: { readonly eventId: string; readonly at: string }; readonly semanticStatus?: 'pending' | 'passed' | 'changes_requested'; readonly legacyRevisionId?: string }
export interface FileJobCardState {
  readonly candidateId: string
  readonly draft?: FileJobProposal
  readonly status: 'pending' | 'adopted' | 'rejected'
  readonly assetId?: string
  readonly adoptedAt?: string
  readonly adoptedProposal?: FileJobProposal
  readonly eventId?: string
  readonly message?: string
  readonly draftBatchVersion?: number | undefined
}
export interface FileJobRecord {
  readonly schemaVersion: 1
  readonly summary: FileJobSummary
  readonly sources: readonly FileJobTextVersion[]
  readonly results: readonly FileJobTextVersion[]
  readonly proposals: readonly FileJobProposal[]
  readonly proposalVersion: number | null
  readonly cards: readonly FileJobCardState[]
  readonly workers: readonly FileJobWorker[]
  readonly preparation?: { readonly version: number; readonly context: string; readonly items: readonly unknown[] }
  readonly constraints?: readonly unknown[]
  readonly plan?: readonly unknown[]
  readonly checks?: readonly unknown[]
  readonly contexts?: readonly unknown[]
  readonly reviews?: readonly unknown[]
  readonly final: { readonly version: number; readonly selection: 'automatic' | 'user_fixed'; readonly selectedAt: string } | null
  readonly revisionOperations?: readonly { readonly operationId: string; readonly signature: string; readonly summary: FileJobSummary }[]
}
export function parseFileJobRecord(raw: string): FileJobRecord {
  const record = JSON.parse(raw) as FileJobRecord & { summary: FileJobSummary & { ownerId?: string; historyOwnerId?: string } }, summary = record?.summary
  if (record?.schemaVersion !== 1 || !summary?.jobId || typeof summary.mainSessionId !== 'string' || !summary.mainSessionId.trim() || (summary.ownerId !== undefined && summary.ownerId !== summary.mainSessionId) || !summary.translationSessionId ||
    !Number.isSafeInteger(summary.version) || !Array.isArray(record.sources) || !Array.isArray(record.results) ||
    !Array.isArray(record.proposals) || !Array.isArray(record.cards) || !Array.isArray(record.workers) ||
    [...record.sources, ...record.results].some(value => !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.text !== 'string' || value.sourceVersion !== undefined && (!Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1) || value.baseVersion !== undefined && (!Number.isSafeInteger(value.baseVersion) || value.baseVersion < 1 || value.baseVersion >= value.version) || value.deletion !== undefined && (!value.deletion || typeof value.deletion.eventId !== 'string' || !value.deletion.eventId.trim() || !Number.isFinite(Date.parse(value.deletion.at)) || value.text !== '')) ||
    record.sources.some(value => value.baseVersion !== undefined) ||
    new Set(record.proposals.map(value => value.candidateId)).size !== record.proposals.length ||
    new Set(record.cards.map(value => value.candidateId)).size !== record.cards.length ||
    record.final && !record.results.some(value => value.version === record.final!.version && !value.deletion)) throw new Error('文件任务历史格式无效。')
  const { ownerId: _legacyOwner, historyOwnerId: _legacyHistoryOwner, ...execution } = summary
  return { ...record, summary: execution }
}
