import type { NormalTranslationUnitRequest } from '../shared/normal-translation.js'
/** Kept only to explain an old queued intent; it must not start another legacy job. */
export function fileRetranslationNotice(request: NormalTranslationUnitRequest): string {
  return ['This legacy file/document execution path is retired. No new translation was accepted. Tell the user to resend the original using the current file input; preserve existing history. Do not start or reconstruct a legacy workflow.', JSON.stringify({ target: request.target, operationId: request.operationId })].join('\n')
}
