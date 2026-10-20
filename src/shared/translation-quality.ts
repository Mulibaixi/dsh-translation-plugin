/**
 * A glossary must not leak into the body: the classic symptom is "译名（原文）". Parentheses that the
 * source already contains are content and may be kept, translated or dropped as the text requires, so
 * they are never reported on their own. Checks only report; they never rewrite the body.
 */
export interface TranslationCheck {
  readonly code: 'term_annotation' | 'source_annotation'
  /** The parenthetical content found in the translation. */
  readonly annotation: string
  readonly hint: string
}
const KANA = /[\u3040-\u309f\u30a0-\u30ff]/u
const HAN = /[\u3400-\u9fff]/u
const PARENTHETICAL = /[（(]([^（）()]{1,40})[)）]/gu
const inner = (value: string): readonly string[] => [...value.matchAll(PARENTHETICAL)].flatMap(match => {
  const text = match[1]?.trim()
  return text ? [text] : []
})
/**
 * Three narrow signals, all requiring that source_text has no such parenthesis at all:
 * the gloss repeats a cited term's source form, it still holds kana, or it repeats a source phrase of
 * four or more characters verbatim. Short identical words such as （重要） are left alone.
 */
export function sourceAnnotationChecks(text: string, terms: readonly { readonly preferred: string; readonly sourceForms: readonly string[] }[] = [],
  source = ''): readonly TranslationCheck[] {
  const found: TranslationCheck[] = [], original = new Set(inner(source))
  const add = (check: TranslationCheck): void => {
    if (found.length >= 5 || found.some(item => item.annotation === check.annotation)) return
    found.push(check)
  }
  for (const value of inner(text)) {
    if (original.has(value)) continue
    const term = terms.find(item => item.sourceForms.some(form => form === value))
    if (term) { add({ code: 'term_annotation', annotation: value, hint: `“${term.preferred}”的原文被附加在译名后：术语只决定用词` }); continue }
    if (KANA.test(value)) { add({ code: 'source_annotation', annotation: value, hint: '括号内仍是原文假名，且原文此处没有该括注；如非有意保留可译出' }); continue }
    const han = [...value].filter(character => HAN.test(character)).length
    if (value.length >= 4 && han >= 2 && !/\d/u.test(value) && source.includes(value)) {
      add({ code: 'source_annotation', annotation: value, hint: '括号内是与原文逐字相同的片段，且原文此处没有该括注；如非有意保留可译出' })
    }
  }
  return found
}
