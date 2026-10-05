import type { DomainResult } from '../shared/domain-contracts.js'
import type { QuickTranslationPort } from '../shared/quick-translation.js'
import { parseQuickResult } from '../shared/quick-translation.js'

export type QuickRemotePort = { [K in keyof QuickTranslationPort]: (...args: Parameters<QuickTranslationPort[K]>) => Promise<unknown> }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function unwrap<T>(method: keyof QuickTranslationPort, response: unknown): DomainResult<T> {
  // DSH Gateway carries the plugin's domain response inside its own RemoteResult.
  // A lost/invalid transport receipt does not prove that Host rejected execution.
  // Throwing preserves the submitted operation as unknown and prevents a new send.
  if (!object(response) || response.ok !== true || !object(response.value)) throw new Error('无法取得快译服务回执。')
  return parseQuickResult(method, response.value) as DomainResult<T>
}
export function adaptQuickRemote(remote: QuickRemotePort | undefined): QuickTranslationPort | undefined {
  if (!remote) return undefined
  return {
    capabilities: async () => unwrap('capabilities', await remote.capabilities()),
    open: async request => unwrap('open', await remote.open(request)),
    submit: async request => unwrap('submit', await remote.submit(request)),
    status: async request => unwrap('status', await remote.status(request)),
    cancel: async request => unwrap('cancel', await remote.cancel(request)),
  }
}
