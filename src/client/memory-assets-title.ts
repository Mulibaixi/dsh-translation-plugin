import { h } from './react.js'

// Match only our title inside the host's floating caption; buttons and resize retain host cursors.
export const MEMORY_ASSETS_TITLE_CURSOR_CSS = `
[data-dockkit-float] [data-dockkit-float-grip]:has([data-dockkit-float-title] [data-dsh-translation-assets-title]) { cursor: default; }
`

export function MemoryAssetsTitle(): unknown {
  return h('span', { 'data-dsh-translation-assets-title': true },
    h('style', null, MEMORY_ASSETS_TITLE_CURSOR_CSS), '记忆资产')
}
