import { TRANSLATION_RELEASES, UPDATE_BUSY_MESSAGE, releaseDownload, releasePage, type PluginUpdateRemote,
  type UpdateCheck, type UpdateInfo, type UpdatePhase, type UpdateResult } from '../shared/plugin-update.js'
import { h, react } from './react.js'

const progress: Record<UpdatePhase, string> = {
  downloading: '正在下载更新…', verifying: '正在校验安装包…', installing: '正在安装更新…',
}

interface Reply<T> { ok: boolean; value?: T }
function unwrap<T>(input: unknown): T {
  const reply = input as Reply<T> | undefined
  if (reply?.ok !== true || reply.value === undefined) throw new Error('Plugin update Host unavailable')
  return reply.value
}

function link(label: string, href: string): unknown {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label)
}

export function PluginUpdateView({ remote }: { readonly remote: () => Promise<PluginUpdateRemote | undefined> }): unknown {
  const [info, setInfo] = react.useState<UpdateInfo | undefined>(undefined)
  const [candidate, setCandidate] = react.useState<string | undefined>(undefined)
  const [message, setMessage] = react.useState<string | undefined>(undefined)
  const [action, setAction] = react.useState<'check' | 'install' | undefined>(undefined)
  const [offerDownload, setOfferDownload] = react.useState(false)
  const active = react.useRef(false)
  const mounted = react.useRef(false)

  react.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const monitoring = action === 'install' || !!info?.phase
  react.useEffect(() => {
    let stopped = false
    async function refresh(): Promise<void> {
      try {
        const next = unwrap<UpdateInfo>(await (await remote())?.info())
        if (!stopped) setInfo(next)
      } catch {
        if (!stopped && !monitoring) setMessage('无法读取插件更新状态。可打开发行页面查看版本。')
      }
    }
    void refresh()
    const timer = monitoring ? setInterval(() => void refresh(), 750) : undefined
    return () => { stopped = true; if (timer !== undefined) clearInterval(timer) }
  }, [remote, monitoring])

  async function run(kind: 'check' | 'install'): Promise<void> {
    if (active.current || info?.phase) return
    active.current = true
    setAction(kind); setMessage(undefined); setOfferDownload(false)
    try {
      const service = await remote()
      if (!service) throw new Error('Plugin update Host unavailable')
      if (kind === 'check') {
        setCandidate(undefined)
        const result = unwrap<UpdateCheck>(await service.check())
        if (!mounted.current) return
        if (result.status === 'available') setCandidate(result.version)
        else setMessage(result.status === 'current' ? '已是最新版本。' : result.message)
      } else if (candidate) {
        const result = unwrap<UpdateResult>(await service.installUpdate(candidate))
        if (!mounted.current) return
        if (result.status === 'failed') {
          setMessage(result.message)
          setOfferDownload(result.message !== UPDATE_BUSY_MESSAGE)
        } else {
          setCandidate(undefined)
          if (result.status === 'restart-required') setMessage(`已安装 v${result.version}，重启 DSH 后生效。`)
          else setMessage(`已应用 v${result.version}。`)
        }
      }
    } catch {
      if (!mounted.current) return
      setMessage(kind === 'check' ? '检查更新失败。请重试，或打开发行页面查看版本。'
        : '更新响应中断。请核对当前版本或在 DSH 插件管理器中查看状态，再决定是否重试。')
    } finally {
      active.current = false
      if (mounted.current) setAction(undefined)
    }
  }

  const busy = action !== undefined || info?.phase !== undefined
  const installed = info?.installedVersion
  const ready = info?.state === 'ready'
  const manual = info?.state === 'manual'
  const canCheck = ready || manual
  const stateMessage = info?.state === 'restart-required' ? `已安装 v${installed}，重启 DSH 后生效。`
    : info?.state === 'activation-failed' ? `已安装 v${installed}，但加载失败。请在 DSH 插件管理器中查看状态。` : undefined
  const status = info?.phase ? progress[info.phase] : action === 'install' ? '正在准备更新…'
    : action === 'check' ? '正在检查更新…' : stateMessage ?? message

  return h('section', { className: 'dsh-tp-settings-section', 'aria-label': '插件更新' },
    h('h3', null, '插件更新'),
    info ? h('p', null, `当前版本 v${info.currentVersion}${canCheck && candidate ? ` → v${candidate}` : ''}`)
      : message ? null : h('p', null, '正在读取当前版本…'),
    h('div', { className: 'dsh-tp-actions' },
      canCheck ? h('button', { type: 'button', disabled: busy, onClick: () => void run('check') }, '检查更新') : null,
      ready && candidate ? h('button', { type: 'button', disabled: busy, onClick: () => void run('install') }, `更新到 v${candidate}`) : null,
      link('发行说明', candidate ? releasePage(candidate) : TRANSLATION_RELEASES),
      (manual || offerDownload) && candidate && !busy ? link('下载安装包', releaseDownload(candidate)) : null),
    manual ? h('p', { className: 'dsh-tp-muted' }, '当前安装需手动更新。源码或目录链接安装请更新源码并重新构建。一键更新适用于通过 .tgz 安装的插件。') : null,
    status ? h('p', { role: 'status', className: 'dsh-tp-muted' }, status) : null)
}
