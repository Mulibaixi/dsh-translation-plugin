import type { FileUnitView } from './material-submissions.js'
import { currentFinalRevision, isTextUnit, type TranslationHistory } from './translation-history.js'
import { pdfUnitPages, pdfDeliveryHeader, pdfDeliveryName, pdfSupplementMarkdown, pdfTranslationMarkdown, type PdfDelivery } from '../shared/pdf-source.js'

/** Capture current finals once so a save uses the same versions throughout. */
export function capturePdfDelivery(file: FileUnitView, history: TranslationHistory): PdfDelivery & { readonly bodies: readonly string[]; readonly totalSections: number } {
  const finals = [], unfinished = []
  for (const unit of history.units) {
    if (!isTextUnit(unit) || unit.material?.materialId !== file.materialId) continue
    const pages = pdfUnitPages(unit.id, file.materialId)
    if (!pages) continue
    const revision = unit.deletion ? undefined : currentFinalRevision(unit)
    if (revision?.text) {
      finals.push({ section: { ...pages, unitId: unit.id, revisionId: revision.id }, body: revision.text })
    } else unfinished.push(pages)
  }
  finals.sort((a, b) => a.section.firstPage - b.section.firstPage)
  const progress = file.pdfProgress ?? null
  return { name: file.name, progress, sections: finals.map(item => item.section), unfinished, supplements: file.pdfSupplements ?? [],
    bodies: finals.map(item => item.body), totalSections: finals.length + unfinished.length }
}

export function buildPdfExport(delivery: ReturnType<typeof capturePdfDelivery>) {
  const mimeType = 'text/markdown;charset=utf-8'
  const parts = [pdfDeliveryHeader(delivery)]
  delivery.sections.forEach((section, index) => parts.push(pdfTranslationMarkdown(delivery.bodies[index]!, section)))
  if (delivery.supplements.length) parts.push(pdfSupplementMarkdown(delivery.supplements))
  return { content: new Blob([parts.join('\n\n'), '\n'], { type: mimeType }), fileName: pdfDeliveryName(delivery), mimeType }
}
