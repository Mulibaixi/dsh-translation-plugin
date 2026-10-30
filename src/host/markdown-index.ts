import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'

interface MarkdownNode {
  readonly type: string
  readonly alt?: string | null | undefined
  readonly children?: readonly MarkdownNode[] | undefined
  readonly position?: { readonly start: { readonly offset?: number | undefined }; readonly end: { readonly offset?: number | undefined } } | undefined
}
interface Piece { readonly start: number; readonly end: number; readonly separator?: string }
interface Projection { readonly source: string; readonly pieces: readonly Piece[]; readonly offsets: readonly number[] }
let cached: Projection | undefined

/** Same front-matter boundary rule used by the Markdown file opening projection. */
function frontMatterEnd(text: string): number {
  const start = text.startsWith('\uFEFF') ? 1 : 0, opening = /^---[ \t]*(?:\r\n|\n|\r)/u.exec(text.slice(start))
  if (!opening) return start
  let cursor = start + opening[0].length
  while (cursor < text.length) {
    const rest = text.slice(cursor), end = /\r\n|\n|\r/u.exec(rest), line = end ? rest.slice(0, end.index) : rest
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(line)) return end ? cursor + end.index + end[0].length : text.length
    if (!end) break
    cursor += end.index + end[0].length
  }
  return start
}

/** Extract readable runs inside an already parsed HTML node, keeping source coordinates. */
function htmlPieces(text: string, start: number, end: number, initialRaw?: string): { readonly pieces: readonly Piece[]; readonly raw: string | undefined } {
  const result: Piece[] = []
  let cursor = start, run = start, raw = initialRaw
  while (cursor < end) {
    if (text[cursor] !== '<' || !/^(?:<!--|<\/?[A-Za-z])/u.test(text.slice(cursor, cursor + 8))) { cursor++; continue }
    if (!raw && cursor > run) result.push({ start: run, end: cursor })
    if (text.startsWith('<!--', cursor)) { const close = text.indexOf('-->', cursor + 4); cursor = close < 0 || close + 3 > end ? end : close + 3; run = cursor; continue }
    const name = /^<\/?([A-Za-z][A-Za-z\d:-]*)/u.exec(text.slice(cursor))
    let close = cursor + 1, quote: string | undefined
    for (; close < end; close++) {
      const character = text[close]
      if (quote) { if (character === quote) quote = undefined }
      else if (character === '"' || character === "'") quote = character
      else if (character === '>') break
    }
    if (close === end) { cursor = end; run = end; break }
    if (name) {
      const tag = name[1]!.toLowerCase(), closing = text[cursor + 1] === '/'
      if (raw === tag && closing) raw = undefined
      else if (!raw && !closing && ['script', 'style', 'pre', 'code'].includes(tag)) raw = tag
    }
    cursor = close + 1; run = cursor
  }
  if (!raw && run < end) result.push({ start: run, end })
  return { pieces: result, raw }
}

function project(source: string): Projection {
  if (cached?.source === source) return cached
  const prefix = frontMatterEnd(source), text = source.slice(prefix)
  const tree: MarkdownNode = fromMarkdown(text, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] })
  const pieces: Piece[] = [], headingAnchors: { start: number; end: number }[] = []
  let htmlRaw: string | undefined
  function visit(node: MarkdownNode): void {
    const from = node.position?.start.offset, to = node.position?.end.offset
    if (from === undefined || to === undefined) { for (const child of node.children ?? []) visit(child); return }
    const start = prefix + from, end = prefix + to
    if (['code', 'inlineCode', 'math', 'inlineMath', 'definition'].includes(node.type)) return
    if (node.type === 'link' && source[start] !== '[') return // Autolinks contain only a destination.
    if (node.type === 'text') { if (!htmlRaw) pieces.push({ start, end }); return }
    if (node.type === 'html') { const html = htmlPieces(source, start, end, htmlRaw); pieces.push(...html.pieces); htmlRaw = html.raw; return }
    if (node.type === 'image' || node.type === 'imageReference') {
      let at = start + 2, depth = 1
      const label = at
      for (; at < end; at++) {
        if (source[at] === '\\') { at++; continue }
        if (source[at] === '[') depth++
        else if (source[at] === ']' && --depth === 0) break
      }
      if (at < end && node.alt) pieces.push({ start: label, end: at })
      return
    }
    if (node.type === 'heading') {
      const anchor = /[ \t]+\{#[^\s{}]+\}[ \t]*$/u.exec(source.slice(start, end))
      if (anchor) headingAnchors.push({ start: start + anchor.index, end })
    }
    for (const child of node.children ?? []) visit(child)
    if (node.type === 'tableCell') pieces.push({ start: end, end, separator: ' ' })
    else if (['paragraph', 'heading', 'listItem', 'blockquote', 'tableRow'].includes(node.type)) pieces.push({ start: end, end, separator: '\n' })
  }
  visit(tree)
  const filtered = pieces.flatMap(piece => {
    if (piece.separator) return [piece]
    const anchor = headingAnchors.find(range => range.start < piece.end && range.end > piece.start)
    return anchor ? piece.start < anchor.start ? [{ start: piece.start, end: anchor.start }] : [] : [piece]
  }).sort((a, b) => a.start - b.start || a.end - b.end)
  const offsets: number[] = [0]
  let offset = 0
  for (const character of source) { offset += character.length; offsets.push(offset) }
  cached = { source, pieces: filtered, offsets }
  return cached
}

/** A derived embedding projection only. References always retain the untouched original range. */
export function markdownIndexProjection(source: string, range?: { readonly start: number; readonly end: number }): string {
  const current = project(source), start = range ? current.offsets[range.start] : 0, end = range ? current.offsets[range.end] : source.length
  if (start === undefined || end === undefined || end < start) throw new RangeError('Markdown 索引范围超出原文。')
  let result = ''
  for (const piece of current.pieces) {
    if (piece.separator) { if (piece.start >= start && piece.start < end) result += piece.separator; continue }
    const from = Math.max(start, piece.start), to = Math.min(end, piece.end)
    if (to > from) result += source.slice(from, to)
  }
  return result.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, '$1').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}
