import { parseTranslationSourceResult, type TranslationSourcesPort, type TranslationSourceResult } from '../shared/translation-sources.js'

export type TranslationSourcesRemotePort = { [K in keyof TranslationSourcesPort]: (...args: Parameters<TranslationSourcesPort[K]>) => Promise<unknown> }

/** The native Gateway wraps the source service's typed business result once. */
export function adaptTranslationSourcesRemote(remote: TranslationSourcesRemotePort | undefined | (() => Promise<TranslationSourcesRemotePort | undefined>)): TranslationSourcesPort {
  async function invoke<T>(method: keyof TranslationSourcesPort, args: readonly unknown[]): Promise<TranslationSourceResult<T>> {
    const port = typeof remote === 'function' ? await remote() : remote
    if (!port) throw new Error('原稿服务尚未就绪。')
    const response = await (port[method] as (...args: readonly unknown[]) => Promise<unknown>)(...args)
    if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) throw new Error('未取得原稿服务传输回执。')
    return parseTranslationSourceResult(method, (response as { value?: unknown }).value) as TranslationSourceResult<T>
  }
  return { capabilities: () => invoke('capabilities', []), importReceipt: (request, signal) => invoke('importReceipt', [request, signal]),
    readRange: request => invoke('readRange', [request]) }
}
