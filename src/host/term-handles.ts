/** Short, opaque handles for term query results so a model can pass a reference without copying a long id. */
export interface TermHandleTarget { readonly id: string; readonly entryVersion: number }

interface StoredHandle { readonly mainSessionId: string; readonly target: TermHandleTarget; readonly at: number }

const ALPHABET = '0123456789abcdefghjkmnpqrstuvwxyz'

/** Bound to one main Session and one query result version; never silently follows a newer entry version. */
export class TermHandleRegistry {
  private readonly entries = new Map<string, StoredHandle>()
  constructor(private readonly limit = 512, private readonly ttlMs = 30 * 60_000) {}

  mint(mainSessionId: string, target: TermHandleTarget, at = Date.now()): string {
    this.prune(at)
    let handle = this.token()
    while (this.entries.has(handle)) handle = this.token()
    this.entries.set(handle, { mainSessionId, target: { id: target.id, entryVersion: target.entryVersion }, at })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
    return handle
  }

  resolve(mainSessionId: string, handle: string, at = Date.now()): TermHandleTarget | undefined {
    const stored = this.entries.get(handle)
    if (!stored || stored.mainSessionId !== mainSessionId) return undefined
    if (at - stored.at > this.ttlMs) { this.entries.delete(handle); return undefined }
    return { ...stored.target }
  }

  get size(): number { return this.entries.size }
  clear(): void { this.entries.clear() }

  private prune(at: number): void {
    for (const [handle, stored] of this.entries) {
      if (at - stored.at > this.ttlMs) this.entries.delete(handle)
      else break
    }
  }

  private token(): string {
    const bytes = new Uint8Array(10)
    const webcrypto = (globalThis as { crypto?: { getRandomValues?(array: Uint8Array): Uint8Array } }).crypto
    if (typeof webcrypto?.getRandomValues === 'function') webcrypto.getRandomValues(bytes)
    else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
    return `tr-${[...bytes].map(byte => ALPHABET[byte % ALPHABET.length]).join('')}`
  }
}
