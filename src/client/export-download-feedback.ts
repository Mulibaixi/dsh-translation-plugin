import { h, react } from './react.js'
import { Toast } from './native-ui.js'

interface DownloadNotice { readonly id: number; readonly fileName: string }

function ExportDownloadToast({ notice, onDone }: { readonly notice: DownloadNotice; readonly onDone: (id: number) => void }): unknown {
  // rc.2 Toast owns its body portal and hold/fade timer; a new key restarts it.
  return h(Toast, { key: notice.id, text: `已发起下载：${notice.fileName}`, tone: 'success', holdMs: 2500,
    onDone: () => onDone(notice.id) })
}

/** Local feedback only: retained hidden asset pages must not render a body portal. */
export function useExportDownloadFeedback(visible = true): {
  readonly toast: unknown; readonly downloadStarted: (fileName: string) => void; readonly clear: () => void
} {
  const [notice, setNotice] = react.useState<DownloadNotice | undefined>(undefined)
  const lifetime = react.useRef({ mounted: true, visible, sequence: 0 })
  lifetime.current.visible = visible
  react.useEffect(() => {
    lifetime.current.mounted = true
    return () => { lifetime.current.mounted = false }
  }, [])
  react.useEffect(() => { if (!visible) setNotice(undefined) }, [visible])
  return {
    toast: visible && notice ? h(ExportDownloadToast, { notice, onDone: (id: number) => {
      if (lifetime.current.mounted) setNotice(current => current?.id === id ? undefined : current)
    } }) : null,
    downloadStarted: fileName => {
      if (lifetime.current.mounted && lifetime.current.visible) setNotice({ id: ++lifetime.current.sequence, fileName })
    },
    clear: () => { if (lifetime.current.mounted) setNotice(undefined) },
  }
}
