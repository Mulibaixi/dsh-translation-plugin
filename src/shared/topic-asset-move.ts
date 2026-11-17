import { referenceExact, referenceString } from './reference-memory.js'

export interface TopicAssetMove {
  readonly kind: 'move'
  readonly id: string
  readonly targetId: string
  readonly after: boolean
}

export function validateTopicAssetMove(value: Record<string, unknown>): void {
  referenceExact(value, ['kind', 'id', 'targetId', 'after'])
  referenceString(value.id)
  referenceString(value.targetId)
  if (typeof value.after !== 'boolean') throw new TypeError('Invalid asset move direction')
}
