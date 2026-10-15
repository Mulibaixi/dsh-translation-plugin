import type { LocalStoragePort } from './session-store.js'

/** Kept without user content so an old window cannot restore a cleared namespace. */
export const LOCAL_DATA_GENERATION = 'dsh-translation-plugin:local-data-generation:v1'
const rawStores = new WeakMap<object, Storage>()
export function browserPluginStorage(): LocalStoragePort | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    const raw = window.localStorage
    const generation = raw.getItem(LOCAL_DATA_GENERATION)
    const check = (): void => {
      if (generation?.startsWith('pending:') || raw.getItem(LOCAL_DATA_GENERATION) !== generation) throw new Error('本地数据已进入清理流程，请确认结果后重新启用翻译插件。')
    }
    const storage: LocalStoragePort = {
      get length() { return raw.length }, key: index => raw.key(index), getItem: key => raw.getItem(key),
      setItem(key, value) { check(); raw.setItem(key, value) }, removeItem(key) { check(); raw.removeItem(key) },
    }
    rawStores.set(storage, raw); return storage
  } catch { return undefined }
}
export function isPluginStorageEvent(event: StorageEvent, storage: LocalStoragePort | undefined): boolean {
  return event.storageArea === (storage && (rawStores.get(storage) ?? storage))
}
