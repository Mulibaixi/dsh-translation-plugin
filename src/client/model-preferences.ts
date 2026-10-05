import { decodeRoute, type ModelRoute } from './sessions.js'

/** Only model routing preferences; no session content or provider credentials. */
export const SESSION_MODEL_PREFIX = 'dsh-translation-plugin:session-model:v1:'
export const OWNER_MODEL_PREFIX = 'dsh-translation-plugin:owner-model:v1:'
export function sessionModelKey(id: string): string { return SESSION_MODEL_PREFIX + encodeURIComponent(id) }
export function ownerModelKey(id: string): string { return OWNER_MODEL_PREFIX + encodeURIComponent(id) }
export function encodeModelPreference(model: ModelRoute | null): string { return JSON.stringify({ schemaVersion: 1, model }) }
export function decodeModelPreference(raw: string): ModelRoute | null | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 2 || record.schemaVersion !== 1 || !Object.hasOwn(record, 'model')) return undefined
    return decodeRoute(record.model)
  } catch { return undefined }
}
