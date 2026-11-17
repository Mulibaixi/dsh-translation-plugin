import type { TextRevision, TextUnit } from './translation-history.js'
import { pdfUnitPages, pdfTranslationMarkdown } from '../shared/pdf-source.js'

/** Export exactly the selected recorded version, independently of the final selection. */
export function buildRevisionExport(unit: TextUnit, revision: TextRevision, originalName?: string): { readonly content: string; readonly fileName: string; readonly mimeType: string } {
  if (unit.deletion || revision.deletion || revision.status !== 'completed' || !revision.text.trim()) throw new Error('此版本没有可导出的完整译文。')
  const pages = pdfUnitPages(unit.id, unit.material?.materialId)
  const markdown = !!pages || !!originalName && /\.md$/iu.test(originalName)
  const stem = (originalName?.replace(/\.[^.]+$/u, '') ?? `文本-${unit.order}`).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/[. ]+$/u, '').slice(0, 160) || 'translation'
  const pageSuffix = pages ? `-p${pages.firstPage}${pages.lastPage === pages.firstPage ? '' : `-${pages.lastPage}`}-单元${unit.order}` : ''
  return { content: pages ? pdfTranslationMarkdown(revision.text, pages) : revision.text,
    fileName: `${stem}${pageSuffix}-译文-v${revision.order}.${markdown ? 'md' : 'txt'}`, mimeType: markdown ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }
}
