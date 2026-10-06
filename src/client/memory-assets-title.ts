import { h, react } from './react.js'
import { parseMemoryAssetsAddress } from './memory-assets-window.js'
import type { SessionStore } from './session-store.js'

// Match only our title inside the host's floating caption; buttons and resize retain host cursors.
export const MEMORY_ASSETS_TITLE_CURSOR_CSS = `
[data-dockkit-float] [data-dockkit-float-grip]:has([data-dockkit-float-title] [data-dsh-translation-assets-title]) { cursor: default; }
`

export function MemoryAssetsTitle({ store, address, ownerId }: {
  readonly store: Pick<SessionStore, 'getTopics' | 'subscribe'>
  readonly address?: string | undefined
  readonly ownerId?: string | undefined
}): unknown {
  const [, refresh] = react.useState(0)
  react.useEffect(() => store.subscribe(() => refresh(value => value + 1)), [store])
  const scope = address !== undefined && ownerId !== undefined ? parseMemoryAssetsAddress(address, ownerId) : undefined
  const topic = scope ? store.getTopics(scope.ownerId).find(topic => topic.id === scope.topicId) : undefined
  return h('span', { 'data-dsh-translation-assets-title': true },
    h('style', null, MEMORY_ASSETS_TITLE_CURSOR_CSS), topic ? `${topic.name} · 记忆资产` : '记忆资产')
}
