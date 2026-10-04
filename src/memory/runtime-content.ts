import type { RuntimeContentRef } from '../shared/domain-contracts.js'

export interface RuntimeContentRecord {
  readonly topic_id: string
  readonly text: string
  readonly ref: RuntimeContentRef
}

/** The map belongs to a staged business transaction. Nothing here writes to disk. */
export function captureText(
  contents: Map<string, RuntimeContentRecord>,
  contentId: string,
  topicId: string,
  text: string,
): RuntimeContentRef {
  if (contents.has(contentId)) throw new Error('Content identity collision')
  const ref = { content_id: contentId, code_points: Array.from(text).length }
  contents.set(contentId, { topic_id: topicId, text, ref })
  return ref
}
