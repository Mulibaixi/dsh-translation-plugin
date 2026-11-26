import { foldKana } from '../shared/asset-classification.js'
import { IMAGE_MEMORY_MATCH_LIMIT } from '../shared/image-translation.js'

/**
 * Match established labels to the actual image transcription. Latin labels
 * require word boundaries. Japanese and Chinese can appear without spaces.
 */
export function imageMemoryMatcher(source: string): (form: string) => boolean {
  const text = foldKana(source.normalize('NFKC'))
  const word = /[\p{Script=Latin}\p{N}]/u
  return form => {
    const label = foldKana(form.trim().normalize('NFKC'))
    if (!label) return false
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(label)) return text.includes(label)
    for (let index = text.indexOf(label); index >= 0; index = text.indexOf(label, index + label.length)) {
      if (!word.test(text[index - 1] ?? '') && !word.test(text[index + label.length] ?? '')) return true
    }
    return false
  }
}

/** Keep the main-model handoff small; more entries remain accessible through normal lookups. */
export function compactMatches<T>(matches: readonly T[]): T[] {
  const selected: T[] = []
  const encoder = new TextEncoder()
  let remainingBytes = 4500
  for (const entry of matches) {
    const bytes = encoder.encode(JSON.stringify(entry)).byteLength + 1
    if (bytes > remainingBytes) continue
    selected.push(entry)
    remainingBytes -= bytes
    if (selected.length === IMAGE_MEMORY_MATCH_LIMIT) break
  }
  return selected
}
