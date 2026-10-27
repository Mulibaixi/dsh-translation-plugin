import { h, react } from './react.js'
import type { SessionStore } from './session-store.js'
import type { LocalDataClient } from './local-data.js'
import type { HostStorageUsage } from '../shared/local-data.js'
import { STORAGE_USAGE_CATEGORIES, formatStorageBytes } from './storage-usage.js'

/** A manual, read-only snapshot avoids scanning large histories on every editor update. */
export function StorageUsageView({ store, localData }: { readonly store: Pick<SessionStore, 'getStorageUsage' | 'getUnreadableHistory' | 'deleteHistoryAsync' | 'getOrphanPreparations' | 'getOrphanLegacyLocators' | 'deleteOrphanRecords'>; readonly localData?: LocalDataClient | undefined }): unknown {
  const [usage, setUsage] = react.useState(() => store.getStorageUsage())
  const [unreadable, setUnreadable] = react.useState(() => store.getUnreadableHistory())
  const [host, setHost] = react.useState<HostStorageUsage | undefined>(undefined)
  const [loading, setLoading] = react.useState(false)
  const [reclaiming, setReclaiming] = react.useState(false)
  const [reclaimConfirm, setReclaimConfirm] = react.useState(false)
  const [reclaimMessage, setReclaimMessage] = react.useState<string | undefined>(undefined)
  const [purging, setPurging] = react.useState(false)
  const [purgeConfirm, setPurgeConfirm] = react.useState(false)
  const [purgeMessage, setPurgeMessage] = react.useState<string | undefined>(undefined)
  const [orphans, setOrphans] = react.useState(() => ({ preparations: store.getOrphanPreparations(), locators: store.getOrphanLegacyLocators() }))
  const [orphanBusy, setOrphanBusy] = react.useState(false)
  const [orphanConfirm, setOrphanConfirm] = react.useState(false)
  const [orphanMessage, setOrphanMessage] = react.useState<string | undefined>(undefined)
  const refresh = (): void => {
    setUsage(store.getStorageUsage()); setUnreadable(store.getUnreadableHistory()); setOrphans({ preparations: store.getOrphanPreparations(), locators: store.getOrphanLegacyLocators() }); setLoading(true)
    void (localData?.usage() ?? Promise.resolve(undefined)).then(setHost).finally(() => setLoading(false))
  }
  const purge = async (): Promise<void> => {
    if (purging || !unreadable.length) return
    const count = unreadable.length
    setPurging(true); setPurgeMessage(undefined)
    try {
      const done = await store.deleteHistoryAsync([], false, unreadable)
      if (done) { setPurgeMessage(`已删除 ${count} 条无法读取的历史副本。`); setUsage(store.getStorageUsage()); setUnreadable(store.getUnreadableHistory()) }
      else setPurgeMessage('未能删除：副本已变化，请刷新统计后重试。')
    } catch { setPurgeMessage('删除未完成，请刷新统计后重试。') }
    finally { setPurging(false); setPurgeConfirm(false) }
  }
  const clearOrphans = async (): Promise<void> => {
    const records = [...orphans.preparations, ...orphans.locators]
    if (orphanBusy || !records.length) return
    const count = records.length
    setOrphanBusy(true); setOrphanMessage(undefined)
    try {
      const done = store.deleteOrphanRecords(records)
      if (done) {
        setOrphanMessage(`已清理 ${count} 条孤立记录。`)
        setUsage(store.getStorageUsage()); setOrphans({ preparations: store.getOrphanPreparations(), locators: store.getOrphanLegacyLocators() })
      } else setOrphanMessage('未能清理：记录已变化，请刷新统计后重试。')
    } finally { setOrphanBusy(false); setOrphanConfirm(false) }
  }
  const reclaim = async (): Promise<void> => {
    if (!localData || reclaiming) return
    setReclaiming(true); setReclaimMessage(undefined)
    try {
      const result = await localData.reclaim()
      const cleanup = result.resourceCleanup, summary = cleanup ? `本次清理 ${cleanup.removed} 个已删内容的残留文件${cleanup.retained ? `，共享保留 ${cleanup.retained} 个文件` : ''}。` : ''
      setReclaimMessage(summary + (result.ok ? `${summary ? '另' : '已'}回收 ${result.removed ?? 0} 份未引用原稿，释放约 ${formatStorageBytes(result.bytes ?? 0)}。` : result.message ?? '原稿回收未完成，请重试。'))
      if (result.ok) refresh()
    } finally { setReclaiming(false) }
  }
  return h('section', { className: 'dsh-tp-settings-section', 'aria-label': '存储与空间' },
    h('div', { className: 'dsh-tp-settings-header' }, h('h3', null, '存储与空间'),
      h('button', { type: 'button', disabled: loading, onClick: refresh }, '刷新统计')),
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
    unreadable.length === 0 ? null : h('div', { className: 'dsh-tp-message', role: 'alert' },
      h('p', null, `无法读取的历史副本 ${unreadable.length} 条：它们不会出现在会话列表，原始内容仍保留在本地存储。删除后不可恢复，并会阻止同一会话的旧副本再次导入。`),
      h('div', { className: 'dsh-tp-actions' },
        h('button', { type: 'button', disabled: purging, onClick: () => setPurgeConfirm(true) }, purging ? '正在删除…' : '删除这些副本'),
        purgeConfirm ? h('div', { role: 'alertdialog', 'aria-label': '删除无法读取的历史副本确认' },
          h('p', null, `删除 ${unreadable.length} 条无法读取的历史副本？其正文无法恢复。`),
          h('button', { type: 'button', disabled: purging, onClick: () => { void purge() } }, '确认删除'),
          h('button', { type: 'button', disabled: purging, onClick: () => setPurgeConfirm(false) }, '取消')) : null)),
    purgeMessage ? h('p', { role: 'status', className: 'dsh-tp-message' }, purgeMessage) : null,
    orphans.preparations.length + orphans.locators.length === 0 ? null : h('div', { className: 'dsh-tp-message', role: 'alert' },
      h('p', null, `孤立记录 ${orphans.preparations.length + orphans.locators.length} 条（约 ${formatStorageBytes([...orphans.preparations, ...orphans.locators].reduce((sum, item) => sum + item.raw.length * 2, 0))}）：`
        + `准备审计 ${orphans.preparations.length} 条、已删主题的迁移定位 ${orphans.locators.length} 条。它们不再属于任何仍存在的翻译会话，删除后不可恢复；删除墓碑与打开集合不受影响。`),
      h('div', { className: 'dsh-tp-actions' },
        h('button', { type: 'button', disabled: orphanBusy, onClick: () => setOrphanConfirm(true) }, orphanBusy ? '正在清理…' : '清理孤立记录'),
        orphanConfirm ? h('div', { role: 'alertdialog', 'aria-label': '清理孤立记录确认' },
          h('p', null, `清理 ${orphans.preparations.length + orphans.locators.length} 条孤立记录？`),
          h('button', { type: 'button', disabled: orphanBusy, onClick: () => { void clearOrphans() } }, '确认清理'),
          h('button', { type: 'button', disabled: orphanBusy, onClick: () => setOrphanConfirm(false) }, '取消')) : null)),
    orphanMessage ? h('p', { role: 'status', className: 'dsh-tp-message' }, orphanMessage) : null,
    h('p', { className: 'dsh-tp-muted' }, '按浏览器键名和内容估算，不代表精确磁盘占用或可用容量。'),
    h('p', { className: 'dsh-tp-muted' }, host ? `Host 插件自有文件：${host.files} 个，${formatStorageBytes(host.bytes)}（含原稿、参考片段、对象映射及账本，按实际保存文件计）。`
      : 'Host 插件自有文件占用未知；点击刷新统计读取。'),
    host?.pendingCleanups ? h('p', { role: 'status', className: 'dsh-tp-message' }, `尚有 ${host.pendingCleanups} 项文件清理未完成，请完成原删除操作或重试回收；已删正文不会恢复。`) : null,
    h('p', { className: 'dsh-tp-muted' }, 'Host 范围为当前 DSH 数据目录。共享原稿按保存文件计一次；运行期内容、用户原文件、DSH 附件和其他插件数据未计入。'),
    h('div', { className: 'dsh-tp-actions' },
      localData ? h('button', { type: 'button', disabled: reclaiming, onClick: () => setReclaimConfirm(true) }, reclaiming ? '正在回收…' : '回收未引用原稿') : null,
      reclaimConfirm ? h('div', { role: 'alertdialog', 'aria-label': '回收未引用原稿确认' },
        h('p', null, '删除已无有效引用的原稿副本，并重试旧版本、单元、会话或主题删除后的残留文件清理？此操作无法撤销，仍被使用的副本不会删除。'),
        h('button', { type: 'button', disabled: reclaiming, onClick: () => { setReclaimConfirm(false); void reclaim() } }, '确认回收'),
        h('button', { type: 'button', disabled: reclaiming, onClick: () => setReclaimConfirm(false) }, '取消')) : null),
    reclaimMessage ? h('p', { role: 'status', className: 'dsh-tp-message' }, reclaimMessage) : null,
  )
}
