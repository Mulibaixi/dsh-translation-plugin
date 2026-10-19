import type { FileJobTextEdit } from './file-jobs.js'

function invalid(code: string, message: string): never { throw Object.assign(new Error(message), { code, stage: 'apply_file_edits' }) }
/** Resolve every edit against the same original body before applying anything. */
export function applyFileJobEdits(body: string, edits: readonly FileJobTextEdit[]): string {
  const original = Array.from(body), resolved: { start: number; end: number; text: string }[] = []
  for (const edit of edits) {
    if (!edit.expectedText) invalid('edit_text_required', '修订必须提供准确且非空的 expectedText。')
    const first = resolved.length
    if (edit.range) resolved.push({ ...edit.range, text: edit.text })
    else {
      let cursor = 0, pointCursor = 0
      const matches: { start: number; end: number; text: string }[] = [], length = Array.from(edit.expectedText).length
      for (;;) {
        const index = body.indexOf(edit.expectedText, cursor)
        if (index < 0) break
        pointCursor += Array.from(body.slice(cursor, index)).length
        matches.push({ start: pointCursor, end: pointCursor + length, text: edit.text })
        cursor = index + edit.expectedText.length; pointCursor += length
      }
      if (!matches.length) invalid('edit_text_mismatch', '当前译文中未找到修订原文，未修改任何内容。请重读准确版本。')
      if (matches.length > 1 && !edit.replaceAll) invalid('ambiguous_edit', '修订原文出现多次，请提供更完整的唯一上下文，或明确 replaceAll=true。未修改任何内容。')
      for (const match of matches) resolved.push(match)
    }
    for (const match of resolved.slice(first)) if (match.start < 0 || match.end > original.length || match.end <= match.start || original.slice(match.start, match.end).join('') !== edit.expectedText) {
      invalid('edit_text_mismatch', '修订范围内的原文与 expectedText 不符，未修改任何内容。位置按 Unicode 码点计算，不能使用字节偏移。')
    }
  }
  resolved.sort((left, right) => left.start - right.start)
  if (resolved.some((edit, index) => index > 0 && edit.start < resolved[index - 1]!.end)) invalid('overlapping_edits', '修订范围互相重叠，未修改任何内容。')
  const chunks: string[] = []; let position = 0
  for (const edit of resolved) { chunks.push(original.slice(position, edit.start).join(''), edit.text); position = edit.end }
  chunks.push(original.slice(position).join(''))
  return chunks.join('')
}
