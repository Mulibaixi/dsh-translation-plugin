import { h } from './react.js'
import { PanelRouter, SettingsView } from './components.js'
import { createSessionStore } from './session-store.js'
import { ModelCatalog, type ModelCatalogPort } from './models.js'
import { QuickTranslationClient } from './quick-translation.js'
import { adaptQuickRemote, type QuickRemotePort } from './quick-transport.js'
import { QUICK_TRANSLATION_REMOTE } from '../shared/quick-translation.js'

type Disposer = () => void
type AsyncDisposer = () => void | Promise<void>
type ClientComponent = (props?: Readonly<Record<string, unknown>>) => unknown

interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly title: (address: string) => string
  readonly guide: readonly {
    readonly id: string
    readonly order: number
    readonly title: () => string
    readonly description: () => string
  }[]
}

interface ClientPluginContext {
  get(name: 'remote.translationQuick'): QuickRemotePort | undefined
  readonly remote: {
    readonly session: ModelCatalogPort
    readonly translationQuick?: QuickRemotePort
    $mount?(contribution: typeof QUICK_TRANSLATION_REMOTE): Promise<AsyncDisposer>
    $on(event: string, listener: () => void): Disposer
  }
  on(event: string, listener: () => void): Disposer
  readonly sidebarRightTabs: { register(definition: SidebarRightTabDefinition): Disposer }
  readonly slots: {
    register(
      target: { readonly name: string; readonly key?: string; readonly id?: string; readonly order?: number; readonly label?: string },
      component: ClientComponent,
    ): Disposer
    inject(name: string, register: () => Disposer): Disposer
  }
  effect(effect: () => void | AsyncDisposer, name?: string): unknown
}

const CLIENT_ID = 'dsh-translation-plugin'
export const name = 'dsh-translation-client'
export const inject = ['sidebarRightTabs', 'slots', 'remote', 'remote.session'] as const

function withClientDiagnostics<T>(stage: string, action: () => T): T {
  try { return action() } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
    console.error(`[${CLIENT_ID}] Client ${stage} failed: ${detail}`)
    throw error
  }
}

export function apply(ctx: ClientPluginContext): void {
  withClientDiagnostics('apply', () => {
    const store = createSessionStore()
    const models = new ModelCatalog(ctx.remote.session)
    let quickDisposed = false
    // DSH installs remote.translationQuick asynchronously and returns its disposer only after mounting.
    const mountedQuick = (async () => ctx.remote.$mount?.(QUICK_TRANSLATION_REMOTE))().catch(error => {
      const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
      console.error(`[${CLIENT_ID}] Client translationQuick mount failed: ${detail}`)
      return undefined
    })
    const quick = new QuickTranslationClient(adaptQuickRemote(ctx.remote.$mount ? async () => {
      const unmountQuick = await mountedQuick
      return quickDisposed || !unmountQuick ? undefined : ctx.get('remote.translationQuick')
    } : ctx.remote.translationQuick), store, models)
    ctx.effect(() => () => store.dispose(), 'translation client store')
    ctx.effect(() => () => models.dispose(), 'translation model catalog')
    ctx.effect(() => async () => {
      quickDisposed = true
      quick.dispose()
      const unmountQuick = await mountedQuick
      await unmountQuick?.()
    }, 'translation quick client')
    ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => models.invalidate()), 'translation catalog invalidation')
    ctx.effect(() => ctx.remote.$on('settings/document-updated', () => models.invalidate()), 'translation catalog settings')
    ctx.effect(() => ctx.on('connection/reset', () => { models.invalidate(true); quick.reset() }), 'translation catalog connection')

    const TranslationPanel: ClientComponent = (props = {}) => h(PanelRouter, {
      store, models, quick, sessionId: typeof props.sessionId === 'string' ? props.sessionId : undefined,
    })
    const TranslationSettings: ClientComponent = (props = {}) => h(SettingsView, {
      store, onClose: typeof props.close === 'function' ? props.close : undefined,
    })

    ctx.effect(() => withClientDiagnostics('sidebarRightTabs.register', () => ctx.sidebarRightTabs.register({
      id: CLIENT_ID,
      kind: 'translation-workspace',
      title: () => '翻译',
      guide: [{ id: 'translation-workspace', order: 40, title: () => '翻译', description: () => '打开翻译会话。' }],
    })), 'translation tab type')

    ctx.effect(() => withClientDiagnostics('sidebar.right.pane.tab register', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: CLIENT_ID }, TranslationPanel,
    )), 'translation tab body')

    ctx.effect(() => withClientDiagnostics('settings.section register', () => ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: CLIENT_ID, order: 40, label: '翻译' }, TranslationSettings,
    ))), 'translation settings page')
  })
}
