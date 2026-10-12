import type { EvidenceUnavailableResult } from '../shared/translation-evidence.js'
import type { DocumentReadSnapshot } from './source-reader.js'
import { projectDocument, readDocumentText, type DocumentProjection } from './document-export.js'

export interface DocumentTextFile {
  readonly status: 'ready'
  readonly text: string
  readonly fileName: string
  readonly mimeType: 'text/plain;charset=utf-8'
}
function name(snapshot: DocumentReadSnapshot): string {
  const raw = snapshot.source.body.kind === 'asset' ? snapshot.source.body.reference.name : '长原稿.txt'
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '') || 'document.txt'
}
/** Saved assets use the Host's opaque original opener; runtime/inline sources produce a bounded-read TXT projection. */
export async function openDocumentOriginal(snapshot: DocumentReadSnapshot, signal: AbortSignal = new AbortController().signal): Promise<DocumentTextFile | { readonly status: 'opened' } | EvidenceUnavailableResult> {
  if (snapshot.source.body.kind === 'asset' && snapshot.source.historyCommit) return snapshot.openOriginal(signal)
  const loaded = await readDocumentText(range => snapshot.readSource(range), { start: 0, end: snapshot.totalSourceCodePoints })
  if (!('text' in loaded)) return loaded
  const after = snapshot.check()
  return after ?? { status: 'ready', text: loaded.text, fileName: name(snapshot), mimeType: 'text/plain;charset=utf-8' }
}
export async function projectDocumentResult(snapshot: DocumentReadSnapshot, allowPartial = false): Promise<DocumentProjection & { readonly fileName: string; readonly mimeType: 'text/plain;charset=utf-8' }> {
  const projection = await projectDocument(snapshot)
  return { ...projection, text: projection.complete || allowPartial ? projection.text : null,
    fileName: `${name(snapshot).replace(/\.txt$/iu, '')}-translation${projection.complete ? '' : '-partial'}.txt`, mimeType: 'text/plain;charset=utf-8' }
}
