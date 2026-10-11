import { parseTranslationSourceRangeHash, parseTranslationSourceRangeHashResult,
  type TranslationSourceIntegrityPort } from '../shared/translation-source-integrity.js'

export type TranslationSourceIntegrityRemotePort = {
  verifyRangeHash(...args: Parameters<TranslationSourceIntegrityPort['verifyRangeHash']>): Promise<unknown>
}
export function adaptTranslationSourceIntegrityRemote(remote: TranslationSourceIntegrityRemotePort | undefined |
  (() => Promise<TranslationSourceIntegrityRemotePort | undefined>)): TranslationSourceIntegrityPort {
  return { verifyRangeHash: async request => {
    const fixed = parseTranslationSourceRangeHash(request), port = typeof remote === 'function' ? await remote() : remote
    if (!port || typeof port.verifyRangeHash !== 'function') throw new Error('原稿范围校验服务尚未就绪。')
    const response = await port.verifyRangeHash(fixed)
    if (!response || typeof response !== 'object' || Array.isArray(response) || (response as { ok?: unknown }).ok !== true) throw new Error('未取得原稿范围校验服务传输回执。')
    return parseTranslationSourceRangeHashResult((response as { value?: unknown }).value)
  } }
}
