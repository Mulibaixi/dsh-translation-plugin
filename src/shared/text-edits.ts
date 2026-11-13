export interface ExactTextEdit {
  readonly from: string
  readonly to: string
}

/** Locate every edit in the same base, then copy untouched text verbatim. */
export function applyExactTextEdits(base: string, edits: readonly ExactTextEdit[]): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: string; readonly message: string } {
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
