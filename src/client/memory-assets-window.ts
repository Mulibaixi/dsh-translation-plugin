export const MEMORY_ASSETS_TAB_ID = 'dsh-translation-plugin/memory-assets'
export const MEMORY_ASSETS_TAB_KIND = 'translation-memory-assets'
export const MEMORY_ASSETS_PATTERN = 'dsh-resource://translation-assets/**'

export interface MemoryAssetsScope {
  readonly ownerId: string
  readonly topicId: string
}

export interface MemoryAssetsTab {
  readonly id: string
  readonly contentId: string
  readonly visible: boolean
  readonly signal: AbortSignal
  readonly navigation: { readonly address: string }
  readonly actions: {
    openResource(address: string): void
    close(): void
  }
}

export interface MemoryAssetsTabInfo { readonly tab: MemoryAssetsTab }

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

/** The address, rather than navigation params, retains the asset's scope on reload. */
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

/** Open through the tab's own Session; float only a new foreground occurrence. */
export function openMemoryAssets(
  sidebar: MemoryAssetsSidebar,
  origin: { readonly ownerId: string; readonly tab: MemoryAssetsTab },
  scope: MemoryAssetsScope,
  viewport: { readonly width: number; readonly height: number } = { width: 1024, height: 768 },
): boolean {
  if (origin.ownerId !== scope.ownerId || origin.tab.signal.aborted) return false
  const address = memoryAssetsAddress(scope.ownerId, scope.topicId)
  const find = () => sidebar.openTabs.getSnapshot().find(tab => tab.sessionId === scope.ownerId
    && tab.kind === MEMORY_ASSETS_TAB_KIND && tab.contentId === address)
  const existing = find()
  origin.tab.actions.openResource(address)
  // The public open returns void. Adopted membership commits synchronously publish openTabs.
  const opened = find()
  if (!opened) return false
  if (!existing && origin.tab.visible && !origin.tab.signal.aborted && sidebar.mounted.getSnapshot() === scope.ownerId) {
    const width = Math.max(1, Math.min(960, viewport.width - 32))
    const height = Math.max(1, Math.min(720, viewport.height - 32))
    sidebar.float(opened.tabId, { x: Math.max(0, (viewport.width - width) / 2), y: Math.max(0, (viewport.height - height) / 2), width, height })
  }
  return true
}
