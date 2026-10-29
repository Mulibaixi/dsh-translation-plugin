import type { LocalStoragePort } from './session-store.js'

export const PLUGIN_STORAGE_PREFIX = 'dsh-translation-plugin:'
export const STORAGE_USAGE_CATEGORIES = [
  { id: 'terms', label: '术语' },
  { id: 'settings', label: '设置' },
  { id: 'preparation', label: '准备记录' },
  { id: 'objects', label: '对象关联' },
  { id: 'history', label: '历史与草稿' },
  { id: 'archive', label: '结构化档案' },
  { id: 'references', label: '参考资料索引' },
  { id: 'preferences', label: '模型及排序偏好' },
  { id: 'meta', label: '主题及其他元数据' },
] as const

export type StorageUsageCategory = typeof STORAGE_USAGE_CATEGORIES[number]['id']
export interface StorageUsageSize {
  readonly records: number
  /** Two bytes per UTF-16 code unit, including keys; this is not a storage quota measurement. */
  readonly utf16EstimateBytes: number
  /** UTF-8 size of persisted JSON/text values only, including unreadable JSON. */
  readonly serializedUtf8Bytes: number
}
export type PluginStorageUsage =
  | { readonly status: 'available'; readonly total: StorageUsageSize; readonly categories: Readonly<Record<StorageUsageCategory, StorageUsageSize>> }
  | { readonly status: 'unknown'; readonly total: null; readonly categories: null; readonly message: string }

type ReadStoragePort = Pick<LocalStoragePort, 'length' | 'key' | 'getItem'>
type MutableSize = { -readonly [Field in keyof StorageUsageSize]: StorageUsageSize[Field] }
const emptySize = (): MutableSize => ({ records: 0, utf16EstimateBytes: 0, serializedUtf8Bytes: 0 })
const unknownUsage = (): PluginStorageUsage => ({ status: 'unknown', total: null, categories: null,
  message: '浏览器存储不可读取或在统计期间发生变化，当前占用未知。请重试统计。' })

function category(key: string): StorageUsageCategory {
  const name = key.slice(PLUGIN_STORAGE_PREFIX.length)
  if (name.startsWith('history:') || name.startsWith('draft:') || name.startsWith('file-intake:') || name.startsWith('file-jobs:')) return 'history'
  if (name.startsWith('topic-terms:')) return 'terms'
  if (name.startsWith('topic-archive:')) return 'archive'
  if (name.startsWith('preparation:')) return 'preparation'
  if (name.startsWith('references:') || name.startsWith('reference-binding:')) return 'references'
  if (name.startsWith('record-objects:')) return 'objects'
  if (name.startsWith('session-model:') || name.startsWith('owner-model:') || name.startsWith('session-order:')) return 'preferences'
  if (name.startsWith('settings:')) return 'settings'
  return 'meta'
}

/** Count without decoding or allocating another copy of the stored text. */
function utf8Bytes(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++ }
    else bytes += 3 // Lone surrogates are replaced by U+FFFD by UTF-8 encoders.
  }
  return bytes
}

/** Read only this plugin's values; no body, record ID, or key escapes the aggregate. */
export function readPluginStorageUsage(storage?: ReadStoragePort): PluginStorageUsage {
  if (!storage) return unknownUsage()
  try {
    const length = storage.length
    if (!Number.isSafeInteger(length) || length < 0) return unknownUsage()
    const categories = Object.fromEntries(STORAGE_USAGE_CATEGORIES.map(item => [item.id, emptySize()])) as Record<StorageUsageCategory, MutableSize>
    const total = emptySize(), seen = new Set<string>()
    for (let index = 0; index < length; index++) {
      const key = storage.key(index)
      if (key === null || seen.has(key)) return unknownUsage()
      seen.add(key)
      if (!key.startsWith(PLUGIN_STORAGE_PREFIX)) continue
      const value = storage.getItem(key)
      if (value === null) return unknownUsage()
      const size = categories[category(key)], utf16 = 2 * (key.length + value.length), utf8 = utf8Bytes(value)
      size.records++; size.utf16EstimateBytes += utf16; size.serializedUtf8Bytes += utf8
      total.records++; total.utf16EstimateBytes += utf16; total.serializedUtf8Bytes += utf8
    }
    if (storage.length !== length) return unknownUsage()
    return { status: 'available', total, categories }
  } catch { return unknownUsage() }
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}
