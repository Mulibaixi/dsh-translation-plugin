import { parsePreparationSnapshot, type PreparationSnapshot } from './translation-preparation.js'
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export interface Operation { readonly signature: string; readonly version: number }
export interface StoredPreparation {
  readonly schemaVersion: 1 | 2 | 3
  readonly cursorToken: string
  readonly prepareSignature: string
  readonly candidateCount: number
  readonly versions: readonly PreparationSnapshot[]
  readonly operations: Readonly<Record<string, Operation>>
}
export function parsePreparationRecord(raw: string, allowRuntime = false): StoredPreparation {
    const input = JSON.parse(raw) as StoredPreparation
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 6 || !['schemaVersion', 'cursorToken', 'prepareSignature', 'candidateCount', 'versions', 'operations'].every(field => Object.hasOwn(input, field))) throw new TypeError('Unexpected preparation audit fields')
    const audit = { ...input, versions: input.versions.map(parsePreparationSnapshot) }
    if (!audit || ![1, 2, 3].includes(audit.schemaVersion) || typeof audit.cursorToken !== 'string' || !/^[0-9a-f-]{36}$/u.test(audit.cursorToken) || typeof audit.prepareSignature !== 'string' || !Number.isSafeInteger(audit.candidateCount) || audit.candidateCount < 0 || !Array.isArray(audit.versions) || !audit.versions.length || !audit.operations || typeof audit.operations !== 'object' || Array.isArray(audit.operations)) throw new TypeError('Invalid preparation audit')
    if (audit.schemaVersion === 1 && audit.versions.some(version => version.referenceContextRef)) throw new TypeError('Reference context requires preparation audit version 2')
    const first = audit.versions[0]!
    for (const [index, snapshot] of audit.versions.entries()) {
      if ((audit.schemaVersion === 3 ? snapshot.version <= (audit.versions[index - 1]?.version ?? 0) : snapshot.version !== index + 1) || snapshot.id !== first.id || !same(snapshot.scope, first.scope) || !same(snapshot.route, first.route) || snapshot.targetLanguage !== first.targetLanguage || snapshot.userRequirements !== first.userRequirements || !same(snapshot.mechanicalCoverage, first.mechanicalCoverage) || snapshot.storage !== 'saved' && (!allowRuntime || snapshot.storage !== 'runtime_only')) throw new TypeError('Invalid preparation audit version')
      if (snapshot.correctionReview) {
        const previous = audit.versions[index - 1], basis = snapshot.correctionReview.analysisBasis
        const original = audit.schemaVersion === 3 ? first.correctionReview?.analysisBasis ?? first : first
        if ((!previous && audit.schemaVersion !== 3) || previous && (snapshot.sourceVersion < previous.sourceVersion || snapshot.sourceVersion === previous.sourceVersion && (!previous.correctionReview || !same(snapshot.target, previous.target) || snapshot.sourceSha256 !== previous.sourceSha256) || previous.target.kind === 'unit' && snapshot.target.kind === 'unit' && previous.target.unitId !== snapshot.target.unitId) || basis.sourceVersion !== original.sourceVersion || basis.sourceSha256 !== original.sourceSha256 || basis.totalCodePoints !== original.totalCodePoints) throw new TypeError('Invalid correction preparation lineage')
      } else if (!same(snapshot.target, first.target) || snapshot.sourceSha256 !== first.sourceSha256) throw new TypeError('Invalid original preparation source')
      const calculated = snapshot.correctionReview?.complete ?? (snapshot.mechanicalCoverage.complete && snapshot.modelReview.complete && snapshot.conflicts.length === 0)
      if (snapshot.version > 1 && snapshot.preparationReady !== calculated) throw new TypeError('Invalid preparation eligibility')
      if (!Array.isArray(snapshot.terms) || !Array.isArray(snapshot.questions) || !Array.isArray(snapshot.conflicts) || !Array.isArray(snapshot.backgroundRanges) || snapshot.referenceRefs.length) throw new TypeError('Invalid preparation audit content')
    }
    for (const [operationId, operation] of Object.entries(audit.operations)) if (!operationId || typeof operation.signature !== 'string' || !Number.isSafeInteger(operation.version) || audit.versions.find(snapshot => snapshot.version === operation.version)?.operationId !== operationId) throw new TypeError('Invalid preparation audit operation')
    return audit
  }
