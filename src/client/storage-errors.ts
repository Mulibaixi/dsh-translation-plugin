/** Storage errors can cross realms, so their DOMException name is the authority. */
export function isStorageQuotaError(error: unknown): boolean {
  try {
    return error !== null && (typeof error === 'object' || typeof error === 'function') &&
      (error as { readonly name?: unknown }).name === 'QuotaExceededError'
  } catch { return false }
}

/** Keep failures visible in the existing status line; never reclaim user data automatically. */
export function storageSaveFailureMessage(error: unknown, subject: string, fallback: string): string {
  return isStorageQuotaError(error)
    ? `浏览器本地存储容量不足，${subject}当前未保存；当前内容仍保留在本次运行，未完成写入的旧副本保留。请导出需要的内容并清理不需要的记录，再重试保存。`
    : fallback
}
