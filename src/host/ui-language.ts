/**
 * Map the active DSH interface locale reported by the connected Client to the
 * reply-language line of every main-model notice. The line exists because the
 * plugin's own notices are composed in English while the user reads an
 * interface in their configured language; without it the main model answers in
 * the notice's language instead of the application's. Locales shipped by DSH
 * map to their names; any other locale id leaves the notice unchanged.
 */
export function uiLanguageDirective(locale: string | undefined): string | undefined {
  const primary = locale?.trim().toLowerCase().split(/[-_]/u)[0]
  if (primary === 'zh') return '请使用应用界面语言（简体中文）回复用户。'
  if (primary === 'en') return 'Reply to the user in the application interface language (English).'
  return undefined
}
