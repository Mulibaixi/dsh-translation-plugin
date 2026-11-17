import type { NormalTranslationMaterialTarget } from '../shared/normal-translation.js'

const SPLIT_QUESTION_ID = 'pdf_split'
const SPLIT_OPTIONS = ['同意分批（推荐）', 'Process in sections (Recommended)']
export const PDF_SPLIT_QUESTION_GUIDANCE = 'If using ask_user_question, set the question id to pdf_split and use 同意分批（推荐） or Process in sections (Recommended) for proceeding. The recorded selection is enough. For a free-text approval pass the human wording in userDecision.'

type Data = Record<string, unknown>
function object(value: unknown): Data | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : undefined }
function json(text: string): Data | undefined { try { return object(JSON.parse(text)) } catch { return undefined } }
function messageText(message: Data | undefined): string {
  return Array.isArray(message?.content)
    ? message.content.map(object).filter(part => part?.type === 'text').map(part => part?.text).join('\n').trim()
    : ''
}

/** Match native answers to the logged question for this material, including answers from before a resume. */
export function hasPdfUserDecision(events: readonly unknown[], target: NormalTranslationMaterialTarget, decision: string): boolean {
  const repliesByCall = new Map<string, Data | undefined>()
  let plainReply = false, modalReply: boolean | undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const event = object(events[index]), data = object(event?.data)
    if (event?.type === 'user/message') {
      const source = object(data?.source)
      if (source?.kind === 'translation-material') {
        if (source.materialId !== target.materialId || source.sourceVersion !== target.sourceVersion) return false
        if (plainReply || modalReply !== undefined) return plainReply || modalReply === true
      }
      if (source?.kind === 'user' && modalReply === undefined && decision && messageText(data) === decision) {
        if (source.rpcId === target.requestId) return true
        plainReply = true
      }
      if (source?.kind === 'user-question-reply' && typeof source.callId === 'string' && !repliesByCall.has(source.callId)) {
        repliesByCall.set(source.callId, source.outcome === 'answered' ? data : undefined)
      }
    } else if (event?.type === 'tool/result') {
      const message = object(data?.message), callId = message?.toolCallId
      if (typeof callId === 'string' && object(message?.source)?.kind === 'tool' && !repliesByCall.has(callId)) {
        repliesByCall.set(callId, data?.error === undefined && message?.isError !== true ? message : undefined)
      }
    } else if (event?.type === 'tool/call' && modalReply === undefined && data?.name === 'ask_user_question' && typeof data.callId === 'string') {
      const reply = repliesByCall.get(data.callId)
      if (!reply || typeof data.arguments !== 'string') continue
      const questions = json(data.arguments)?.questions
      if (!Array.isArray(questions)) continue
      const question = questions.map(object).find(item => item?.id === SPLIT_QUESTION_ID || item?.id === 'split')
      if (!question || !Array.isArray(question.options)) continue
      const approval = question.options.map(object).find(option => typeof option?.label === 'string' && SPLIT_OPTIONS.includes(option.label))?.label
      if (typeof approval !== 'string') continue
      const answers = json(messageText(reply))?.answers
      if (!Array.isArray(answers)) continue
      const answer = answers.map(object).find(item => item?.id === question.id)
      const selected = answer?.selected
      if (Array.isArray(selected)) {
        modalReply = selected.length === 1 && selected[0] === approval ||
          selected.length === 0 && !!decision && typeof answer?.custom === 'string' && answer.custom.trim() === decision
      }
    }
  }
  return false
}
