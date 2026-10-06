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
