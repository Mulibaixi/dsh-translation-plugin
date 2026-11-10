import { parseDirectProposalSubmission } from '../shared/direct-proposals.js'
import { ASSET_CLASSIFICATION_GUIDANCE } from '../shared/asset-classification.js'
import { diagnosticSpan, type DiagnosticContext } from './diagnostics.js'
import type { MainAgent, ToolExecution, TopicToolsService } from './topic-tools.js'

export function registerDirectProposalTool(topics: TopicToolsService, agent: MainAgent, define: (options: Record<string, unknown>) => unknown,
  register: (definition: unknown) => () => void, ctx: DiagnosticContext): () => void {
  const text = { type: 'string', required: true }, texts = { type: 'array', required: true, items: { type: 'string' } }
  const optionalText = { type: 'string' }, optionalTexts = { type: 'array', items: { type: 'string' } }
  return register(define({ name: 'translation_submit_proposals',
    description: 'After reviewing a file translation, submit reusable term/entity/fact/relation candidates for the exact completed revision. Copy target/revisionId from translation_translate; draftTerms are not saved memory. Use exact unique source quotes; the program computes ranges. ' + ASSET_CLASSIFICATION_GUIDANCE + ' One term means one concept and one actual rendering. Put person-to-person forms of address in relation descriptions and general style/honorific policy in other_memory. Incidental context-specific renderings can stay in examples instead of becoming terms. Use only fields of the selected kind. Minimal shapes (replace examples and quotes): term {kind:"term",candidateId:"t",sourceForms:["原語"],preferred:"译法",quotes:["unique source sentence"]}; entity {kind:"entity",candidateId:"e",name:"人物",quotes:["unique source sentence"]}; fact {kind:"fact",candidateId:"f",title:"事实标题",body:"事实内容",quotes:["unique source sentence"]}; relation {kind:"relation",candidateId:"r",sourceEntityCandidateId:"e",targetEntityCandidateId:"e2",relation:"同事",quotes:["unique source sentence"]}, with both entity candidates in this batch. Optional description/aliases/entityCandidateIds default to empty. Candidates go directly to four pending archives, never auto-adopted; active entries are preserved. Report returned count and skipped separately, not attempted or rejected items; repeated successful updates need not mean new entries. Submit [] if none. Stale source/revision submissions are rejected.',
    parameters: { target: { type: 'object', required: true, additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['unit'], required: true }, mainSessionId: text, translationSessionId: text, unitId: text, sourceVersion: { type: 'integer', required: true } } },
      revisionId: text, proposals: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true, enum: ['term', 'entity', 'fact', 'relation'] }, candidateId: text,
        quotes: { ...texts, description: 'Exact unique source excerpts; reuse is allowed across different candidates.' },
        sourceForms: { ...optionalTexts, description: 'term only, required: equivalent forms of one concept.' },
        preferred: { ...optionalText, description: 'term only, required: one actual target rendering.' },
        name: { ...optionalText, description: 'entity only, required.' }, aliases: optionalTexts, description: optionalText,
        title: { ...optionalText, description: 'fact only, required; do not use description as a substitute.' },
        body: { ...optionalText, description: 'fact only, required: the factual content.' }, entityCandidateIds: optionalTexts,
        sourceEntityCandidateId: { ...optionalText, description: 'relation only, required: entity candidateId in this batch.' },
        targetEntityCandidateId: { ...optionalText, description: 'relation only, required: entity candidateId in this batch.' }, relation: optionalText,
      } } } },
    output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (raw: unknown, exec: ToolExecution) => {
      if (exec.agent !== agent || !topics.ownsAgent(agent.id, agent)) throw Object.assign(new Error('提案操作不属于已连接的主 Agent。'), { code: 'scope_mismatch' })
      const request = parseDirectProposalSubmission(raw)
      if (request.target.mainSessionId !== agent.id) throw new Error('提案不属于此主会话。')
      const report = diagnosticSpan(ctx, 'memory.proposals', { candidates: request.proposals.length }, exec.callId)
      try {
        const value = await topics.requestOwned(agent.id, { kind: 'direct_proposals', request }, exec)
        if (value.kind !== 'direct_proposals') throw new Error('提案保存回执类型不一致。')
        report('completed', { count: value.receipt.count, persistence: value.receipt.persistence })
        return { count: value.receipt.count, skipped: value.receipt.skipped }
      } catch (error) { report(exec.signal.aborted ? 'cancelled' : 'failed', {}, error); throw error }
    },
  }))
}
