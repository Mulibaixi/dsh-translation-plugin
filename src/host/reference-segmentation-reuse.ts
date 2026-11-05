import { parseReferenceSegmentation, REFERENCE_SEGMENT_LIMIT, type ReferenceSegmentation } from '../shared/reference-segmentation.js'
import { parseSourceIdentity, type SourceIdentity } from '../shared/translation-sources.js'
import { referenceExact, referenceObject } from '../shared/reference-memory.js'

export interface ReferenceFilePlan { readonly source: SourceIdentity; readonly segmentation: ReferenceSegmentation }
export function parseReferenceFilePlan(value: unknown): ReferenceFilePlan {
  referenceObject(value); referenceExact(value, ['source', 'segmentation'])
  const source = parseSourceIdentity(value.source)
  return { source, segmentation: parseReferenceSegmentation(value.segmentation, source.totalCodePoints) }
}
class AlignmentError extends Error {
  readonly code = 'reference_alignment_failed'
  constructor(boundary: number, reason: string) { super(`文件更新在原文位置 ${boundary} 附近${reason}，原文件与分段已保留；可处理这一局部后重试。`) }
}
interface Text { readonly points: readonly string[]; readonly offsets: readonly number[]; readonly length: number }
/** Ignore CRLF spelling and an initial BOM only for alignment; output coordinates still belong to the exact original. */
function text(value: string): Text {
  const raw = Array.from(value), points: string[] = [], offsets: number[] = [raw[0] === '\ufeff' ? 1 : 0]
  for (let i = offsets[0]!; i < raw.length; i++) {
    if (raw[i] === '\r' && raw[i + 1] === '\n') i++
    points.push(raw[i]!); offsets.push(i + 1)
  }
  return { points, offsets, length: raw.length }
}
function position(offsets: readonly number[], value: number): number {
  let left = 0, right = offsets.length - 1
  while (left <= right) { const mid = (left + right) >>> 1, current = offsets[mid]!; if (current === value) return mid; if (current < value) left = mid + 1; else right = mid - 1 }
  throw new AlignmentError(value, '的边界位于换行内部，无法准确迁移')
}
interface Line { readonly start: number; readonly end: number }
function lines(points: readonly string[], start: number, end: number): Map<string, Line | null> {
  const result = new Map<string, Line | null>()
  for (let from = start; from < end;) {
    let to = from
    while (to < end && points[to] !== '\n') to++
    if (to < end) to++
    const value = points.slice(from, to).join('')
    if (value.trim()) result.set(value, result.has(value) ? null : { start: from, end: to })
    from = to
  }
  return result
}
interface Occurrence { count: number; start: number }
/** Scan each requested window width once; never search the entire file separately for every boundary. */
function occurrences(points: readonly string[], start: number, end: number, queries: ReadonlyMap<number, ReadonlySet<string>>): Map<string, Occurrence> {
  const found = new Map<string, Occurrence>()
  for (const [width, wanted] of queries) for (let at = start; at + width <= end; at++) {
    const value = points.slice(at, at + width).join('')
    if (!wanted.has(value)) continue
    const prior = found.get(value)
    if (prior) prior.count = 2
    else found.set(value, { count: 1, start: at })
  }
  return found
}

/** Move existing logical boundaries through edits. No model calls, similarity threshold or semantic resegmentation. */
export function remapReferenceSegmentation(before: string, after: string, plan: ReferenceSegmentation): ReferenceSegmentation {
  const old = text(before), next = text(after)
  parseReferenceSegmentation(plan, old.length)
  if (!after.trim()) throw new AlignmentError(0, '没有可采用的正文')
  const complete = plan.ends.at(-1) === old.length
  const targets = plan.ends.map(end => position(old.offsets, end)), mapped = new Map<number, number>()
  function fail(boundary: number, reason: string): never { throw new AlignmentError(old.offsets[boundary] ?? boundary, reason) }
  const align = (a0: number, a1: number, b0: number, b1: number, boundaries: readonly number[]): void => {
    if (!boundaries.length) return
    let a = a0, b = b0, endA = a1, endB = b1
    while (a < endA && b < endB && old.points[a] === next.points[b]) { a++; b++ }
    if (a === a1 && b === b1) { for (const boundary of boundaries) mapped.set(boundary, b0 + boundary - a0); return }
    // Whole unchanged lines take precedence over coincidental matching characters in a deleted line.
    const oldLines = lines(old.points, a0, a1), newLines = lines(next.points, b0, b1)
    const anchors: { old: Line; next: Line }[] = []
    let previous = b0 - 1
    for (const [value, line] of oldLines) {
      const match = newLines.get(value)
      if (!line || !match) continue
      if (match.start <= previous) fail(boundaries[0]!, '出现段落顺序变化，无法唯一对齐')
      anchors.push({ old: line, next: match }); previous = match.end - 1
    }
    if (anchors.length) {
      let fromA = a0, fromB = b0, index = 0
      const part = (toA: number, toB: number): void => {
        const from = index
        while (index < boundaries.length && boundaries[index]! <= toA) index++
        if (index > from) align(fromA, toA, fromB, toB, boundaries.slice(from, index))
        fromA = toA; fromB = toB
      }
      for (const anchor of anchors) { part(anchor.old.start, anchor.next.start); part(anchor.old.end, anchor.next.end) }
      part(a1, b1)
      return
    }
    while (endA > a && endB > b && old.points[endA - 1] === next.points[endB - 1]) { endA--; endB-- }
    const pending: number[] = []
    for (const boundary of boundaries) {
      if (boundary <= a) mapped.set(boundary, b0 + boundary - a0)
      else if (boundary >= endA) mapped.set(boundary, endB + boundary - endA)
      else if (b === endB) mapped.set(boundary, b)
      else pending.push(boundary)
    }
    if (!pending.length) return
    const queries = new Map<number, Set<string>>()
    const contexts = pending.map(boundary => {
      const sides: { left: string; right: string }[] = []
      for (const width of [16, 8, 4, 1]) {
        const left = old.points.slice(Math.max(a, boundary - width), boundary).join('')
        const right = old.points.slice(boundary, Math.min(endA, boundary + width)).join('')
        for (const value of [left, right]) if (value) { const size = Array.from(value).length; let set = queries.get(size); if (!set) { set = new Set(); queries.set(size, set) }; set.add(value) }
        sides.push({ left, right })
      }
      return { boundary, sides }
    })
    const source = occurrences(old.points, a, endA, queries), destination = occurrences(next.points, b, endB, queries)
    for (const { boundary, sides } of contexts) {
      let left: number | undefined, right: number | undefined
      for (const side of sides) {
        const locate = (value: string): number | undefined => source.get(value)?.count === 1 && destination.get(value)?.count === 1 ? destination.get(value)!.start : undefined
        const leftStart = locate(side.left)
        left ??= leftStart === undefined ? undefined : leftStart + Array.from(side.left).length
        right ??= locate(side.right)
      }
      if (left !== undefined && right !== undefined && left > right) fail(boundary, '的前后文顺序不一致')
      const result = left ?? right
      if (result === undefined) fail(boundary, '缺少唯一对应的边界前后文')
      mapped.set(boundary, result)
    }
  }
  align(0, old.points.length, 0, next.points.length, complete ? targets.slice(0, -1) : targets)
  // A completed old EOF extends with appended text; an incomplete plan retains its unprocessed tail.
  if (complete) mapped.set(targets.at(-1)!, next.points.length)
  const ends: number[] = [], rawNext = Array.from(after)
  let previous = 0
  for (const boundary of targets) {
    const at = mapped.get(boundary)
    if (at === undefined || at < 0 || at > next.points.length) fail(boundary, '未能定位旧边界')
    const end = next.offsets[at]!
    if (end < previous) fail(boundary, '的边界对应顺序不一致')
    if (end === previous || !rawNext.slice(previous, end).join('').trim()) continue
    ends.push(end); previous = end
  }
  if (complete && ends.length) ends[ends.length - 1] = next.length
  previous = 0
  for (const end of ends) {
    if (end - previous > REFERENCE_SEGMENT_LIMIT) throw new AlignmentError(end, `的迁移段超过 ${REFERENCE_SEGMENT_LIMIT} 码点上限`)
    previous = end
  }
  return parseReferenceSegmentation({ version: plan.version + (before === after ? 0 : 1), ends }, next.length)
}
