import { MAX_PDF_READ_BYTES, MAX_PDF_READ_CODE_POINTS, MAX_PDF_SOURCE_BYTES, type PdfPages, type PdfPosition } from '../shared/pdf-source.js'

interface PdfPageText { readonly page: number; readonly text: string; readonly issue?: string }
type ExtractedPage = PdfPageText & { readonly textWithScripts?: string }
type PdfDocument = Awaited<ReturnType<typeof import('unpdf')['getDocumentProxy']>>
type Page = Awaited<ReturnType<PdfDocument['getPage']>>
type TextItem = Extract<Awaited<ReturnType<Page['getTextContent']>>['items'][number], { str: string }>

export class PdfReadError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options) }
}

type PdfCanvasFactory = Awaited<ReturnType<typeof import('unpdf')['createIsomorphicCanvasFactory']>>
async function withPdf<T>(bytes: Uint8Array, signal: AbortSignal, read: (pdf: PdfDocument) => Promise<T>, canvasFactory?: PdfCanvasFactory): Promise<T> {
  signal.throwIfAborted()
  if (bytes.byteLength > MAX_PDF_SOURCE_BYTES) throw new PdfReadError('source_too_large', 'PDF 超过 20 MiB 上限。')
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new PdfReadError('invalid_pdf', '原件不是有效的 PDF 文件。')
  const { getResolvedPDFJS } = await import('unpdf')
  const { getDocument } = await getResolvedPDFJS()
  signal.throwIfAborted()
  const task = getDocument({ data: bytes, stopAtErrors: true, useSystemFonts: true, isEvalSupported: false,
    ...(canvasFactory ? { CanvasFactory: canvasFactory } : {}) })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= task.destroy().catch(() => undefined)
  const cancel = (): void => { void close() }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const pdf = await task.promise.catch((cause: unknown) => {
      signal.throwIfAborted()
      if (cause instanceof Error && cause.name === 'PasswordException') throw new PdfReadError('encrypted_pdf', '此 PDF 需要密码。请提交可直接打开的副本。', { cause })
      throw new PdfReadError('invalid_pdf', '无法打开 PDF，原件可能损坏。', { cause })
    })
    signal.throwIfAborted()
    return await read(pdf)
  } finally {
    signal.removeEventListener('abort', cancel)
    await close()
  }
}

export interface PdfCrop { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

async function withPdfRenderer<T>(bytes: Uint8Array, signal: AbortSignal, use: (pdf: PdfDocument, render: (page: Page, crop?: PdfCrop) => Promise<Uint8Array>) => Promise<T>): Promise<T> {
  let CanvasFactory: PdfCanvasFactory, createCanvas: typeof import('@napi-rs/canvas')['createCanvas']
  try {
    const canvas = await import('@napi-rs/canvas')
    const { createIsomorphicCanvasFactory } = await import('unpdf')
    CanvasFactory = await createIsomorphicCanvasFactory(async () => canvas)
    createCanvas = canvas.createCanvas
  } catch (cause) { throw new PdfReadError('pdf_renderer_unavailable', '当前 Host 没有可用的 PDF 图表渲染组件。', { cause }) }
  return withPdf(bytes, signal, pdf => use(pdf, async (page, crop) => {
    const base = page.getViewport({ scale: 1 })
    const region = crop ?? { x: 0, y: 0, width: 1, height: 1 }
    const maxDimension = 1600, scale = Math.min(4, maxDimension / Math.max(region.width * base.width, region.height * base.height))
    const viewport = page.getViewport({ scale })
    const size = (value: number): number => Math.min(maxDimension, Math.max(1, Math.ceil(value)))
    const canvas = createCanvas(size(region.width * viewport.width), size(region.height * viewport.height))
    signal.throwIfAborted()
    const render = page.render({ canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport,
      transform: [1, 0, 0, 1, -region.x * viewport.width, -region.y * viewport.height] })
    const cancel = (): void => render.cancel()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) cancel()
      await render.promise
      signal.throwIfAborted()
      return canvas.toBuffer('image/png')
    } catch (cause) {
      signal.throwIfAborted()
      throw new PdfReadError('pdf_render_failed', '指定页或区域无法渲染，请核对原稿。', { cause })
    } finally { signal.removeEventListener('abort', cancel) }
  }), CanvasFactory)
}

export async function renderPdfSelection(bytes: Uint8Array, pageNumber: number, signal: AbortSignal, crop?: PdfCrop): Promise<Uint8Array> {
  return withPdfRenderer(bytes, signal, async (pdf, render) => {
    checkPageRange(pdf, pageNumber, pageNumber)
    return render(await pdf.getPage(pageNumber), crop)
  })
}

type LayoutRow = { y: number; items: TextItem[] }
type Run = { readonly x: number; readonly end: number; readonly y: number; readonly height: number; readonly text: string }
const x = (item: TextItem): number => item.transform[4]!
const y = (item: TextItem): number => item.transform[5]!

const mathGlyph = /[\u{1d400}-\u{1d7ff}ℂℋℕℙℚℝℛℤ\p{Script=Greek}]/u
const scriptGlyphs = /^[\p{L}\p{N}\p{Sm}()′'−-]{1,12}$/u

/** Recover small adjacent scripts before geometric line sorting separates them from their base. */
function attachMathScripts(items: readonly TextItem[]): TextItem[] | undefined {
  const result: TextItem[] = []
  let base: TextItem | undefined, changed = false
  for (const item of items) {
    const last = result.at(-1)
    if (base && last && mathGlyph.test(base.str.trimEnd().replace(/[)\]}|]+$/u, '').slice(-2)) && scriptGlyphs.test(item.str.trim())) {
      const rise = y(item) - y(base), gap = x(item) - (x(base) + Math.abs(base.width)), height = base.height
      if (item.height >= height * 0.5 && item.height < height * 0.88 && Math.abs(rise) > Math.max(2, height * 0.15) &&
        Math.abs(rise) <= height * 0.55 && Math.abs(gap) <= height * 0.25) {
        const script = item.str.trim().replace(/[′']/gu, '\\prime ')
        const end = Math.max(x(last) + Math.abs(last.width), x(item) + Math.abs(item.width))
        result[result.length - 1] = { ...last, width: end - x(last), str: `${last.str.trimEnd()}${rise > 0 ? '^' : '_'}{${script.trim()}}` }
        changed = true
        continue
      }
    }
    result.push(item)
    base = item
  }
  return changed ? result : undefined
}

function positionedRows(items: TextItem[]): LayoutRow[] {
  const rows: LayoutRow[] = []
  for (const item of items.sort((a, b) => y(b) - y(a) || x(a) - x(b))) {
    const last = rows.at(-1)
    if (last && Math.abs(last.y - y(item)) <= 2) last.items.push(item)
    else rows.push({ y: y(item), items: [item] })
  }
  return rows
}

function textRuns(row: LayoutRow): Run[] {
  const runs: Run[] = []
  for (const item of row.items.sort((a, b) => x(a) - x(b))) {
    const start = x(item), end = start + Math.abs(item.width), last = runs.at(-1), text = item.str.trim()
    if (last && start - last.end < Math.max(14, item.height * 1.5)) {
      const space = start - last.end > Math.max(1, item.height * 0.14) || /^\s/u.test(item.str)
      runs[runs.length - 1] = { ...last, end: Math.max(last.end, end), height: Math.max(last.height, item.height), text: last.text + (space ? ' ' : '') + text }
    } else runs.push({ x: start, end, y: row.y, height: item.height, text })
  }
  return runs
}

const captionPattern = /^(table|figure|fig\.?|scheme|图式|图|表)\s*([\p{L}]?\d+(?:[.-]\d+)*)(?:\s*[.:：。]|\s*$)/iu

function pdfCaption(text: string, page: number) {
  const match = captionPattern.exec(text.trim())
  if (!match) return undefined
  const kind = /^(table|表)$/iu.test(match[1]!) ? '表' : /^(scheme|图式)$/iu.test(match[1]!) ? '图式' : '图'
  const label = `${kind} ${match[2]!.toUpperCase()}`
  return { label, reference: `［${label} 见原 PDF 第 ${page} 页］`, table: kind === '表' }
}

function caption(run: Run, page: number): Run | undefined {
  const object = pdfCaption(run.text, page)
  return object && { ...run, text: object.reference }
}

type Bounds = readonly [left: number, bottom: number, right: number, top: number]
type PdfObject = NonNullable<ReturnType<typeof pdfCaption>> & { readonly page: number; readonly crop?: PdfCrop }

async function objectRegions(page: Page): Promise<PdfObject[]> {
  const { getResolvedPDFJS } = await import('unpdf')
  const { OPS, Util } = await getResolvedPDFJS()
  const [operators, text] = await Promise.all([page.getOperatorList(), page.getTextContent()])
  const rows = positionedRows(text.items.filter((item: { str?: string }): item is TextItem => !!item.str?.trim())).map(textRuns)
  const captions = rows.flatMap(row => row.flatMap(run => {
    const caption = pdfCaption(run.text, page.pageNumber)
    return caption ? [{ run, caption }] : []
  }))
  if (!captions.length) return []

  const images: Bounds[] = [], rules: Bounds[] = [], stack: number[][] = []
  let transform = [1, 0, 0, 1, 0, 0]
  const opBounds = (bounds: ArrayLike<number>): Bounds => {
    const [x0, y0, x1, y1] = Array.from(bounds)
    const points = [[x0!, y0!], [x0!, y1!], [x1!, y0!], [x1!, y1!]]
    for (const point of points) Util.applyTransform(point, transform, 0)
    return [Math.min(...points.map(point => point[0]!)), Math.min(...points.map(point => point[1]!)),
      Math.max(...points.map(point => point[0]!)), Math.max(...points.map(point => point[1]!))]
  }
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i], args = operators.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push(transform)
      if (op === OPS.paintFormXObjectBegin && args[0]) transform = Util.transform(transform, args[0])
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      transform = stack.pop() ?? transform
    } else if (op === OPS.transform) {
      transform = Util.transform(transform, args)
    } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      const bounds = opBounds([0, 0, 1, 1])
      if (bounds[2] - bounds[0] >= 36 && bounds[3] - bounds[1] >= 24) images.push(bounds)
    } else if (op === OPS.constructPath && args[0] !== OPS.endPath && args[2]?.length === 4) {
      const bounds = opBounds(args[2])
      if (bounds[2] - bounds[0] >= 48 && bounds[3] - bounds[1] <= 2) rules.push(bounds)
    }
  }
  const viewport = page.getViewport({ scale: 1 })
  const cropFor = (bounds: Bounds, padding: number): PdfCrop | undefined => {
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle([...bounds])
    const left = Math.max(0, Math.min(x0!, x1!) - padding), top = Math.max(0, Math.min(y0!, y1!) - padding)
    const right = Math.min(viewport.width, Math.max(x0!, x1!) + padding), bottom = Math.min(viewport.height, Math.max(y0!, y1!) + padding)
    return right > left && bottom > top ? { x: left / viewport.width, y: top / viewport.height,
      width: (right - left) / viewport.width, height: (bottom - top) / viewport.height } : undefined
  }
  const aligned = (run: Run, bounds: Bounds): boolean =>
    Math.min(run.end, bounds[2]) - Math.max(run.x, bounds[0]) >= Math.min(18, (run.end - run.x) / 2)
  const imageMatches = (run: Run, bounds: Bounds): boolean => {
    if (!aligned(run, bounds)) return false
    const below = run.y - bounds[3], above = bounds[1] - run.y
    return (below >= -2 && below <= run.height * 5) || (above >= -2 && above <= run.height * 4)
  }
  const tableBounds = (run: Run): Bounds | undefined => {
    // An unambiguous set of top/header/bottom rules brackets the complete table.
    const top = rules.filter(rule => aligned(run, rule) && run.y >= rule[3] && run.y - rule[3] <= run.height * 5)
      .sort((a, b) => b[3] - a[3])[0]
    if (!top) return undefined
    const nextCaption = captions.find(other => other.run.y < run.y && aligned(other.run, top))?.run.y ?? -Infinity
    const levels = rules.filter(rule => Math.abs(rule[0] - top[0]) <= 2 && Math.abs(rule[2] - top[2]) <= 2 &&
      rule[3] < top[1] - 3 && rule[3] > nextCaption).sort((a, b) => b[3] - a[3])
    const bottom = levels.at(-1)
    if (levels.length < 2 || !bottom) return undefined
    const cells = rows.filter(row => row[0]!.y < levels[0]![3] && row[0]!.y > bottom[1])
      .map(row => row.filter(cell => cell.x >= top[0] - 2 && cell.end <= top[2] + 2))
    if (cells.filter(row => row.length >= 2).length < 2) return undefined
    return [top[0], bottom[1], top[2], top[3]]
  }
  return captions.map(({ run, caption }) => {
    const candidates = images.filter(bounds => imageMatches(run, bounds))
    const bounds = caption.table ? tableBounds(run) ?? (candidates.length === 1 ? candidates[0] : undefined)
      : candidates.length === 1 ? candidates[0] : undefined
    const crop = bounds && captions.filter(other => imageMatches(other.run, bounds)).length <= 1 ? cropFor(bounds, caption.table ? 2 : 0) : undefined
    return { ...caption, page: page.pageNumber, ...(crop ? { crop } : {}) }
  })
}

export async function renderPdfObjects(bytes: Uint8Array, ranges: readonly PdfPages[], signal: AbortSignal,
  save: (object: Omit<PdfObject, 'crop'>, image: Uint8Array) => Promise<void>): Promise<number> {
  return withPdfRenderer(bytes, signal, async (pdf, render) => {
    const pages = new Set<number>()
    for (const { firstPage, lastPage } of ranges) {
      checkPageRange(pdf, firstPage, lastPage)
      for (let number = firstPage; number <= lastPage; number++) pages.add(number)
    }
    let skipped = 0
    for (const number of pages) {
      signal.throwIfAborted()
      const page = await pdf.getPage(number)
      try {
        const objects = await objectRegions(page).catch(() => { signal.throwIfAborted(); skipped++; return [] })
        for (const { crop, ...object } of objects) {
          if (!crop) { skipped++; continue }
          const image = await render(page, crop).catch(() => { signal.throwIfAborted(); skipped++; return undefined })
          if (image) await save(object, image)
        }
      } finally { page.cleanup() }
    }
    return skipped
  })
}

// Untagged tables have no semantic markers. Repeated aligned, short cells next to a
// caption can be omitted locally. Prose-sized columns are kept for the reading order.
function rowsWithoutCaptions(rows: Run[][], page: number): Run[][] {
  function matchesCells(cells: Run[] | undefined, anchors: Run[]): boolean {
    return !!cells && cells.length === anchors.length && cells.every((cell, index) =>
      cell.text.length <= 40 && Math.abs(cell.x - anchors[index]!.x) <= 14 && !caption(cell, page))
  }
  const omitted = new Set<Run>()
  const excludeCaptionContinuation = (start: Run, index: number): void => {
    const width = start.end - start.x
    if (width < 90) return
    let previous = start
    for (let i = index + 1; i < rows.length; i++) {
      const line = rows[i]!.find(run => Math.abs(run.x - start.x) <= 5 && run.end <= start.end + 14)
      if (previous.y - rows[i]![0]!.y > start.height * 1.55) break
      if (!line) continue
      if (caption(line, page) || Math.abs(line.height - start.height) > 1.4) break
      omitted.add(line)
      if (line.end - line.x < width * 0.78) break
      previous = line
    }
  }
  // In untagged charts the short axis/series labels often form a compact group above
  // the caption. Limit the search to that column, leaving adjacent prose untouched.
  const excludeFigureLabels = (start: Run, index: number): void => {
    const labels: Run[] = []
    let previousY = start.y
    for (let i = index - 1; i >= 0; i--) {
      const row = rows[i]!, height = row[0]!.y - previousY
      if (height > start.height * 4) break
      const inFigure = row.filter(run => run.x >= start.x - 8 && run.end <= start.end + 14)
      if (!inFigure.length) continue
      if (!inFigure.every(run => run.height < start.height * 0.8)) break
      labels.push(...inFigure)
      previousY = row[0]!.y
    }
    if (labels.length >= 3) for (const label of labels) omitted.add(label)
  }
  const result = rows.map((runs, index) => runs.map(run => {
    const reference = caption(run, page)
    if (!reference) return run
    excludeCaptionContinuation(run, index)
    if (reference.text.startsWith('［表')) {
      for (const direction of [1, -1]) {
        const first = rows[index + direction]
        const second = rows[index + direction * 2]
        if (!first || first.length < 2 || !matchesCells(first, first) || !matchesCells(second, first)) continue
        for (let i = index + direction; ; i += direction) {
          if (!matchesCells(rows[i], first)) break
          for (const cell of rows[i]!) omitted.add(cell)
        }
        break
      }
    } else excludeFigureLabels(run, index)
    return reference
  }))
  return result.map(runs => runs.filter(run => !omitted.has(run))).filter(runs => runs.length > 0)
}

function readingOrder(rows: Run[][], middle: number): string {
  const separated = rows.filter(runs => runs.length === 2 && runs[0]!.end < middle && runs[1]!.x >= middle).length
  if (separated < 2) return rows.map(runs => runs.map(run => run.text).join(' ')).join('\n')
  const lines: string[] = [], left: string[] = [], right: string[] = []
  const appendColumns = (): void => { lines.push(...left, ...right); left.length = 0; right.length = 0 }
  for (const runs of rows) {
    if (runs.some(run => run.x < middle && run.end > middle)) {
      appendColumns()
      lines.push(runs.map(run => run.text).join(' '))
    } else {
      for (const run of runs) (run.x < middle ? left : right).push(run.text)
    }
  }
  appendColumns()
  return lines.join('\n')
}

async function extractPage(page: Page, number: number): Promise<ExtractedPage> {
  const structure = await page.getStructTree().catch(() => null)
  const skipped = new Map<string, string>(), objects = new Map<string, TextItem>()
  if (structure) {
    type Node = NonNullable<typeof structure> | NonNullable<typeof structure>['children'][number]
    let nextObject = 0
    const visit = (node: Node, object?: string): void => {
      if ('children' in node) {
        const current = object ?? (/^(?:Table|Figure|Caption)$/u.test(node.role) ? String(++nextObject) : undefined)
        for (const child of node.children) visit(child, current)
      } else if (object && node.id) skipped.set(node.id, object)
    }
    visit(structure)
  }
  const { items } = await page.getTextContent({ includeMarkedContent: skipped.size > 0 })
  const active: (string | undefined)[] = [], textItems: TextItem[] = []
  for (const item of items) {
    if (!('str' in item)) {
      if (item.type === 'endMarkedContent') active.pop()
      else active.push(item.id ? skipped.get(item.id) ?? active.at(-1) : active.at(-1))
      continue
    }
    if (!item.str.trim()) continue
    const object = active.at(-1)
    if (!object) textItems.push(item)
    else if (!objects.has(object)) objects.set(object, { ...item, width: 0, str: `［图表见原 PDF 第 ${number} 页］` })
  }
  const layout = (items: TextItem[]) => rowsWithoutCaptions(positionedRows([...items, ...objects.values()]).map(textRuns), number)
  const rows = layout(textItems)
  const box = page.view
  const middle = (box[0]! + box[2]!) / 2, text = readingOrder(rows, middle).trim()
  const prose = rows.some(runs => runs.some(run => !run.text.startsWith('［') && /[\p{L}\p{N}]/u.test(run.text)))
  if (!prose) return { page: number, text: '', issue: '无可用正文，可能是扫描页或空白页。' }
  const scripted = attachMathScripts(textItems)
  return { page: number, text, ...(scripted ? { textWithScripts: readingOrder(layout(scripted), middle).trim() } : {}),
    ...(text.includes('\uFFFD') ? { issue: '文字层含无法解码的字符，请核对原页。' } : {}) }
}

async function loadPage(pdf: PdfDocument, number: number, signal: AbortSignal): Promise<ExtractedPage> {
  signal.throwIfAborted()
  try { return await extractPage(await pdf.getPage(number), number) }
  catch { signal.throwIfAborted(); return { page: number, text: '', issue: '此页文字层提取失败，请核对原页。' } }
}

function checkPageRange(pdf: PdfDocument, first: number, last: number): void {
  if (!Number.isSafeInteger(first) || first < 1 || first > last || last > pdf.numPages) throw new PdfReadError('invalid_pdf_range', `PDF 共 ${pdf.numPages} 页，指定页范围超出原件。`)
}

async function readWindow(pdf: PdfDocument, start: PdfPosition, end: number, signal: AbortSignal) {
  checkPageRange(pdf, start.page, end)
  const pages: (PdfPageText & { readonly offset: number })[] = []
  const result = (next: PdfPosition | null) => ({ totalPages: pdf.numPages, pages, next, read: { start, endPage: end, next } })
  const encoder = new TextEncoder()
  let remaining = MAX_PDF_READ_CODE_POINTS
  for (let number = start.page; number <= end; number++) {
    const extracted = await loadPage(pdf, number, signal)
    signal.throwIfAborted()
    const offset = number === start.page ? start.offset : 0, points = Array.from(extracted.text)
    if (offset > 0 && offset >= points.length) throw new PdfReadError('invalid_pdf_range', '续读位置超出此页文字范围。')
    const length = points.length - offset
    if (pages.length && (length > remaining || pages.length >= 32)) return result({ page: number, offset })
    let count = Math.min(length, remaining)
    const nextFor = (size: number): PdfPosition | null => size < length ? { page: number, offset: offset + size }
      : number < end ? { page: number + 1, offset: 0 } : null
    // Persisted offsets still address the original flattened text, including on older records.
    const withScripts = !offset && count === length ? extracted.textWithScripts : undefined
    const scriptLength = withScripts ? Array.from(withScripts).length : 0
    const entry = (text: string) => ({ page: number, offset, text, ...(extracted.issue ? { issue: extracted.issue } : {}) })
    const raw = (size: number): string => points.slice(offset, offset + size).join('')
    const fits = (text: string, size: number): boolean => {
      pages.push(entry(text))
      const bytes = encoder.encode(JSON.stringify(result(nextFor(size)))).byteLength
      pages.pop()
      return bytes <= MAX_PDF_READ_BYTES
    }
    let text = withScripts && scriptLength <= remaining ? withScripts : raw(count)
    if (!fits(text, count)) {
      text = raw(count)
      if (!fits(text, count)) {
        if (pages.length) return result({ page: number, offset })
        // A single page can exceed the byte budget even within the code-point cap.
        let low = 1, high = count
        while (low < high) {
          const middle = Math.ceil((low + high) / 2)
          if (fits(raw(middle), middle)) low = middle
          else high = middle - 1
        }
        count = low
        text = raw(count)
      }
    }
    pages.push(entry(text))
    remaining -= Math.max(count, text === withScripts ? scriptLength : 0)
    if (count < length) return result(nextFor(count))
  }
  return result(null)
}

/** Each model-visible read is bounded independently of the PDF's size or page count. */
export function readPdfText(bytes: Uint8Array, start: PdfPosition, lastPage: number | undefined, signal: AbortSignal) {
  return withPdf(bytes, signal, pdf => readWindow(pdf, start, lastPage ?? pdf.numPages, signal))
}

/** Verify coverage using the original pages and their flattened offsets. Only page facts leave this pass. */
export function readPdfCoverage(bytes: Uint8Array, start: PdfPosition, lastPage: number | undefined, boundary: PdfPosition | null, signal: AbortSignal) {
  return withPdf(bytes, signal, async pdf => {
    const end = lastPage ?? pdf.numPages
    checkPageRange(pdf, start.page, end)
    if (boundary && (boundary.page > end || boundary.page < start.page || boundary.page === start.page && boundary.offset <= start.offset)) {
      throw new PdfReadError('invalid_pdf_read_boundary', '续读位置须在已处理正文之后、请求页范围内。')
    }
    const last = boundary ? boundary.page - (boundary.offset === 0 ? 1 : 0) : end
    const pages: (Pick<PdfPageText, 'page' | 'issue'> & { readonly hasText: boolean })[] = []
    for (let number = start.page; number <= last; number++) {
      const { page, text, issue } = await loadPage(pdf, number, signal)
      signal.throwIfAborted()
      const from = number === start.page ? start.offset : 0
      const to = number === boundary?.page ? boundary.offset : undefined
      const points = from || to !== undefined ? Array.from(text) : undefined
      if (points && (from >= points.length || to !== undefined && to >= points.length)) {
        throw new PdfReadError('invalid_pdf_read_boundary', '续读位置超出此页文字范围。')
      }
      pages.push({ page, hasText: !!(points ? points.slice(from, to).join('') : text).trim(), ...(issue ? { issue } : {}) })
    }
    return { totalPages: pdf.numPages, pages, next: boundary }
  })
}
