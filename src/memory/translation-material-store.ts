import type { DomainResult } from '../shared/domain-contracts.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialDecision, type TranslationMaterialEnvelope,
  type TranslationMaterialScope } from '../shared/translation-material.js'

function failure(code: 'invalid_state' | 'idempotency_conflict', message: string): DomainResult<never> {
  return { ok: false, error: { code, message } }
}
function success(envelope: TranslationMaterialEnvelope): DomainResult<TranslationMaterialEnvelope> {
  return { ok: true, value: structuredClone(envelope) }
}

/**
 * Pending submission snapshots only, kept in memory under owner/request identity.
 * Nothing writes history, creates a TextUnit, consumes a draft, or applies a source correction.
 * Source revision references reserve the later correction contract; they grant no execution authority.
 * Callers verify topic/session ownership and lifecycle at their actual submission boundary.
 */
export class TranslationMaterialStore {
  readonly storage = 'runtime_only' as const
  private readonly owners = new Map<string, Map<string, TranslationMaterialEnvelope>>()
  private disposed = false

  /** The capture must be synchronous at the chosen submission seam, before any preparation awaits. */
  freeze(scope: TranslationMaterialScope, capture: () => TranslationMaterialDecision): DomainResult<TranslationMaterialEnvelope> {
    if (this.disposed) return failure('invalid_state', '材料快照存储已关闭。')
    const prior = this.owners.get(scope.ownerId)?.get(scope.requestId)
    if (prior) {
      if (prior.mainSessionId !== scope.mainSessionId || prior.operationId !== scope.operationId) {
        return failure('idempotency_conflict', '此提交 ID 已绑定另一材料操作。')
      }
      return success(prior)
    }
    return this.insert(parseTranslationMaterialEnvelope({ ...capture(), ...scope }))
  }

  /** Ingest the same frozen envelope over a bridge; duplicate deliveries never replace its body. */
  receive(envelope: TranslationMaterialEnvelope): DomainResult<TranslationMaterialEnvelope> {
    if (this.disposed) return failure('invalid_state', '材料快照存储已关闭。')
    return this.insert(parseTranslationMaterialEnvelope(envelope))
  }

  private insert(snapshot: TranslationMaterialEnvelope): DomainResult<TranslationMaterialEnvelope> {
    const prior = this.owners.get(snapshot.ownerId)?.get(snapshot.requestId)
    if (prior) {
      return JSON.stringify(prior) === JSON.stringify(snapshot) ? success(prior)
        : failure('idempotency_conflict', '此提交 ID 的材料快照与原记录不一致。')
    }
    let requests = this.owners.get(snapshot.ownerId)
    if (!requests) { requests = new Map(); this.owners.set(snapshot.ownerId, requests) }
    requests.set(snapshot.requestId, snapshot)
    return success(snapshot)
  }

  /** Undefined means unknown or released, never an implicit `none` decision. */
  get(ownerId: string, requestId: string): TranslationMaterialEnvelope | undefined {
    const envelope = this.owners.get(ownerId)?.get(requestId)
    return envelope === undefined ? undefined : structuredClone(envelope)
  }

  release(ownerId: string, requestId: string): boolean {
    const requests = this.owners.get(ownerId)
    if (!requests?.delete(requestId)) return false
    if (!requests.size) this.owners.delete(ownerId)
    return true
  }

  dispose(): void { this.disposed = true; this.owners.clear() }
}
