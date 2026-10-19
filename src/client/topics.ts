/** 浏览器本地主题身份；不包含名称、备注或翻译正文。 */
export interface TopicAllocation { readonly sessionId: string; readonly sequence: number }
export interface TopicIdentity {
  readonly schemaVersion: 1
  readonly id: string
  /** Legacy asset storage anchor (original creator); main Sessions may share this topic. */
  readonly ownerId: string
  readonly sequenceNamespaceId: string
  readonly nextSequence: number
  readonly version: number
  readonly allocations: readonly TopicAllocation[]
}
export interface TopicNameRecord {
  readonly schemaVersion: 1
  readonly topicId: string
  readonly sequenceNamespaceId: string
  readonly name: string
  readonly version: number
}
export const TOPIC_IDENTITY_PREFIX = 'dsh-translation-plugin:topic-identity:v1:'
export const TOPIC_NAME_PREFIX = 'dsh-translation-plugin:topic-name:v1:'
export const DELETED_SESSION_PREFIX = 'dsh-translation-plugin:deleted-session:v1:'
export const DELETED_TOPIC_PREFIX = 'dsh-translation-plugin:deleted-topic:v1:'
export const TOPIC_DELETION_INTENT_PREFIX = 'dsh-translation-plugin:topic-deletion-intent:v1:'
export const TOPIC_LOCK_NAME = 'dsh-translation-plugin:topic-structures:v1'
export function topicIdentityKey(id: string): string { return `${TOPIC_IDENTITY_PREFIX}${encodeURIComponent(id)}` }
export function topicNameKey(id: string): string { return `${TOPIC_NAME_PREFIX}${encodeURIComponent(id)}` }
export function deletedSessionKey(id: string): string { return `${DELETED_SESSION_PREFIX}${encodeURIComponent(id)}` }
export function deletedTopicKey(id: string): string { return `${DELETED_TOPIC_PREFIX}${encodeURIComponent(id)}` }
export function topicDeletionIntentKey(id: string): string { return `${TOPIC_DELETION_INTENT_PREFIX}${encodeURIComponent(id)}` }
export interface TopicDeletionTombstone {
  readonly schemaVersion: 1
  readonly topicId: string
  readonly sequenceNamespaceId: string
  readonly nextSequence: number
  readonly sessionCount: number
  readonly at: string
  readonly operationId: string
}
export interface TopicDeletionIntent {
  readonly schemaVersion: 1
  readonly topicId: string
  readonly operationId: string
  readonly at: string
  readonly sessionIds: readonly string[]
  readonly identityStored: string | null
  readonly nameStored: string | null
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && !!value.trim() && Array.from(value).length <= maximum }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }

export function decodeTopicIdentity(raw: string): TopicIdentity | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !exact(value, ['schemaVersion', 'id', 'ownerId', 'sequenceNamespaceId', 'nextSequence', 'version', 'allocations']) ||
      value.schemaVersion !== 1 || !text(value.id, 3000) || !text(value.ownerId, 1000) || !text(value.sequenceNamespaceId, 3000) ||
      !integer(value.nextSequence) || !integer(value.version) || !Array.isArray(value.allocations)) return undefined
    const ids = new Set<string>(), numbers = new Set<number>()
    const allocations: TopicAllocation[] = []
    for (const entry of value.allocations) {
      if (!record(entry) || !exact(entry, ['sessionId', 'sequence']) || !text(entry.sessionId, 2048) || !integer(entry.sequence) ||
        entry.sequence >= value.nextSequence || ids.has(entry.sessionId) || numbers.has(entry.sequence)) return undefined
      ids.add(entry.sessionId); numbers.add(entry.sequence)
      allocations.push({ sessionId: entry.sessionId, sequence: entry.sequence })
    }
    return { ...value, allocations } as unknown as TopicIdentity
  } catch { return undefined }
}

export function decodeTopicName(raw: string, identity: TopicIdentity): TopicNameRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !exact(value, ['schemaVersion', 'topicId', 'sequenceNamespaceId', 'name', 'version']) || value.schemaVersion !== 1 ||
      value.topicId !== identity.id || value.sequenceNamespaceId !== identity.sequenceNamespaceId || !text(value.name, 120) || !integer(value.version)) return undefined
    return value as unknown as TopicNameRecord
  } catch { return undefined }
}

export function decodeDeletion(raw: string, id: string): { readonly legacyKey: string | null } | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !exact(value, ['schemaVersion', 'sessionId', 'legacyKey']) || value.schemaVersion !== 1 || value.sessionId !== id ||
      !(value.legacyKey === null || (text(value.legacyKey, 2000) && value.legacyKey.startsWith('dsh-translation-plugin:draft:v1:')))) return undefined
    return { legacyKey: value.legacyKey }
  } catch { return undefined }
}

function time(value: unknown): value is string { return text(value, 40) && Number.isFinite(Date.parse(value)) }

/** A deleted topic keeps its numbering namespace but never reappears in listings. */
export function decodeTopicDeletion(raw: string, id: string): TopicDeletionTombstone | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !exact(value, ['schemaVersion', 'topicId', 'sequenceNamespaceId', 'nextSequence', 'sessionCount', 'at', 'operationId']) ||
      value.schemaVersion !== 1 || value.topicId !== id || !text(value.sequenceNamespaceId, 3000) || !integer(value.nextSequence) ||
      !integer(value.sessionCount) || !time(value.at) || !text(value.operationId, 3000)) return undefined
    return value as unknown as TopicDeletionTombstone
  } catch { return undefined }
}

/** The intent blocks late writes between local commit and Host reclamation. */
export function decodeTopicDeletionIntent(raw: string, id: string): TopicDeletionIntent | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !exact(value, ['schemaVersion', 'topicId', 'operationId', 'at', 'sessionIds', 'identityStored', 'nameStored']) ||
      value.schemaVersion !== 1 || value.topicId !== id || !time(value.at) || !text(value.operationId, 3000) ||
      !Array.isArray(value.sessionIds) || value.sessionIds.length > 500 || new Set(value.sessionIds).size !== value.sessionIds.length ||
      !value.sessionIds.every(sessionId => text(sessionId, 2048)) ||
      !(value.identityStored === null || text(value.identityStored, 200000)) || !(value.nameStored === null || text(value.nameStored, 100000))) return undefined
    return value as unknown as TopicDeletionIntent
  } catch { return undefined }
}
