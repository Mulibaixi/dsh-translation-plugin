export interface ExactTextEdit {
  readonly from: string
  readonly to: string
}

export interface LineTextEdit {
  readonly line: number
  readonly to: string
}

/** Text at even indexes, original separators at odd indexes. A terminal separator does not add a line. */
export function splitResultLines(text: string): string[] {
  const parts = text.split(/(\r\n|[\r\n])/)
  if (parts.length > 1 && parts.at(-1) === '') parts.pop()
  return parts
}

type TextEditResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: string; readonly message: string }
export type ResultTextEdits = readonly ExactTextEdit[] | readonly LineTextEdit[]

function areLineTextEdits(edits: ResultTextEdits): edits is readonly LineTextEdit[] {
  return edits[0] !== undefined && 'line' in edits[0]
}

export function applyResultTextEdits(base: string, edits: ResultTextEdits): TextEditResult {
  return areLineTextEdits(edits) ? applyLineTextEdits(base, edits) : applyExactTextEdits(base, edits)
}

function applyLineTextEdits(base: string, edits: readonly LineTextEdit[]): TextEditResult {
  const parts = splitResultLines(base)
  const edited = new Set<number>()
  for (const { line, to } of edits) {
    const index = (line - 1) * 2
    if (index < 0 || index >= parts.length) return { ok: false, code: 'line_out_of_bounds', message: `第 ${line} 行超出基准译文范围；请按行回读准确版本。` }
    if (edited.has(line)) return { ok: false, code: 'duplicate_line', message: `第 ${line} 行重复修改；请为同一行提供一条修改。` }
    if (parts[index] === to) return { ok: false, code: 'edit_no_change', message: `第 ${line} 行的替换内容没有变化。` }
    edited.add(line)
    parts[index] = to
  }
  return { ok: true, text: parts.join('') }
}

/** Locate every edit in the same base, then copy untouched text verbatim. */
export function applyExactTextEdits(base: string, edits: readonly ExactTextEdit[]): TextEditResult {
  if (!edits.length) return { ok: false, code: 'edit_empty', message: '至少需要一条精确修改。' }
  const spans: { start: number; end: number; replacement: string }[] = []
  for (const [index, edit] of edits.entries()) {
    if (!edit.from) return { ok: false, code: 'edit_empty', message: `第 ${index + 1} 条修改的原片段为空。` }
    const start = base.indexOf(edit.from)
    if (start < 0) return { ok: false, code: 'edit_no_match', message: `第 ${index + 1} 条修改的原片段在基准正文中不存在；请提供更准确的上下文。` }
    if (base.indexOf(edit.from, start + 1) >= 0) return { ok: false, code: 'edit_ambiguous', message: `第 ${index + 1} 条修改的原片段在基准正文中命中多处；请提供足够上下文使其唯一。` }
    spans.push({ start, end: start + edit.from.length, replacement: edit.to })
  }
  spans.sort((left, right) => left.start - right.start)
  let end = 0
  const parts: string[] = []
  for (const span of spans) {
    if (span.start < end) return { ok: false, code: 'edit_overlap', message: '多条修改的定位范围重叠；请分别给出互不重叠的替换。' }
    parts.push(base.slice(end, span.start), span.replacement)
    end = span.end
  }
  parts.push(base.slice(end))
  return { ok: true, text: parts.join('') }
}
