/**
 * Session target languages are free display names ("中文", "日语") while memory terms store BCP-47
 * tags ("zh-Hans", "ja"). Comparing them by string equality rejected every term a model cited from
 * the topic snapshot, so both sides are reduced to one coarse key here.
 */
const LABELS: Readonly<Record<string, string>> = {
  english: 'en', chinese: 'zh-hans', 'simplified chinese': 'zh-hans', 'traditional chinese': 'zh-hant',
  '中文': 'zh-hans', '汉语': 'zh-hans', '漢語': 'zh-hans', '简体中文': 'zh-hans', '简体': 'zh-hans',
  '繁体中文': 'zh-hant', '繁體中文': 'zh-hant', '繁体': 'zh-hant', '繁體': 'zh-hant',
  '日语': 'ja', '日文': 'ja', '日本語': 'ja', '英语': 'en', '英文': 'en', '英語': 'en',
  '韩语': 'ko', '韩文': 'ko', '한국어': 'ko', '法语': 'fr', '法文': 'fr', '德语': 'de', '德文': 'de',
  '西班牙语': 'es', '俄语': 'ru', '葡萄牙语': 'pt',
}
const TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{1,8})*$/u
/** Coarse language identity: enough to reject a real mismatch, never a spelling variant. */
export function languageKey(value: string | null | undefined): string | undefined {
  const text = (value ?? '').trim(), lower = text.toLowerCase()
  const tag = TAG.test(lower) ? lower.replace(/_/gu, '-') : LABELS[text] ?? LABELS[lower]
  if (!tag) return undefined
  const [base] = tag.split('-')
  if (base === 'zh') return /^zh-(?:hant|tw|hk|mo)/u.test(tag) ? 'zh-hant' : 'zh-hans'
  return base
}
/** Exact search: equal text, or two recognized names of one language. Unknown names never match. */
export function languageMatches(left: string | null | undefined, right: string | null | undefined): boolean {
  if ((left ?? '') === (right ?? '')) return true
  const a = languageKey(left), b = languageKey(right)
  return a !== undefined && a === b
}
