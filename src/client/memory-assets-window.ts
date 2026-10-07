import type { SessionStore } from './session-store.js'

export const MEMORY_ASSETS_TAB_ID = 'dsh-translation-plugin/memory-assets'
export const MEMORY_ASSETS_TAB_KIND = 'translation-memory-assets'
export const MEMORY_ASSETS_PATTERN = 'dsh-resource://translation-assets/**'

export interface MemoryAssetsScope {
  readonly ownerId: string
  readonly topicId: string
  readonly sessionId?: string | undefined
}

export interface MemoryAssetsTab {
  readonly id: string
  readonly contentId: string
  readonly visible: boolean
  readonly signal: AbortSignal
  readonly navigation: { readonly address: string; readonly params?: unknown; readonly revision?: number }
  readonly actions: {
    openResource(address: string, options?: { readonly params: { readonly topicId: string; readonly sessionId?: string | undefined } }): void
    close(): void
  }
}

export interface MemoryAssetsTabInfo { readonly tab: MemoryAssetsTab }

export interface MemoryAssetsNavigation extends MemoryAssetsScope {
  readonly associatedSessionId?: string | undefined
  readonly requestedTopicId?: string | undefined
  readonly navigationRevision?: number | undefined
}

export interface MemoryAssetsSidebar {
  readonly openTabs: {
    getSnapshot(): readonly {
      readonly sessionId: string
      readonly tabId: string
      readonly kind: string
      readonly contentId: string
    }[]
  }
  readonly mounted: { getSnapshot(): string | undefined }
  float(tabId: string, rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** The address retains the owner and initial topic on reload; navigation selects a topic. */
export function memoryAssetsAddress(ownerId: string, topicId: string): string {
  if (!validIdentity(ownerId) || !validIdentity(topicId)) throw new Error('Invalid memory assets scope')
  return `dsh-resource://translation-assets/${encodeURIComponent(ownerId)}/${encodeURIComponent(topicId)}/terms`
}

export function parseMemoryAssetsAddress(address: string, ownerId?: string): MemoryAssetsScope | undefined {
  const match = /^dsh-resource:\/\/translation-assets\/([^/?#]+)\/([^/?#]+)\/terms$/u.exec(address)
  if (!match) return undefined
  try {
    const scope = { ownerId: decodeURIComponent(match[1]!), topicId: decodeURIComponent(match[2]!) }
    if (!validIdentity(scope.ownerId) || !validIdentity(scope.topicId)) return undefined
    if (ownerId !== undefined && scope.ownerId !== ownerId) return undefined
    return memoryAssetsAddress(scope.ownerId, scope.topicId) === address ? scope : undefined
  } catch { return undefined }
}

/** Title and Body read the same Session-bound occurrence, including repeated navigation. */
export function readMemoryAssetsNavigation(ownerId: string | undefined, tab: MemoryAssetsTab | undefined): MemoryAssetsNavigation | undefined {
  const scope = ownerId && tab ? parseMemoryAssetsAddress(tab.navigation.address, ownerId) : undefined
  if (!scope || !tab) return undefined
  const params = tab.navigation.params
  return { ...scope, navigationRevision: tab.navigation.revision,
    requestedTopicId: params && typeof params === 'object' && 'topicId' in params && typeof params.topicId === 'string' ? params.topicId : undefined,
    associatedSessionId: params && typeof params === 'object' && 'sessionId' in params && typeof params.sessionId === 'string' ? params.sessionId : undefined }
}

export function resolveMemoryAssetsSelection(store: SessionStore, scope: MemoryAssetsNavigation) {
  const availableTopics = store.getTopics(scope.ownerId)
  const topicId = availableTopics.some(topic => topic.id === scope.requestedTopicId) ? scope.requestedTopicId! : scope.topicId
  const topic = availableTopics.find(topic => topic.id === topicId)
  const requested = scope.associatedSessionId ? store.getSession(scope.associatedSessionId) : undefined
  const current = store.getActiveSession(scope.ownerId)
  const session = requested?.ownerId === scope.ownerId && requested.topicId === topicId ? requested
    : current?.topicId === topicId ? current : store.getAvailableSessions(scope.ownerId).find(session => session.topicId === topicId)
  return { availableTopics, topicId, topic, session }
}

/** Open through the tab's own Session; float only a new foreground occurrence. */
export function openMemoryAssets(
  sidebar: MemoryAssetsSidebar,
  origin: { readonly ownerId: string; readonly tab: MemoryAssetsTab },
  scope: MemoryAssetsScope,
  viewport: { readonly width: number; readonly height: number } = { width: 1024, height: 768 },
): boolean {
  if (origin.ownerId !== scope.ownerId || origin.tab.signal.aborted) return false
  const existing = sidebar.openTabs.getSnapshot().find(tab => tab.sessionId === scope.ownerId
    && tab.kind === MEMORY_ASSETS_TAB_KIND && parseMemoryAssetsAddress(tab.contentId, scope.ownerId))
  const address = existing?.contentId ?? memoryAssetsAddress(scope.ownerId, scope.topicId)
  origin.tab.actions.openResource(address, { params: { topicId: scope.topicId, sessionId: scope.sessionId } })
  // The public open returns void. Adopted membership commits synchronously publish openTabs.
  const opened = sidebar.openTabs.getSnapshot().find(tab => tab.sessionId === scope.ownerId
    && tab.kind === MEMORY_ASSETS_TAB_KIND && tab.contentId === address)
  if (!opened) return false
  if (!existing && origin.tab.visible && !origin.tab.signal.aborted && sidebar.mounted.getSnapshot() === scope.ownerId) {
    const width = Math.max(1, Math.min(960, viewport.width - 32))
    const height = Math.max(1, Math.min(720, viewport.height - 32))
    sidebar.float(opened.tabId, { x: Math.max(0, (viewport.width - width) / 2), y: Math.max(0, (viewport.height - height) / 2), width, height })
  }
  return true
}
