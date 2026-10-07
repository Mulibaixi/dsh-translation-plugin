import { h } from './react.js'
import { PanelRouter, SettingsView, MemoryAssetsView } from './views.js'
import { createSessionStore } from './session-store.js'
import { ModelCatalog, type ModelCatalogPort } from './models.js'
import { QuickTranslationClient } from './quick-translation.js'
import { adaptQuickRemote, type QuickRemotePort } from './quick-transport.js'
import { PLUGIN_REMOTE } from '../shared/plugin-remote.js'
import { TopicBridgeClient, type TopicBridgeRemotePort } from './topic-bridge.js'
import { TopicMemoryStore } from './topic-memory-store.js'
import { TopicArchiveStore } from './topic-archive-store.js'
import { MemoryAssetsTitle } from './memory-assets-title.js'
import {
  MEMORY_ASSETS_TAB_ID, MEMORY_ASSETS_TAB_KIND, MEMORY_ASSETS_PATTERN,
  openMemoryAssets, parseMemoryAssetsAddress, readMemoryAssetsNavigation, type MemoryAssetsSidebar, type MemoryAssetsTabInfo,
} from './memory-assets-window.js'

type Disposer = () => void
type AsyncDisposer = () => void | Promise<void>
type ClientComponent = (props?: Readonly<Record<string, unknown>>) => unknown

interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly title: (address: string) => string
  readonly patterns?: readonly string[]
  readonly canOpen?: (address: string) => boolean
  readonly keepMounted?: boolean
  readonly guide?: readonly {
    readonly id: string
    readonly order: number
    readonly title: () => string
    readonly description: () => string
  }[]
}

interface ClientPluginContext {
  get(name: 'remote.translationQuick'): QuickRemotePort | undefined
  get(name: 'remote.translationTopics'): TopicBridgeRemotePort | undefined
  readonly remote: {
    readonly session: ModelCatalogPort
    readonly translationQuick?: QuickRemotePort
    readonly translationTopics?: TopicBridgeRemotePort
    $mount?(contribution: typeof PLUGIN_REMOTE): Promise<AsyncDisposer>
    $on(event: string, listener: () => void): Disposer
  }
  on(event: string, listener: () => void): Disposer
  readonly sidebarRightTabs: { register(definition: SidebarRightTabDefinition): Disposer }
  readonly sidebarRight: MemoryAssetsSidebar
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
export const inject = ['sidebarRightTabs', 'sidebarRight', 'slots', 'remote', 'remote.session'] as const

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
    let remoteDisposed = false
    // One DSH contribution owns both namespaces; mounting the package twice replaces its face.
    const mountedRemote = (async () => ctx.remote.$mount?.(PLUGIN_REMOTE))().catch(error => {
      const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
      console.error(`[${CLIENT_ID}] Client translation remote mount failed: ${detail}`)
      return undefined
    })
    const quick = new QuickTranslationClient(adaptQuickRemote(ctx.remote.$mount ? async () => {
      const unmountRemote = await mountedRemote
      return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationQuick')
    } : ctx.remote.translationQuick), store, models)
    const terms = new TopicMemoryStore(store)
    const archive = new TopicArchiveStore(store, (sessionId, unitId) => terms.readEvidence(sessionId, unitId))
    const topics = new TopicBridgeClient(ctx.remote.$mount ? async () => {
      const unmountRemote = await mountedRemote
      return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationTopics')
    } : ctx.remote.translationTopics, store, terms, archive)
    ctx.effect(() => () => store.dispose(), 'translation client store')
    ctx.effect(() => () => models.dispose(), 'translation model catalog')
    ctx.effect(() => () => terms.dispose(), 'translation topic terms')
    ctx.effect(() => () => archive.dispose(), 'translation topic archive')
    ctx.effect(() => async () => {
      remoteDisposed = true
      quick.dispose()
      await topics.dispose()
      const unmountRemote = await mountedRemote
      await unmountRemote?.()
    }, 'translation remote clients')
    ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => models.invalidate()), 'translation catalog invalidation')
    ctx.effect(() => ctx.remote.$on('settings/document-updated', () => models.invalidate()), 'translation catalog settings')
    ctx.effect(() => ctx.on('connection/reset', () => { models.invalidate(true); quick.reset(); void topics.reset() }), 'translation catalog connection')

    const onDeleteTerm = (snapshot: { ownerId: string; topicId: string; version: number }, entry: { id: string; version: number }) => terms.deleteEntryAsync(snapshot.ownerId, snapshot.topicId, entry.id, snapshot.version, entry.version)
    const TranslationPanel: ClientComponent = (props = {}) => {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const tabInfo = typeof props.useTabInfo === 'function' ? (props.useTabInfo as () => MemoryAssetsTabInfo)() : undefined
      return h(PanelRouter, {
        store, models, quick, topics, terms, onDeleteTerm, sessionId,
        onOpenAssets: sessionId && tabInfo ? (ownerId: string, topicId: string, associatedSessionId?: string) => {
          if (!store.getTopics(ownerId).some(topic => topic.id === topicId)) return
          openMemoryAssets(ctx.sidebarRight, { ownerId: sessionId, tab: tabInfo.tab }, { ownerId, topicId, sessionId: associatedSessionId },
            typeof window === 'undefined' ? undefined : { width: window.innerWidth, height: window.innerHeight })
        } : undefined,
      })
    }
    const MemoryAssetsPanel: ClientComponent = (props = {}) => {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const tabInfo = typeof props.useTabInfo === 'function' ? (props.useTabInfo as () => MemoryAssetsTabInfo)() : undefined
      const scope = readMemoryAssetsNavigation(sessionId, tabInfo?.tab)
      const onClose = tabInfo ? () => tabInfo.tab.actions.close() : undefined
      if (!scope) return h('section', { className: 'dsh-translation' },
        h('h2', null, '记忆资产不可用'), h('p', null, '资源地址无效或不属于此主会话。'),
        onClose ? h('button', { type: 'button', onClick: onClose }, '关闭') : null)
      return h(MemoryAssetsView, { store, quick, topics, terms, archive, onDeleteTerm, ...scope,
        onSelectTopic: tabInfo ? (topicId: string) => {
          if (tabInfo.tab.signal.aborted || !store.getTopics(scope.ownerId).some(topic => topic.id === topicId)) return
          tabInfo.tab.actions.openResource(tabInfo.tab.navigation.address, { params: { topicId } })
        } : undefined })
    }
    const MemoryAssetsCaption: ClientComponent = (props = {}) => {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const tabInfo = typeof props.useTabInfo === 'function' ? (props.useTabInfo as () => MemoryAssetsTabInfo)() : undefined
      const scope = readMemoryAssetsNavigation(sessionId, tabInfo?.tab)
      return h(MemoryAssetsTitle, { store, scope,
        onSelectTopic: scope && tabInfo ? (topicId: string) => {
          if (tabInfo.tab.signal.aborted || !store.getTopics(scope.ownerId).some(topic => topic.id === topicId)) return
          tabInfo.tab.actions.openResource(tabInfo.tab.navigation.address, { params: { topicId } })
        } : undefined })
    }
    const TranslationSettings: ClientComponent = (props = {}) => h(SettingsView, {
      store, terms, onClose: typeof props.close === 'function' ? props.close : undefined,
    })

    ctx.effect(() => withClientDiagnostics('sidebarRightTabs.register', () => ctx.sidebarRightTabs.register({
      id: CLIENT_ID,
      kind: 'translation-workspace',
      title: () => '翻译',
      keepMounted: true,
      guide: [{ id: 'translation-workspace', order: 40, title: () => '翻译', description: () => '打开翻译会话。' }],
    })), 'translation tab type')

    ctx.effect(() => withClientDiagnostics('sidebar.right.pane.tab register', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: CLIENT_ID }, TranslationPanel,
    )), 'translation tab body')

    ctx.effect(() => withClientDiagnostics('memory asset type register', () => ctx.sidebarRightTabs.register({
      id: MEMORY_ASSETS_TAB_ID,
      kind: MEMORY_ASSETS_TAB_KIND,
      title: () => '记忆资产',
      patterns: [MEMORY_ASSETS_PATTERN],
      canOpen: address => parseMemoryAssetsAddress(address) !== undefined,
      keepMounted: true,
    })), 'translation memory asset tab type')
    ctx.effect(() => withClientDiagnostics('memory asset body register', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: MEMORY_ASSETS_TAB_ID }, MemoryAssetsPanel,
    )), 'translation memory asset tab body')
    ctx.effect(() => withClientDiagnostics('memory asset title register', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: MEMORY_ASSETS_TAB_ID }, MemoryAssetsCaption,
    )), 'translation memory asset tab title')

    ctx.effect(() => withClientDiagnostics('settings.section register', () => ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: CLIENT_ID, order: 40, label: '翻译' }, TranslationSettings,
    ))), 'translation settings page')
  })
}
