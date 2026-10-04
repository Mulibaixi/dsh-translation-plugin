/** 浏览器本地主题身份；不包含名称、备注或翻译正文。 */
export interface TopicAllocation { readonly sessionId: string; readonly sequence: number }
export interface TopicIdentity {
  readonly schemaVersion: 1
  readonly id: string
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
export const TOPIC_LOCK_NAME = 'dsh-translation-plugin:topic-structures:v1'
export function topicIdentityKey(id: string): string { return `${TOPIC_IDENTITY_PREFIX}${encodeURIComponent(id)}` }
export function topicNameKey(id: string): string { return `${TOPIC_NAME_PREFIX}${encodeURIComponent(id)}` }
export function deletedSessionKey(id: string): string { return `${DELETED_SESSION_PREFIX}${encodeURIComponent(id)}` }

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
