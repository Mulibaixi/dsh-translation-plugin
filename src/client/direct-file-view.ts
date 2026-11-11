import { h, react } from './react.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { ViewFilesClient } from './view-files-client.js'
import type { LocalSession } from './sessions.js'
import type { TextUnit, TextRevision } from './translation-history.js'

export type DirectFile = ReturnType<MaterialSubmissionsClient['getFileUnits']>[number]
/** File-backed direct translations keep their existing version bodies, displaying file links. */
export function DirectFileLink({ file, unit, revision, session, materials, viewFiles }: {
  readonly file: DirectFile; readonly unit: TextUnit; readonly revision?: TextRevision | undefined
  readonly session: LocalSession; readonly materials?: MaterialSubmissionsClient | undefined; readonly viewFiles?: ViewFilesClient | undefined
}): unknown {
  const [pending, setPending] = react.useState(false), [message, setMessage] = react.useState<string | undefined>(undefined)
  const identity = `${unit.id}:${unit.sourceVersion}:${revision?.id ?? 'source'}`
  const lifetime = react.useRef({ mounted: true, identity, controller: null as AbortController | null })
  lifetime.current.identity = identity
  react.useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false; lifetime.current.controller?.abort() } }, [])
  react.useEffect(() => { lifetime.current.controller?.abort() }, [identity])
  const correctedSource = !revision && (unit.sourceVersion ?? 0) > 1
  const format = /\.md$/iu.test(file.name) ? 'md' : 'txt'
  const name = revision ? `${file.name.replace(/\.[^.]+$/u, '')}-译文-v${revision.order}.${format}`
    : correctedSource ? `${file.name.replace(/\.[^.]+$/u, '')}-原文.${format}` : file.name
  async function open(): Promise<void> {
    if (lifetime.current.controller || !viewFiles) return
    const controller = new AbortController(), key = identity
    const active = () => lifetime.current.mounted && lifetime.current.identity === key && !controller.signal.aborted
    lifetime.current.controller = controller; setPending(true); setMessage(undefined)
    try {
      const slot = { namespaceId: viewFiles.getNamespaceId(), sessionId: session.id, unitId: unit.id,
        title: name, revisionId: revision?.id ?? `source:${unit.sourceVersion}`, fileName: name,
        ...(file.sourceRef?.originalFilePath ? { originalFilePath: file.sourceRef.originalFilePath } : {}) }
      const snapshot = revision || correctedSource ? undefined : await materials?.resolveFileSource(session.id, file.unitId)
      if (!active()) return
      const result = revision || correctedSource ? await viewFiles.open({ ...slot, kind: revision ? 'result' : 'source', text: revision?.text ?? unit.source, format }, controller.signal)
        : snapshot ? await viewFiles.openSource({ ...slot, kind: 'source' }, snapshot, controller.signal) : { ok: false, message: '原稿暂不可打开，可稍后重试。' }
      if (active() && !result.ok) setMessage(result.message ?? '文件打开未完成，可重试。')
    } catch { if (active()) setMessage('文件打开未完成，可重试。') }
    finally { if (lifetime.current.controller === controller) { lifetime.current.controller = null; if (lifetime.current.mounted) setPending(false) } }
  }
  return h('div', { className: 'dsh-tp-file-name' }, h('button', { type: 'button', className: 'dsh-tp-object-link',
    'aria-label': `打开${revision ? '译文' : '原稿'}：${name}`, disabled: pending || !viewFiles || !!unit.deletion || !!revision?.deletion,
    onClick: () => { void open() } }, pending ? '正在打开…' : name), message ? h('small', { role: 'status' }, message) : null)
}
