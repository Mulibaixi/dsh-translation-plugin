import { referenceExact, referenceInteger, referenceObject, referenceString } from '../shared/reference-memory.js'
import { REFERENCE_SEGMENTATION_GUIDANCE } from '../shared/reference-segmentation.js'
import { referenceAnchorPage, referenceBoundaryEnds, referencePlanSummary } from './reference-segments.js'
import { diagnosticSpan } from './diagnostics.js'
import type { OtherMemoryService } from './other-memory.js'
import type { OtherMemoryFilesService } from './other-memory-files.js'
import type { MemorySearchService } from './memory-search.js'
import type { MainAgent, TopicHostContext, TopicToolsService, ToolExecution } from './topic-tools.js'

export function registerReferenceSegmentationTools(ctx: TopicHostContext, memory: OtherMemoryService, files: OtherMemoryFilesService, topics: TopicToolsService, agent: MainAgent,
  define: (options: Record<string, unknown>) => unknown, register: (definition: unknown) => () => void): readonly (() => void)[] {
  const text = { type: 'string', required: true }, integer = { type: 'integer', required: true }, identity = { topicId: text, id: text, version: integer }
  return ['read', 'write'].map(action => register(define({
    name: action === 'read' ? 'translation_reference_segmentation_read' : 'translation_reference_segment',
    description: (action === 'read' ? 'Read one page of original file text with stable line/sentence end anchors and the current segmentation progress. Omit after to start; follow next for full reading. Existing segmentEnd flags identify current boundaries. No model or embedding call. '
      : 'Mark boundaries in an existing original/bilingual file; never send rewritten text or numeric offsets. Submit endAnchors in increasing order, mode append to continue or replace to start a requested replacement. expectedPlanVersion comes from the latest read/write receipt. No automatic splitting or partial-file embedding. A complete valid plan automatically queues indexing when an embedding service is configured. ') + REFERENCE_SEGMENTATION_GUIDANCE,
    parameters: action === 'read' ? { ...identity, after: { type: 'string' } } : { ...identity, expectedPlanVersion: { type: 'integer', required: true },
      mode: { type: 'string', enum: ['append', 'replace'], required: true }, endAnchors: { type: 'array', items: { type: 'string' }, required: true } },
    output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (raw: unknown, exec: ToolExecution) => {
      const check = (): string => {
        exec.signal.throwIfAborted()
        const peer = topics.ownerPeer(agent.id, agent)
        if (exec.agent !== agent || !peer) throw new Error('参考文件分段不属于此主会话连接。')
        return peer
      }
      check(); referenceObject(raw)
      referenceExact(raw, action === 'read' ? ['topicId', 'id', 'version'] : ['topicId', 'id', 'version', 'expectedPlanVersion', 'mode', 'endAnchors'], action === 'read' ? ['after'] : [])
      referenceString(raw.topicId); referenceString(raw.id); referenceInteger(raw.version, 1)
      if (raw.after !== undefined) referenceString(raw.after, 64)
      const scope = await topics.requestOwned(agent.id, { kind: 'settings_scope', topicId: raw.topicId as string }, exec)
      if (scope.kind !== 'settings_scope' || scope.scope.topicId !== raw.topicId || scope.scope.namespaceId !== topics.namespaceForAgent(agent.id)) throw new Error('参考文件分段范围回执无效。')
      const request = { ...scope.scope, topicId: raw.topicId as string, id: raw.id as string, version: raw.version as number }
      const original = await files.readText(request, check(), exec.signal)
      check()
      const identityResult = { id: original.entry.id, version: original.entry.version, name: original.entry.source.name, totalCodePoints: original.entry.source.totalCodePoints }
      if (action === 'read') return { file: identityResult, ...referenceAnchorPage(original.text, original.entry.segmentation, raw.after as string | undefined) as object }
      referenceInteger(raw.expectedPlanVersion)
      if (!['append', 'replace'].includes(String(raw.mode)) || !Array.isArray(raw.endAnchors) || !raw.endAnchors.length || raw.endAnchors.length > 512) throw new Error('每批须提交 1～512 个递增分段定位点。')
      for (const anchor of raw.endAnchors) referenceString(anchor, 64)
      const report = diagnosticSpan(ctx, 'memory.segmentation', { action: raw.mode as string }, exec.callId)
      try {
        const ends = referenceBoundaryEnds(original.text, raw.endAnchors as string[])
        const oldEnds = raw.mode === 'append' ? original.entry.segmentation?.ends ?? [] : []
        const allEnds = [...oldEnds, ...ends], points = Array.from(original.text)
        let previous = 0
        for (const end of allEnds) { if (!points.slice(previous, end).join('').trim()) throw new Error('分段包含空白片段或重复／倒序边界，请重新标记。'); previous = end }
        const saved = await memory.putReferenceSegmentation({ ...request, expectedPlanVersion: raw.expectedPlanVersion as number, mode: raw.mode as 'append' | 'replace', ends }, check(), () => { check() })
        const summary = referencePlanSummary(original.text, saved.segmentation)
        let indexing = 'waiting_for_complete', reason: string | undefined
        if (summary.complete) {
          try {
            const search = ctx.get?.('translationMemorySearch') as MemorySearchService | undefined
            if (!search) throw new Error('语义索引服务尚未就绪。')
            await search.buildForPeer({ namespaceId: request.namespaceId, rebuild: false }, check()); indexing = 'queued'
          } catch (error) { indexing = 'unavailable'; reason = (error as Error).message }
        }
        report('completed', { segments: summary.segments, complete: summary.complete, persistence: saved.persistence, indexing })
        return { file: identityResult, ...summary, persistence: saved.persistence, indexing, ...(reason ? { reason } : {}) }
      } catch (error) { report(exec.signal.aborted ? 'cancelled' : 'failed', {}, error); throw error }
    },
  })))
}
