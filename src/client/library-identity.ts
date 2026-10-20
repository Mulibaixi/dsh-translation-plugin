import type { LocalStoragePort } from './session-store.js'

/** Reuse the existing reference namespace as the identity of this local library. */
export const LIBRARY_NAMESPACE_KEY = 'dsh-translation-plugin:references:v1:namespace'
export function libraryNamespace(storage?: LocalStoragePort): string {
  try { const saved = storage?.getItem(LIBRARY_NAMESPACE_KEY); if (saved?.trim()) return saved } catch { /* Runtime-only library when storage is unavailable. */ }
  const namespace = crypto.randomUUID()
  try { storage?.setItem(LIBRARY_NAMESPACE_KEY, namespace) } catch { /* Keep this instance usable without persistence. */ }
  return namespace
}
