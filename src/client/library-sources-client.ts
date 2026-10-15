import { parseLibrarySourceRequest, parseLibrarySourceResult, type LibrarySourcesPort } from '../shared/library-sources.js'
export type LibrarySourcesRemotePort = { readLibrarySource(...args: Parameters<LibrarySourcesPort['readLibrarySource']>): Promise<unknown> }
export function adaptLibrarySourcesRemote(remote: LibrarySourcesRemotePort | (() => Promise<LibrarySourcesRemotePort | undefined>) | undefined): LibrarySourcesPort {
  return { async readLibrarySource(request, signal) {
    const fixed = parseLibrarySourceRequest(request), port = typeof remote === 'function' ? await remote() : remote
    signal?.throwIfAborted()
    if (!port) throw new Error('共享原稿读取服务尚未就绪。')
    const reply = await port.readLibrarySource(fixed, signal) as { ok?: boolean; value?: unknown }
    if (reply?.ok !== true) throw new Error('共享原稿读取未取得传输回执。')
    return parseLibrarySourceResult(reply.value)
  } }
}
