/** Shared by the main-Agent instructions and explicit Translation UI actions. */
export const TRANSLATION_TASK_GUIDANCE = [
  'Translation task boundaries: follow the current explicit human request, including an action the user deliberately submits from the Translation UI, with its exact task and target. Earlier task instructions remain historical context; their forceful wording, unfinished status or available tools does not make them the current request.',
  'Applicable user requirements, terminology and style settings remain in force unless the user changes them; separating task execution intent does not discard these ongoing constraints or cancel other legitimate operations.',
  'When the user sets an ongoing translation preference, read applicable settings and use translation_upsert_setting within the stated scope. Keep one-off wording and corrections in the current task.',
  'At the end of any translation review, including a reread or local revision, look for genuinely new, source-supported assets with clear reuse value. Keep ordinary wording and forms of address for known entities in the translation. If there are candidates and the user has not ruled out proposals, call translation_load_tools with guide:"asset_proposals" before classifying and submitting them. With no candidates, deliver directly.',
  'Deliver translations and revisions in the translation Session. Briefly report the outcome and any issues in the main chat. Paste translated text there only for the scope the user explicitly requests. When discussing wording, quote only the necessary excerpt.',
  'Translation quotes ending with 出处 give the selected text and its recorded unit/version. Treat the quote as context for the user’s accompanying request. If you need more text, resolve the named open translation Session and verify the unit ID before reading the cited version. The currently selected Session is a candidate and may have changed since quoting.',
  'When the user moves to a new translation unit, treat remaining minor wording or polishing suggestions for earlier units as handled. Do not carry them as pending work, repeat them, ask for confirmation or reopen earlier units unless the user asks. Revisit an earlier sentence only when it is tightly coupled to the current sentence and materially affects its translation; explain only that dependency. Use current recorded translations, including manual edits; read the relevant unit when needed. This workflow default does not assert that edits were saved or change stored text. Keep ongoing user requirements, terminology and style, and fully review the current unit.',
  'For image translation, first understand the current user request, then use the numbered source to select relevant topic terms, names and context before calling the translation model. Review the recorded result against source and memory, correct actual errors in the same unit, and deliver that version in the translation Session. Use neutral phrasing for unknown speakers and work from the saved text.',
  'When the current request is clear, perform it without redundant confirmation. Do not replace source indexing with translation, or switch files, topics or Sessions because an older request appears more operative. A later explicit human message may change or cancel the action.',
  'If instructions conflict and the user has not clearly chosen the intended task or target, pause the conflicting work, describe the specific ambiguity and ask the user to choose. Never silently decide which task to execute, infer cancellation or continuation from a sidebar selection, or use a guessed priority to resolve a genuinely ambiguous request.',
  'Use tools already declared in the CURRENT schemas directly. Load a group only when a required tool is absent; never reload direct before an available translation_translate, and never invoke an undeclared tool from memory. Make narrowly scoped read-only identity/status checks when useful. Loading a tool or finding an accessible unit does not authorize a different task. Resume interrupted work only on a clear current request to do so. A stopped main-Agent turn is not proof that a background translation was cancelled; report actual operation status, never automatically retry it.',
].join('\n')

interface TaskAgent { readonly session: { readonly id: string; snapshotEvents?(): readonly unknown[] } }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

/** Read public log facts only; do not retract history or maintain a second task registry. */
export function translationTaskBoundary(agent: TaskAgent, action: string, target: Readonly<Record<string, unknown>>, compact: boolean | 'before_user' = false): string {
  const accompanyingMaterial = action === 'submitted_material'
  let interruption: string | undefined
  const events = agent.session.snapshotEvents?.()
  if (events) for (let i = events.length - 1; i >= 0; i--) {
    const event = object(events[i])
    if (event?.type !== 'turn/end') continue
    const data = object(event.data), reason = object(data?.reason), cause = object(reason?.reason)
    if (reason?.kind === 'aborted' && cause?.kind === 'user') {
      const turn = Number.isSafeInteger(data?.turn) ? ` ${data!.turn}` : ''
      interruption = `At submission of this action, the most recently settled main-Agent turn${turn} was interrupted by the user. Its historical instructions are not a pending request to resume. This does not establish that any background translation operation was cancelled; use its actual status if relevant.`
    }
    break
  }
  const scope = compact === 'before_user'
    ? 'CURRENT MATERIAL CONTEXT — this material accompanies the next user message. Read that entire message and use it and the applicable Session instructions to determine this turn\'s task. Translate by default only when they do not indicate a different action. Do not resume earlier work.'
    : compact
    ? accompanyingMaterial
      ? 'CURRENT MATERIAL CONTEXT — translate this submission by default. Follow any accompanying human instruction to learn, discuss or skip translation. Do not resume earlier work.'
      : action === 'review_image_batch'
        ? 'CURRENT EXPLICIT USER ACTION — review the translations of this exact image batch from the Translation UI.'
        : 'CURRENT EXPLICIT USER ACTION — translate this exact new submission from the Translation UI. Do not resume earlier work.'
    : accompanyingMaterial
      ? 'CURRENT MATERIAL CONTEXT — this material accompanies the current human message. Determine its intended use from that message; this context is not an additional explicit translation request. An instruction to learn, discuss or not translate this submission takes precedence over default material handling. If the intended task is genuinely unclear or conflicting, ask the user before acting.'
      : 'CURRENT EXPLICIT USER ACTION — submitted from the Translation UI. This is a new scoped request, not a runtime-context snapshot or an instruction to resume unrelated earlier work. Continuing this exact source plan is allowed when this action requests it.'
  const current = [scope, JSON.stringify({ action, target }), ...(interruption ? [interruption] : [])]
  if (compact) return current.join('\n')
  return [
    ...current,
    TRANSLATION_TASK_GUIDANCE,
    accompanyingMaterial
      ? 'The following workflow details describe handling of this exact material and do not override the accompanying human instruction:'
      : 'The following workflow details apply only to this current action and its exact target:',
  ].join('\n')
}
