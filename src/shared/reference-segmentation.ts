import { referenceExact, referenceInteger, referenceObject } from './reference-memory.js'

export interface ReferenceSegmentation { readonly version: number; readonly ends: readonly number[] }
export const REFERENCE_SEGMENT_LIMIT = 2000
export function parseReferenceSegmentation(value: unknown, total: number): ReferenceSegmentation {
  referenceObject(value); referenceExact(value, ['version', 'ends']); referenceInteger(value.version, 1)
  if (!Array.isArray(value.ends) || value.ends.length > 20000) throw new TypeError('Invalid reference segment boundaries')
  let previous = 0
  for (const end of value.ends) {
    referenceInteger(end, previous + 1)
    if (end > total || end - previous > REFERENCE_SEGMENT_LIMIT) throw new TypeError(`参考分段 ${previous}～${end} 超出正文或 ${REFERENCE_SEGMENT_LIMIT} 字符上限，请重新标记。`)
    previous = end
  }
  return { version: value.version, ends: [...value.ends] as number[] }
}
export function referenceSegmentationComplete(entry: { readonly source: { readonly totalCodePoints: number }; readonly segmentation?: ReferenceSegmentation }): boolean {
  return entry.source.totalCodePoints > 0 && entry.segmentation?.ends.at(-1) === entry.source.totalCodePoints
}
export const REFERENCE_SEGMENTATION_GUIDANCE = 'This is an original/bilingual reference indexing task, not a translation request. Process the complete intended file page by page through translation_reference_segmentation_read, following next. Read a little ahead before marking a boundary near a page edge; contextBefore preserves the previous page tail. Page ends are not semantic boundaries. Its anchors locate untouched source text; choose semantic boundaries and submit only endAnchors with translation_reference_segment. Keep each complete source/translation pair together; combine a few adjacent exchanges or one coherent idea, usually 200–600 Unicode characters. Keep necessary context for voice, pronouns and wordplay, and start new segments at explicit scene/chapter changes. Headings stay with their content. Meaning takes precedence over length; one longer pair can stand alone, up to 2000 characters. If rejected for length, reread that area and choose better boundaries; the program never silently splits it. Do not infer unsupported bilingual alignment, rewrite the original, emit a translated copy, or paste summaries/examples into style settings. Submit batches with mode append and the observed planVersion; mode replace starts a fresh plan only for requested resegmentation. Continue from coveredThrough after interruptions. Only complete coverage enables semantic indexing; ordinary file reading remains available. indexing=queued is not finished indexing; report actual progress rather than claiming semantic readiness. A stale/unknown write is reconciled by reading the current plan, not blindly repeating it.'
