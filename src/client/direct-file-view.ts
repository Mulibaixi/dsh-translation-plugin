import { h, react } from './react.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { ViewFilesClient, ViewFileTarget } from './view-files-client.js'
import type { LocalSession } from './sessions.js'
import type { TextUnit, TextRevision } from './translation-history.js'
import { pdfPageLabel, pdfUnitPages } from '../shared/pdf-source.js'
import { buildRevisionExport } from './revision-export.js'
import { Menu, MenuItemButton } from './native-ui.js'

export type DirectFile = ReturnType<MaterialSubmissionsClient['getFileUnits']>[number]
export interface FileOpenAction { readonly disabled: boolean; open(): void }
export function FileOpenMenu({ label, action }: { readonly label: string; readonly action: FileOpenAction }): unknown {
  const [open, setOpen] = react.useState(false)
  return h(Menu, { open, onClose: () => setOpen(false), portal: true, align: 'end', compact: true, listClassName: 'dsh-tp-popup',
    anchor: h('button', { type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value) }, '操作'),
  }, h(MenuItemButton, { disabled: action.disabled, onSelect: () => { setOpen(false); action.open() } }, '打开'))
}

/** Share the selected file and in-flight state between its name and the system-open action. */
export function useDirectFileOpen({ file, unit, revision, session, materials, viewFiles }: {
  readonly file?: DirectFile | undefined; readonly unit: TextUnit; readonly revision?: TextRevision | undefined
  readonly session: LocalSession; readonly materials?: MaterialSubmissionsClient | undefined; readonly viewFiles?: ViewFilesClient | undefined
}): { readonly link: unknown; readonly system: FileOpenAction } | undefined {
  const [pending, setPending] = react.useState(false), [message, setMessage] = react.useState<string | undefined>(undefined)
  const identity = JSON.stringify([session.id, unit.id, unit.sourceVersion, revision?.id, file?.unitId])
  const lifetime = react.useRef({ mounted: true, identity, controller: null as AbortController | null })
  lifetime.current.identity = identity
  react.useEffect(() => { lifetime.current.mounted = true; return () => { lifetime.current.mounted = false; lifetime.current.controller?.abort() } }, [])
  react.useEffect(() => { lifetime.current.controller?.abort() }, [identity])
  if (!file) return undefined
  const pages = pdfUnitPages(unit.id, unit.material?.materialId)
  const correctedSource = !pages && !revision && (unit.sourceVersion ?? 0) > 1
  const formatted = pages && !unit.deletion && !revision?.deletion && revision?.status === 'completed' && revision.text.trim() ? buildRevisionExport(unit, revision, file.name) : undefined
  const format = pages || /\.md$/iu.test(file.name) ? 'md' : 'txt'
  const name = revision ? formatted?.fileName ?? `${file.name.replace(/\.[^.]+$/u, '')}-译文-v${revision.order}.${format}`
    : correctedSource ? `${file.name.replace(/\.[^.]+$/u, '')}-原文.${format}` : file.name
  const disabled = pending || !viewFiles || !!unit.deletion || !!revision?.deletion
  const open = async (target: ViewFileTarget): Promise<void> => {
    if (disabled || lifetime.current.controller || !viewFiles) return
    const controller = new AbortController(), key = identity
    const active = () => lifetime.current.mounted && lifetime.current.identity === key && !controller.signal.aborted
    lifetime.current.controller = controller; setPending(true); setMessage(undefined)
    try {
      const slot = { namespaceId: viewFiles.getNamespaceId(), sessionId: session.id, unitId: unit.id,
        title: name, revisionId: revision?.id ?? `source:${unit.sourceVersion}`, fileName: name,
        ...(!pages && file.sourceRef?.originalFilePath ? { originalFilePath: file.sourceRef.originalFilePath } : {}) }
      const snapshot = revision || correctedSource ? undefined : await materials?.resolveFileSource(session.id, file.unitId)
      if (!active()) return
      const result = revision || correctedSource ? await viewFiles.open({ ...slot, kind: revision ? 'result' : 'source', text: formatted?.content ?? revision?.text ?? unit.source, format }, controller.signal, target)
        : snapshot ? await viewFiles.openSource({ ...slot, kind: 'source' }, snapshot, controller.signal, target) : { ok: false, message: '原稿暂不可打开，可稍后重试。' }
      if (active() && !result.ok) setMessage(result.message ?? '文件打开未完成，可重试。')
    } catch { if (active()) setMessage('文件打开未完成，可重试。') }
    finally { if (lifetime.current.controller === controller) { lifetime.current.controller = null; if (lifetime.current.mounted) setPending(false) } }
  }
  return { system: { disabled, open: () => { void open('system') } },
    link: h('div', { className: 'dsh-tp-file-name' }, h('button', { type: 'button', className: 'dsh-tp-object-link',
      'aria-label': `打开${revision ? '译文' : '原稿'}：${name}`, disabled,
      onClick: () => { void open('preview') } }, pending ? '正在打开…' : pages && !revision ? `${name} · ${pdfPageLabel(pages)}` : name), message ? h('small', { role: 'status' }, message) : null) }
}
