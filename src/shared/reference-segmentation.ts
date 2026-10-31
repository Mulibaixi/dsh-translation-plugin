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
export const REFERENCE_SEGMENTATION_RULES = 'Keep each complete source/translation pair together; combine a few adjacent exchanges or one coherent idea, usually 200–600 Unicode characters. Keep necessary context for voice, pronouns and wordplay, and start new segments at explicit scene/chapter changes. Headings stay with their content. Meaning takes precedence over length; one longer pair can stand alone, up to 2000 characters. Do not infer unsupported bilingual alignment, rewrite the original, emit a translated copy, or paste summaries/examples into style settings. Positioning anchors locate untouched text; line/page ends are not automatically semantic boundaries.'
export const REFERENCE_SEGMENTATION_GUIDANCE = `This is an original/bilingual reference indexing task, not a translation request. Call translation_reference_segment_prepare for two independent full-file native annotations and parallel cross-reviews. Every child receives the ENTIRE original in a fresh context; do not manually loop through pages or split the task into separate ranges. Then inspect substantive unresolved issues with translation_reference_segmentation_read using proposalId (follow next for the required context); different valid boundaries do not require convergence. Choose one coherent candidate, resolve actual errors, and call translation_reference_segment_commit once to save the complete plan. Candidates alone are not saved plans. Existing completed plans are preserved unless the user requested resegmentation; pass resegment:true only then. A retry reuses completed candidates when still available; unknown writes must be reconciled by reading the current plan. ${REFERENCE_SEGMENTATION_RULES} Ordinary reading and manual boundary tools remain available for inspection and explicit corrections. Only complete coverage enables semantic indexing; ordinary file reading remains available. indexing=queued is not finished indexing; report actual progress rather than claiming semantic readiness.`
