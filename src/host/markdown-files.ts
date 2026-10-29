import { fromMarkdown } from 'mdast-util-from-markdown'
import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import { sourceSha256 } from './source-storage.js'

interface MarkdownNode {
  readonly type: string
  readonly url?: string
  readonly identifier?: string
  readonly children?: readonly MarkdownNode[]
  readonly position?: { readonly start: { readonly offset?: number | undefined }; readonly end: { readonly offset?: number | undefined } } | undefined
}
interface Replacement { readonly start: number; readonly end: number; readonly text: string }

export function isMarkdownFile(name: string): boolean { return /\.md$/iu.test(name) }

/** Front matter is metadata, not Markdown: leave its bytes and image-like values untouched. */
function frontMatterEnd(text: string): number {
  const start = text.startsWith('\uFEFF') ? 1 : 0
  const opening = /^---[ \t]*(?:\r\n|\n|\r)/u.exec(text.slice(start))
  if (!opening) return 0
  let cursor = start + opening[0].length
  while (cursor < text.length) {
    const rest = text.slice(cursor), end = /\r\n|\n|\r/u.exec(rest)
    const line = end ? rest.slice(0, end.index) : rest
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(line)) return end ? cursor + end.index + end[0].length : text.length
    if (!end) return 0
    cursor += end.index + end[0].length
  }
  return 0
}

function codeSpanEnd(text: string, start: number): number {
  let end = start
  while (text[end] === '`') end++
  const length = end - start
  let cursor = end
  while (cursor < text.length) {
    const next = text.indexOf('`', cursor)
    if (next < 0) break
    cursor = next
    while (text[cursor] === '`') cursor++
    if (cursor - next === length) return cursor
  }
  return end
}

function destinationStart(text: string, start: number): number {
  let cursor = start
  while (cursor < text.length) {
    if (/[ \t]/u.test(text[cursor]!)) { cursor++; continue }
    if (text[cursor] !== '\n' && text[cursor] !== '\r') break
    if (text[cursor++] === '\r' && text[cursor] === '\n') cursor++
    // mdast offsets include the continuation-line prefixes of enclosing quotes.
    while (cursor < text.length && /[> \t]/u.test(text[cursor]!)) cursor++
  }
  return cursor
}

/** Only locate the destination inside an already parsed image/definition; do not parse the document with regex. */
function destinationRange(text: string, definition: boolean): { start: number; end: number } | undefined {
  const opening = definition ? 0 : 1
  if (text[opening] !== '[') return undefined
  let cursor = opening + 1, depth = 1
  for (; cursor < text.length; cursor++) {
    const character = text[cursor]
    if (character === '\\') { cursor++; continue }
    if (!definition && character === '`') { cursor = codeSpanEnd(text, cursor) - 1; continue }
    if (character === '[') depth++
    else if (character === ']' && --depth === 0) break
  }
  if (text[cursor + 1] !== (definition ? ':' : '(')) return undefined
  cursor = destinationStart(text, cursor + 2)
  if (text[cursor] === '<') {
    const start = ++cursor
    for (; cursor < text.length; cursor++) {
      if (text[cursor] === '\\') cursor++
      else if (text[cursor] === '>') return { start, end: cursor }
    }
    return undefined
  }
  const start = cursor
  depth = 0
  for (; cursor < text.length; cursor++) {
    const character = text[cursor]!
    if (character === '\\') { cursor++; continue }
    if (/\s/u.test(character)) break
    if (character === '(') depth++
    else if (character === ')') { if (depth === 0) break; depth-- }
  }
  return cursor > start ? { start, end: cursor } : undefined
}

/** Produce a local opening/export projection; the recorded Markdown remains the source of truth. */
export async function resolveMarkdownImages(text: string, originalFilePath?: string,
  writeImage?: (name: string, bytes: Uint8Array) => Promise<string>): Promise<string> {
  if (!originalFilePath) return text
  const prefix = frontMatterEnd(text), source = text.slice(prefix)
  const tree: MarkdownNode = fromMarkdown(source, { extensions: [math()], mdastExtensions: [mathFromMarkdown()] })
  const images: MarkdownNode[] = [], references = new Set<string>(), definitions = new Map<string, MarkdownNode>()
  function visit(node: MarkdownNode): void {
    if (node.type === 'image') images.push(node)
    else if (node.type === 'imageReference' && node.identifier !== undefined) references.add(node.identifier)
    else if (node.type === 'definition' && node.identifier !== undefined && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  const candidates = [...images, ...[...references].flatMap(identifier => definitions.has(identifier) ? [definitions.get(identifier)!] : [])]
  if (!candidates.length) return text
  const pathName = 'node:path', urlName = 'node:url'
  const [paths, urls] = await Promise.all([
    import(pathName) as Promise<{ readonly win32: { isAbsolute(path: string): boolean }; readonly posix: { isAbsolute(path: string): boolean } }>,
    import(urlName) as Promise<{ pathToFileURL(path: string, options: { windows: boolean }): URL }>,
  ])
  const windows = /^[A-Za-z]:[\\/]|^\\\\/u.test(originalFilePath)
  if (!(windows ? paths.win32 : paths.posix).isAbsolute(originalFilePath)) return text
  const base = urls.pathToFileURL(originalFilePath, { windows })
  const copied = new Map<string, string>()
  const replacements: Replacement[] = []
  for (const node of candidates) {
    const url = node.url, start = node.position?.start.offset, end = node.position?.end.offset
    if (!url || start === undefined || end === undefined || /^(?:[A-Za-z][A-Za-z\d+.-]*:|[\\/#])/u.test(url)) continue
    const destination = destinationRange(source.slice(start, end), node.type === 'definition')
    if (!destination) continue
    const raw = source.slice(start + destination.start, start + destination.end)
    const literal = source[start + destination.start - 1] === '<' ? `<${raw}>` : raw
    const check: MarkdownNode = fromMarkdown(`![](${literal})`)
    const parsed = check.children?.[0]?.children
    if (parsed?.length !== 1 || parsed[0]?.type !== 'image' || parsed[0].url !== url) continue
    let resolved: string
    try { resolved = new URL(url.replace(/\\/gu, '/'), base).href.replace(/\(/gu, '%28').replace(/\)/gu, '%29') }
    catch { continue }
    if (writeImage) {
      const image = new URL(resolved), suffix = image.search + image.hash
      image.search = ''; image.hash = ''
      const extension = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|apng)$/iu.exec(image.pathname)?.[1]?.toLowerCase()
      if (!extension || image.protocol !== 'file:') continue
      let relative = copied.get(image.href)
      if (!relative) {
        const fsName = 'node:fs/promises'
        const fs = await import(fsName) as { readFile(path: URL): Promise<Uint8Array> }
        let bytes: Uint8Array
        try { bytes = await fs.readFile(image) } catch { continue }
        const name = `image-${(await sourceSha256(bytes)).slice(0, 32)}.${extension}`
        relative = await writeImage(name, bytes)
        copied.set(image.href, relative)
      }
      resolved = relative + suffix
    }
    replacements.push({ start: prefix + start + destination.start, end: prefix + start + destination.end, text: resolved })
  }
  let result = text
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end)
  }
  return result
}
