import { parseDirectTargetLanguage, parseNormalTranslationTarget, type NormalTranslationMaterialTarget } from './normal-translation.js'

export const MAX_PDF_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_PDF_READ_CODE_POINTS = 16000
export const MAX_PDF_READ_BYTES = 64 * 1024
const PDF_UNREGISTERED_PAGE = '此页可读内容尚未登记为翻译区段。'
export const PDF_SCAN_PENDING = '扫描页待翻译。'
export const PDF_SCAN_SKIPPED = '扫描页未收录译文，请参阅原页。'

export function isPdfFile(name: string): boolean { return /\.pdf$/iu.test(name) }

export interface PdfInspection {
  readonly kind: 'text' | 'image' | 'mixed'
  readonly totalPages: number
  readonly scanPages?: readonly number[]
}

export function parsePdfInspection(value: unknown): PdfInspection {
  const { kind, totalPages, scanPages, ...rest } = record(value)
  if ((kind !== 'text' && kind !== 'image' && kind !== 'mixed') || !integer(totalPages) || Object.keys(rest).length)
    throw new TypeError('Invalid PDF inspection')
  if (scanPages !== undefined && (kind !== 'mixed' || !Array.isArray(scanPages) || !scanPages.length ||
    !scanPages.every((page, index) => integer(page) && page <= totalPages && (index === 0 || page > scanPages[index - 1]))))
    throw new TypeError('Invalid mixed PDF scan pages')
  return { kind, totalPages, ...(scanPages === undefined ? {} : { scanPages }) }
}

export interface PdfOutputOptions {
  readonly combine: boolean
  readonly keepFigures: boolean
  readonly translateScanPages?: boolean
}

export const DEFAULT_PDF_OUTPUT: PdfOutputOptions = { combine: true, keepFigures: false }
export const IMAGE_PDF_OUTPUT: PdfOutputOptions = { combine: false, keepFigures: false }

export const PDF_OBJECT_REFERENCE_GUIDANCE = 'Keep each standalone figure, scheme or table reference such as ［图 1 见原 PDF 第 3 页］ verbatim on its own line in reading order. The export uses the original label and page to insert the visual.'

export function parsePdfOutputOptions(input: unknown): PdfOutputOptions {
  const { combine, keepFigures, translateScanPages, ...rest } = record(input)
  if (typeof combine !== 'boolean' || typeof keepFigures !== 'boolean' ||
    translateScanPages !== undefined && typeof translateScanPages !== 'boolean' || Object.keys(rest).length)
    throw new TypeError('Invalid PDF output options')
  return { combine, keepFigures, ...(translateScanPages === undefined ? {} : { translateScanPages }) }
}

export interface PdfPages {
  readonly firstPage: number
  readonly lastPage: number
}

export function parsePdfPages(input: unknown): PdfPages {
  const { firstPage, lastPage } = record(input)
  if (!integer(firstPage) || !integer(lastPage) || lastPage < firstPage) throw new TypeError('Invalid PDF page range')
  return { firstPage, lastPage }
}

export interface PdfSection extends PdfPages { readonly text: string }
export interface PdfPosition { readonly page: number; readonly offset: number }
export interface PdfReadRange { readonly start: PdfPosition; readonly endPage?: number; readonly next?: PdfPosition | null; readonly repair?: true }
export interface PdfGap { readonly page: number; readonly message: string }
export interface PdfProgress {
  readonly totalPages: number
  readonly requested: PdfPages
  readonly next: PdfPosition | null
  readonly gaps: readonly PdfGap[]
}
export interface PdfReadBatch extends PdfProgress {
  readonly start: PdfPosition
  readonly lastReadPage: number
}

export function pendingPdfScanPages(progress: PdfProgress | null | undefined): number[] {
  return (progress?.gaps ?? []).filter(gap => gap.message === PDF_SCAN_PENDING).map(gap => gap.page).sort((a, b) => a - b)
}
export interface PdfSupplement {
  readonly page: number
  readonly label: string
  readonly text: string
  readonly issue?: string
}
export interface PdfDelivery {
  readonly name: string
  readonly progress: PdfProgress | null
  readonly sections: readonly (PdfPages & { readonly unitId: string; readonly revisionId: string })[]
  readonly unfinished: readonly PdfPages[]
  readonly supplements: readonly PdfSupplement[]
  readonly originalPages?: readonly number[]
}

export function parsePdfDelivery(input: unknown): PdfDelivery {
  const { name, progress, sections, unfinished, supplements, originalPages } = record(input)
  if (typeof name !== 'string' || !isPdfFile(name) || !Array.isArray(sections) || !Array.isArray(unfinished) || !Array.isArray(supplements)) throw new TypeError('Invalid PDF delivery')
  if (originalPages !== undefined && (!Array.isArray(originalPages) || !originalPages.every(page => integer(page))))
    throw new TypeError('Invalid untranslated PDF pages')
  return { name, progress: progress === null ? null : parsePdfProgress(progress), unfinished: unfinished.map(parsePdfPages), supplements: supplements.map(parsePdfSupplement),
    ...(originalPages?.length ? { originalPages: [...new Set<number>(originalPages)] } : {}),
    sections: sections.map(item => {
      const { unitId, revisionId } = record(item)
      if (typeof unitId !== 'string' || !pdfUnitPages(unitId) || typeof revisionId !== 'string' || !revisionId.trim()) throw new TypeError('Invalid PDF delivery section')
      return { ...parsePdfPages(item), unitId, revisionId }
    }) }
}

function integer(value: unknown, minimum = 1): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid PDF record')
  return input as Record<string, unknown>
}

export function parsePdfPosition(input: unknown): PdfPosition {
  const { page, offset } = record(input)
  if (!integer(page) || !integer(offset, 0)) throw new TypeError('Invalid PDF position')
  return { page, offset }
}

export function parsePdfProgress(input: unknown): PdfProgress {
  const { totalPages, next, requested, gaps } = record(input)
  const { firstPage, lastPage } = record(requested), position = next === null ? null : parsePdfPosition(next)
  if (!integer(totalPages) || !integer(firstPage) || !integer(lastPage) || lastPage < firstPage || lastPage > totalPages ||
    position && (position.page < firstPage || position.page > lastPage) || !Array.isArray(gaps)) throw new TypeError('Invalid PDF progress')
  const parsedGaps = gaps.map(gap => {
    const { page, message } = record(gap)
    if (!integer(page) || page < firstPage || page > lastPage || typeof message !== 'string' || !message.trim() || message.length > 500) throw new TypeError('Invalid PDF gap')
    return { page, message }
  })
  return { totalPages, requested: { firstPage, lastPage }, next: position, gaps: parsedGaps }
}

export function parsePdfReadBatch(input: unknown): PdfReadBatch {
  const { start, lastReadPage } = record(input)
  const progress = parsePdfProgress(input), position = parsePdfPosition(start), { requested, next } = progress
  if (!integer(lastReadPage) || position.page < requested.firstPage || position.page > lastReadPage || lastReadPage > requested.lastPage ||
    (next ? next.page !== lastReadPage + (next.offset === 0 ? 1 : 0) || next.page === position.page && next.offset <= position.offset : lastReadPage !== requested.lastPage) ||
    progress.gaps.some(gap => gap.page < position.page || gap.page > lastReadPage)) throw new TypeError('Invalid PDF batch')
  return { ...progress, start: position, lastReadPage }
}

export function parsePdfSupplement(input: unknown): PdfSupplement {
  const { page, label, text, issue } = record(input)
  if (!integer(page) || typeof label !== 'string' || !label.trim() || label.length > 120 || /[\r\n]/u.test(label) ||
    typeof text !== 'string' || !text.trim() || Array.from(text).length > 4000 || issue !== undefined && (typeof issue !== 'string' || issue.length > 500)) throw new TypeError('Invalid PDF supplement')
  return { page, label: label.trim(), text, ...(issue ? { issue } : {}) }
}

export interface PdfSectionRegistration {
  readonly target: NormalTranslationMaterialTarget
  readonly targetLanguage: string
  readonly sections: readonly PdfSection[]
  readonly read: PdfReadRange
}

export interface PdfScanPage {
  readonly target: NormalTranslationMaterialTarget
  readonly requested: PdfPages
  readonly page: number
  readonly targetLanguage: string
  readonly text: string
}

export function parsePdfScanPage(value: unknown): PdfScanPage {
  const { target: raw, requested, page, targetLanguage, text } = record(value)
  const target = parseNormalTranslationTarget(raw), range = parsePdfPages(requested)
  if (target.kind !== 'material' || !integer(page) || page < range.firstPage || page > range.lastPage ||
    typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_PDF_READ_BYTES)
    throw new TypeError('Invalid PDF scan page')
  return { target, requested: range, page, targetLanguage: parseDirectTargetLanguage(targetLanguage), text: text.trim() }
}

export function parsePdfSections(input: unknown): Omit<PdfSectionRegistration, 'read'> {
  const { target: reference, targetLanguage, sections } = record(input)
  const target = parseNormalTranslationTarget(reference)
  if (target.kind !== 'material' || !Array.isArray(sections) || sections.length > 32) throw new TypeError('Invalid PDF sections')
  let previousPage = 1
  const parsed = sections.map(section => {
    const { firstPage, lastPage } = parsePdfPages(section)
    const { text } = record(section)
    if (firstPage < previousPage || typeof text !== 'string' || !text.trim()) {
      throw new TypeError('PDF sections must contain text and follow source page order')
    }
    previousPage = lastPage
    return { firstPage, lastPage, text }
  })
  return { target, targetLanguage: parseDirectTargetLanguage(targetLanguage), sections: parsed }
}

export function parsePdfReadRange(input: unknown): PdfReadRange {
  const { start, endPage, next, repair } = record(input), position = parsePdfPosition(start)
  if (endPage !== undefined && (!integer(endPage) || endPage < position.page)) throw new TypeError('Invalid PDF end page')
  if (repair !== undefined && typeof repair !== 'boolean' || repair === true && (position.offset !== 0 || endPage === undefined || next !== null)) {
    throw new TypeError('PDF repair requires a complete page range and read.next=null')
  }
  const boundary = next == null ? next : parsePdfPosition(next)
  if (boundary && (boundary.page < position.page || boundary.page === position.page && boundary.offset <= position.offset ||
    endPage !== undefined && boundary.page > endPage)) throw new TypeError('Invalid PDF read boundary')
  return { start: position, ...(endPage === undefined ? {} : { endPage }), ...(boundary === undefined ? {} : { next: boundary }),
    ...(repair === true ? { repair: true } : {}) }
}

export function parsePdfSectionRegistration(input: unknown): PdfSectionRegistration {
  return { ...parsePdfSections(input), read: parsePdfReadRange(record(input).read) }
}

/** Only whole, previously unregistered pages can be filled without touching an existing unit. */
export function pdfRepairablePages(progress: PdfProgress | null | undefined, sections: readonly PdfPages[]): number[] {
  if (!progress) return []
  const next = progress.next
  return [...new Set(progress.gaps.filter(gap => gap.message === PDF_UNREGISTERED_PAGE && (!next || gap.page < next.page) &&
    !sections.some(section => section.firstPage <= gap.page && gap.page <= section.lastPage)).map(gap => gap.page))].sort((a, b) => a - b)
}

export function isPdfRepairRange(pages: readonly number[], first: number, last: number): boolean {
  return last >= first && pages.filter(page => first <= page && page <= last).length === last - first + 1
}

export function pdfSectionId(materialId: string, pages: PdfPages, index: number): string {
  return `unit:${materialId}:pdf:${pages.firstPage}-${pages.lastPage}:${index}`
}

export function pdfScanUnitId(materialId: string, page: number): string { return `unit:${materialId}:pdf-scan:${page}` }

export function pdfScanUnitPage(unitId: string, materialId?: string): number | undefined {
  const match = /^(unit:.+):pdf-scan:([1-9]\d*)$/u.exec(unitId)
  if (!match || materialId !== undefined && match[1] !== `unit:${materialId}`) return undefined
  const page = Number(match[2])
  return integer(page) ? page : undefined
}

/** Page ranges belong to the immutable PDF, independently of the editable unit text. */
export function pdfUnitPages(unitId: string, materialId?: string): PdfPages | undefined {
  const scan = pdfScanUnitPage(unitId, materialId)
  if (scan) return { firstPage: scan, lastPage: scan }
  const suffix = /^(unit:.+):pdf:([1-9]\d*)-([1-9]\d*):[1-9]\d*$/u.exec(unitId)
  if (!suffix || materialId !== undefined && suffix[1] !== `unit:${materialId}`) return undefined
  const firstPage = Number(suffix[2]), lastPage = Number(suffix[3])
  if (Number.isSafeInteger(lastPage) && firstPage <= lastPage) return { firstPage, lastPage }
  return undefined
}

export function pdfPageLabel(pages: PdfPages): string {
  const { firstPage, lastPage } = pages
  return `PDF 第 ${firstPage === lastPage ? firstPage : `${firstPage}–${lastPage}`} 页`
}

export function pdfTranslationMarkdown(text: string, pages: PdfPages): string {
  return `> 原稿 ${pdfPageLabel(pages)}\n\n${text}`
}

export function pdfDeliveryComplete(delivery: PdfDelivery): boolean {
  return (delivery.sections.length > 0 || !!delivery.originalPages?.length) && !!delivery.progress &&
    delivery.progress.next === null && !delivery.progress.gaps.length && !delivery.unfinished.length
}

function rangeLabel(pages: PdfPages): string {
  return pages.firstPage === pages.lastPage ? `${pages.firstPage}` : `${pages.firstPage}–${pages.lastPage}`
}

function pageRanges(ranges: readonly PdfPages[]): string {
  const merged: PdfPages[] = []
  for (const range of [...ranges].sort((a, b) => a.firstPage - b.firstPage)) {
    const last = merged.at(-1)
    if (last && range.firstPage <= last.lastPage + 1) merged[merged.length - 1] = { ...last, lastPage: Math.max(last.lastPage, range.lastPage) }
    else merged.push(range)
  }
  return merged.map(rangeLabel).join('、')
}

export function pdfPageNumbers(pages: readonly number[]): string {
  return pageRanges(pages.map(page => ({ firstPage: page, lastPage: page })))
}

export function pdfDeliveryHeader(delivery: PdfDelivery): string {
  const { progress, sections, unfinished } = delivery, complete = pdfDeliveryComplete(delivery)
  const lines = [`# ${complete ? 'PDF 译文' : 'PDF 译文节选'}`]
  if (progress) lines.push(`请求范围为 ${pdfPageLabel(progress.requested)}`)
  if (sections.length) lines.push(`已收录译文对应原稿第 ${pageRanges(sections)} 页`)
  if (delivery.originalPages?.length) lines.push(`原稿第 ${pdfPageNumbers(delivery.originalPages)} 页无待译文字，画面见原 PDF。`)
  if (!progress) lines.push('此记录没有读取进度，覆盖范围待核对。')
  if (progress?.next) lines.push(`原稿第 ${rangeLabel({ firstPage: progress.next.page, lastPage: progress.requested.lastPage })} 页仍有正文待读。`)
  if (unfinished.length) lines.push(`原稿第 ${pageRanges(unfinished)} 页有区段尚无有效定稿。`)
  for (const gap of [...(progress?.gaps ?? [])].sort((a, b) => a.page - b.page)) lines.push(`原稿第 ${gap.page} 页：${gap.message}`)
  return lines.join('\n\n')
}

export function pdfDeliveryName(delivery: PdfDelivery): string {
  const stem = delivery.name.replace(/\.pdf$/iu, '').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/[. ]+$/u, '')
  const requested = delivery.progress?.requested
  return `${(stem || 'PDF').slice(0, 140)}${requested ? `-p${rangeLabel(requested)}` : ''}-${pdfDeliveryComplete(delivery) ? '译文' : '译文节选'}.md`
}

export function pdfSupplementMarkdown(supplements: readonly PdfSupplement[]): string {
  const parts = ['## 图表补译']
  for (const item of [...supplements].sort((a, b) => a.page - b.page)) parts.push(`### ${item.label} · PDF 第 ${item.page} 页\n\n${item.text}${item.issue ? `\n\n待核对：${item.issue}` : ''}`)
  return parts.join('\n\n')
}
