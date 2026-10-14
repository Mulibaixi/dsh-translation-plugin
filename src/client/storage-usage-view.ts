import { h, react } from './react.js'
import type { SessionStore } from './session-store.js'
import { STORAGE_USAGE_CATEGORIES, formatStorageBytes } from './storage-usage.js'

/** A manual, read-only snapshot avoids scanning large histories on every editor update. */
export function StorageUsageView({ store }: { readonly store: Pick<SessionStore, 'getStorageUsage'> }): unknown {
  const [usage, setUsage] = react.useState(() => store.getStorageUsage())
  return h('section', { className: 'dsh-tp-settings-section', 'aria-label': '存储与空间' },
    h('div', { className: 'dsh-tp-settings-header' }, h('h3', null, '存储与空间'),
      h('button', { type: 'button', onClick: () => setUsage(store.getStorageUsage()) }, '刷新统计')),
    h('p', { className: 'dsh-tp-muted' }, '范围：当前设备、当前 Web 来源中本插件的浏览器持久数据。统计只包含已写入的数据，当前窗口未保存的内容未计入。'),
    usage.status === 'unknown'
      ? h('p', { className: 'dsh-tp-message', role: 'alert' }, usage.message)
      : h('div', { style: { overflowX: 'auto' } }, h('table', { 'aria-label': '浏览器存储分类占用', style: { width: '100%', textAlign: 'left' } },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, '分类'), h('th', { scope: 'col' }, '记录数'),
          h('th', { scope: 'col' }, '估算占用'))),
        h('tbody', null, ...STORAGE_USAGE_CATEGORIES.map(item => {
          const size = usage.categories[item.id]
          return h('tr', { key: item.id }, h('th', { scope: 'row' }, item.label), h('td', null, size.records),
            h('td', null, formatStorageBytes(size.utf16EstimateBytes)))
        })),
        h('tfoot', null, h('tr', null, h('th', { scope: 'row' }, '合计'), h('td', null, usage.total.records),
          h('td', null, formatStorageBytes(usage.total.utf16EstimateBytes)))))),
    h('p', { className: 'dsh-tp-muted' }, '按浏览器键名和内容估算，不代表精确磁盘占用或可用容量。'),
    h('p', { className: 'dsh-tp-muted' }, 'Host 受管原稿另存于宿主文件，未计入本次浏览器统计；DSH 附件和其他插件数据也未计入。'),
  )
}
