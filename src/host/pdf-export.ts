import { pdfDeliveryHeader, pdfSupplementMarkdown, pdfTranslationMarkdown, type PdfDelivery } from '../shared/pdf-source.js'
import type { SourceIdentity } from '../shared/translation-sources.js'
import { PdfReadError, renderPdfObjects } from './pdf-text.js'
import type { ArtifactStorage } from './translation-delivery.js'

export async function writePdfExport(storage: ArtifactStorage, fileName: string, source: SourceIdentity,
  delivery: PdfDelivery, bodies: readonly string[], signal: AbortSignal, graphics?: Uint8Array) {
  let figures = 0, skippedFigures = 0, figuresUnavailable = false
  const location = await storage.writePdf(fileName, source, signal, async saveImage => {
    const sections = [...bodies], references = new Set<string>()
    const betweenSections = new Map<number, string[]>()
    figures = 0
    skippedFigures = 0
    figuresUnavailable = false
    if (graphics) {
      try {
        const ranges = delivery.progress?.next === null && !delivery.unfinished.length ? [delivery.progress.requested] : delivery.sections
        skippedFigures = await renderPdfObjects(graphics.slice(), ranges, signal, async (object, image) => {
          if (references.has(object.reference)) return
          const covered = delivery.sections.map((section, index) => ({ section, index }))
            .filter(({ section }) => section.firstPage <= object.page && object.page <= section.lastPage)
          const owner = covered.find(({ index }) => sections[index]!.split(/\r?\n/u).some(line => line.trim() === object.reference)) ?? covered[0]
          const url = await saveImage(image)
          const imageLink = `![${object.label} · 原 PDF 第 ${object.page} 页](${url})`
          const block = `${object.reference}\n\n${imageLink}`
          if (owner) {
            const body = sections[owner.index]!, lines = body.split(/\r?\n/u)
            const at = lines.findIndex(line => line.trim() === object.reference)
            if (at >= 0) {
              lines.splice(at + 1, 0, '', imageLink, '')
              sections[owner.index] = lines.join('\n')
            } else sections[owner.index] = `${body.trimEnd()}\n\n${block}`
          } else {
            const following = delivery.sections.findIndex(section => section.firstPage > object.page)
            const index = following < 0 ? sections.length : following
            const blocks = betweenSections.get(index) ?? []
            blocks.push(block)
            betweenSections.set(index, blocks)
          }
          references.add(object.reference)
          figures++
        }, source.pdf?.scanPages)
      } catch (error) {
        if (!(error instanceof PdfReadError)) throw error
        figuresUnavailable = true
      }
    }
    const content = [pdfDeliveryHeader(delivery)]
    delivery.sections.forEach((section, index) => content.push(...(betweenSections.get(index) ?? []), pdfTranslationMarkdown(sections[index]!, section)))
    content.push(...(betweenSections.get(sections.length) ?? []))
    if (delivery.supplements.length) content.push(pdfSupplementMarkdown(delivery.supplements))
    return content.join('\n\n') + '\n'
  })
  return { ...location, figures, skippedFigures, figuresUnavailable }
}
