/** Starts a browser download; it cannot confirm that the user saved a file. */
export function downloadExport(result: { readonly content: string | null; readonly fileName: string; readonly mimeType: string }): void {
  if (result.content === null) throw new Error('No export content')
  const anchor = document.createElement('a')
  const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }))
  try {
    anchor.href = url; anchor.download = result.fileName; anchor.hidden = true
    document.body.appendChild(anchor); anchor.click()
  } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0) }
}

/** Invoke directly from a user action, before any asynchronous content loading. */
export async function saveExport(result: { readonly content: string; readonly fileName: string; readonly mimeType: string }): Promise<'saved' | 'cancelled' | 'downloaded'> {
  const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle> }).showSaveFilePicker
  if (!picker) { downloadExport(result); return 'downloaded' }
  let handle: FileSystemFileHandle
  try { handle = await picker.call(window, { suggestedName: result.fileName }) }
  catch (error) { if ((error as { readonly name?: string } | null)?.name === 'AbortError') return 'cancelled'; throw error }
  const stream = await handle.createWritable()
  try { await stream.write(new Blob([result.content], { type: result.mimeType })); await stream.close() }
  catch (error) { await stream.abort().catch(() => {}); throw error }
  return 'saved'
}
