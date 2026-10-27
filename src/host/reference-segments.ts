import { referenceBytes } from '../shared/reference-memory.js'
import { referenceSegmentationComplete, type ReferenceSegmentation } from '../shared/reference-segmentation.js'

export const REFERENCE_SEGMENTATION_VERSION = 'model-reference-boundaries-v1'
interface Anchor { readonly id: string; readonly start: number; readonly end: number }
/** These are positioning aids, never automatic embedding segments. */
export function referenceAnchors(text: string): readonly Anchor[] {
  const points = Array.from(text), anchors: Anchor[] = []
  let start = 0, line = 1
  while (start < points.length) {
    let end = start
    while (end < points.length && points[end] !== '\n') end++
    if (end < points.length) end++
    if (end - start <= 2000) anchors.push({ id: `L${line}`, start, end })
    else {
      let part = 1, from = start
      for (let at = start; at < end; at++) if (/[。！？!?]/u.test(points[at]!) || points[at] === '.' && /\s/u.test(points[at + 1] ?? '') || at + 1 - from >= 1000 || at === end - 1) {
        let to = at + 1
        while (to < end && to - from < 2000 && /[」』”’"')）\]]/u.test(points[to]!)) to++
        anchors.push({ id: `L${line}.S${part++}`, start: from, end: to }); from = to; at = to - 1
      }
    }
    start = end; line++
  }
  return anchors
}
export function referencePlanSummary(text: string, plan?: ReferenceSegmentation): { planVersion: number; segments: number; coveredThrough: string | null; complete: boolean } {
  const last = plan?.ends.at(-1), anchors = referenceAnchors(text)
  return { planVersion: plan?.version ?? 0, segments: plan?.ends.length ?? 0, coveredThrough: anchors.find(anchor => anchor.end === last)?.id ?? null,
    complete: referenceSegmentationComplete({ source: { totalCodePoints: Array.from(text).length }, ...(plan ? { segmentation: plan } : {}) }) }
}
export function referenceAnchorPage(text: string, plan: ReferenceSegmentation | undefined, after?: string): unknown {
  const anchors = referenceAnchors(text), points = Array.from(text), index = after === undefined ? 0 : anchors.findIndex(anchor => anchor.id === after) + 1
  if (after !== undefined && index === 0) throw new Error('读取定位点不存在，请使用上次返回的 next。')
  const rows: { anchor: string; text: string; segmentEnd: boolean }[] = [], ends = new Set(plan?.ends)
  let next = index
  for (; next < anchors.length && rows.length < 100; next++) {
    const anchor = anchors[next]!, row = { anchor: anchor.id, text: points.slice(anchor.start, anchor.end).join(''), segmentEnd: ends.has(anchor.end) }
    if (rows.length && (referenceBytes([...rows, row]) > 18000 || Array.from(rows.map(item => item.text).join('')).length + anchor.end - anchor.start > 4000)) break
    rows.push(row)
  }
  const pageStart = anchors[index]?.start ?? points.length
  return { ...referencePlanSummary(text, plan), contextBefore: points.slice(Math.max(0, pageStart - 300), pageStart).join(''), rows, next: next < anchors.length ? rows.at(-1)!.anchor : null }
}
export function referenceBoundaryEnds(text: string, endAnchors: readonly string[]): readonly number[] {
  const anchors = new Map(referenceAnchors(text).map(anchor => [anchor.id, anchor.end]))
  return endAnchors.map(id => { const end = anchors.get(id); if (end === undefined) throw new Error(`分段定位点 ${id} 不存在。`); return end })
}
export function segmentReferenceText(text: string, plan?: ReferenceSegmentation): readonly { start: number; end: number; text: string }[] {
  const points = Array.from(text)
  if (!referenceSegmentationComplete({ source: { totalCodePoints: points.length }, ...(plan ? { segmentation: plan } : {}) })) return []
  let start = 0
  return plan!.ends.map(end => { const row = { start, end, text: points.slice(start, end).join('') }; start = end; return row })
}
