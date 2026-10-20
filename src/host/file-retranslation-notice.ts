import type { NormalTranslationUnitRequest } from '../shared/normal-translation.js'
import { TRANSLATION_PRIORITY } from '../memory/asset-priority.js'
/** Both historical document units and file jobs use this executable handoff. */
export function fileRetranslationNotice(request: NormalTranslationUnitRequest): string {
  return [
    'The user explicitly requests retranslation of this exact saved file unit and sourceVersion. This is intent only; no translation has been accepted yet.',
    TRANSLATION_PRIORITY,
    'Load file_jobs with translation_load_tools if needed. Call translation_file_retranslate with the exact target and operationId below, plus mandatory organizedRequirements consolidating the current user chat requirements and corrections with the file requirements. That tool restores the saved source into the current connection and starts the file workflow. Do not replay any old material requestId, call the legacy file-start tool with an old notification, or recreate the legacy analysis/prepare/plan workflow. Never ask the user to copy internal material JSON.',
    'Read metadata with translation_file_list and source pages with translation_read_source only if needed. Preserve the exact requested file even if a different file was discussed earlier. An unknown/unsettled prior call must be resolved before another attempt. This explicit user request needs no further confirmation.',
    JSON.stringify({ target: request.target, operationId: request.operationId }),
  ].join('\n')
}
