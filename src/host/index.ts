import { LocalDataService } from './local-data.js'
import { ReferenceFilesService } from './reference-files.js'
import { createTranslationFramework } from './framework.js'
import { installQuickTranslation, type QuickHostContext } from './quick-translation.js'
import { installTopicTools, type TopicHostContext } from './topic-tools.js'
import { PLUGIN_REMOTE } from '../shared/plugin-remote.js'
import { installObjectAssets } from './object-assets.js'
import { installTranslationMaterials, type TranslationMaterialHostContext } from './translation-materials.js'
import { installNormalTranslation } from './normal-translation.js'
import { installTranslationSources } from './translation-sources.js'
import { TerminologyAnalysisService } from './terminology-analysis.js'
import { installTranslationPreparation } from './translation-preparation.js'
import { installDocumentPlanning } from './document-planning-service.js'
import { installDocumentExecution } from './document-execution-service.js'
import { installDocumentCorrection } from './document-correction-service.js'
import { installDocumentReview } from './document-review-service.js'
import type { AnalysisNotification, AnalysisRun } from '../shared/translation-preparation.js'
import type { TaskPhaseEvent, TranslationExchangeService } from 'dsh-composer-extension/contracts'

export { createTranslationFramework } from './framework.js'
export { TextTranslationRuntime } from './text-runtime.js'
export { QuickTranslationService, installQuickTranslation } from './quick-translation.js'
export { DshTextExecutionAdapter } from './dsh-text-adapter.js'
export { TopicToolsService, installTopicTools } from './topic-tools.js'
export { ObjectAssetsService, installObjectAssets } from './object-assets.js'
export { TranslationMaterialsService, installTranslationMaterials } from './translation-materials.js'
export { NormalTranslationService, installNormalTranslation } from './normal-translation.js'
export { TranslationSourcesService, installTranslationSources } from './translation-sources.js'
export { loadTranslationSourceStorage } from './source-storage.js'
export { TerminologyAnalysisService } from './terminology-analysis.js'
export { TranslationPreparationService, installTranslationPreparation } from './translation-preparation.js'
export { DocumentPlanningService, installDocumentPlanning } from './document-planning-service.js'
export { DocumentPlanner } from './document-planner.js'
export { DocumentExecutionService, installDocumentExecution } from './document-execution-service.js'
export { DocumentReviewService, installDocumentReview } from './document-review-service.js'
export type * from '../shared/document-execution.js'
export type * from '../shared/document-planning.js'
export type * from '../shared/translation-preparation.js'
export type * from './source-storage.js'
export type { SourceIdentity } from '../shared/translation-sources.js'
export type * from '../shared/translation-source-storage.js'
export type * from '../shared/domain-contracts.js'

export const name = 'deepseek-translation-framework'
export const provide = ['translationFramework', 'translationQuick', 'translationTopics', 'translationObjects', 'translationMaterials', 'translationNormal', 'translationNormalV2', 'translationSources', 'translationAnalysis', 'translationPreparation', 'translationPlanning', 'translationBatch', 'translationCorrection', 'translationReview', 'translationReferences', 'translationLocalData'] as const

function phaseEvent(exchange: TranslationExchangeService, run: AnalysisRun): TaskPhaseEvent | null {
  if (!['completed', 'failed', 'unknown'].includes(run.status)) return null
  return { eventId: JSON.stringify(['terminology_analysis', run.scope.translationSessionId, run.operationId, run.analysisId, run.version, run.status]),
    hostGeneration: exchange.hostGeneration, scope: run.scope, operationId: run.operationId,
    phase: `terminology_analysis_${run.status}` as TaskPhaseEvent['phase'],
    result: { kind: 'analysis', analysisId: run.analysisId, version: run.version, sourceVersion: run.sourceVersion,
      material: { requestId: run.target.requestId, materialId: run.target.materialId } }, coverageComplete: run.coverageComplete }
}

/** T supplies analysis facts; E alone owns identity-checked main-Agent queue notifications. */
export function installTerminologyAnalysis(ctx: TopicHostContext): TerminologyAnalysisService {
  let disposed = false
  let attached: { readonly exchange: TranslationExchangeService; readonly hostGeneration: string; readonly unregister: () => void } | undefined
  const capability = () => {
    const exchange = ctx.get?.('translationExchange') as TranslationExchangeService | undefined
    if (disposed || typeof exchange?.registerTaskPhaseInspector !== 'function' || typeof exchange.notifyTaskPhase !== 'function' ||
      typeof exchange.taskPhaseCapabilities !== 'function') return { phaseProtocol: 1 as const, ready: false, reason: 'composer_phase_notification_unavailable' }
    try {
      const result = exchange.taskPhaseCapabilities()
      return result.phaseProtocol === 1 ? result : { phaseProtocol: 1 as const, ready: false, reason: 'composer_phase_protocol_mismatch' }
    } catch { return { phaseProtocol: 1 as const, ready: false, reason: 'composer_phase_notification_unavailable' } }
  }
  const service = new TerminologyAnalysisService(ctx, {
    phaseNotificationCapabilities: capability,
    phaseNotifier: () => {
      if (!capability().ready) return undefined
      const exchange = ctx.get?.('translationExchange') as TranslationExchangeService
      if (attached?.hostGeneration !== exchange.hostGeneration) {
        attached?.unregister()
        const unregister = exchange.registerTaskPhaseInspector(ctx as unknown as Parameters<TranslationExchangeService['registerTaskPhaseInspector']>[0], {
          inspectTaskPhase: event => {
            const live = ctx.get?.('translationExchange') as TranslationExchangeService | undefined
            if (disposed || live?.hostGeneration !== exchange.hostGeneration || event.hostGeneration !== exchange.hostGeneration || event.result.version !== 1) return null
            const run = service.inspectPhase({ scope: event.scope, analysisId: event.result.analysisId, operationId: event.operationId,
              version: 1, sourceVersion: event.result.sourceVersion })
            return run && phaseEvent(exchange, run)
          },
        })
        attached = { exchange, hostGeneration: exchange.hostGeneration, unregister }
      }
      const fixed = attached
      return async (run: AnalysisRun): Promise<AnalysisNotification> => {
        const live = ctx.get?.('translationExchange') as TranslationExchangeService | undefined
        if (disposed || attached !== fixed || live?.hostGeneration !== fixed.hostGeneration) return { state: 'unavailable', reason: 'composer_phase_generation_lost' }
        const event = phaseEvent(exchange, run)
        if (!event) return { state: 'unavailable', reason: 'analysis_not_terminal' }
        const result = await fixed.exchange.notifyTaskPhase(ctx as unknown as Parameters<TranslationExchangeService['notifyTaskPhase']>[0], event)
        return !result.ok ? { state: 'unavailable', reason: result.error.code }
          : { state: result.value.state === 'not_enqueued' ? 'unavailable' : result.value.state,
            reason: result.value.state === 'unavailable' || result.value.state === 'not_enqueued' ? 'composer_phase_notification_not_enqueued' : null }
      }
    },
  })
  ctx.provide('translationAnalysis', service)
  ctx.effect?.(() => () => { disposed = true; attached?.unregister(); attached = undefined; service.dispose() }, 'terminology analysis lifetime')
  return service
}

export function apply(ctx: QuickHostContext): void {
  ctx.provide('translationLocalData', new LocalDataService(ctx as TopicHostContext))
  installTopicTools(ctx as TopicHostContext, undefined, false)
  const references = new ReferenceFilesService(ctx as TopicHostContext)
  ctx.provide('translationReferences', references)
  ctx.effect?.(() => () => references.dispose(), 'reference files lifetime')
  installObjectAssets(ctx, {}, false)
  installTranslationMaterials(ctx as TranslationMaterialHostContext, undefined, false)
  installNormalTranslation(ctx as TopicHostContext, undefined, false)
  installTranslationSources(ctx, false)
  installTerminologyAnalysis(ctx as TopicHostContext)
  installTranslationPreparation(ctx as TopicHostContext)
  installDocumentPlanning(ctx as TopicHostContext)
  installDocumentExecution(ctx as TopicHostContext)
  installDocumentCorrection(ctx as TopicHostContext)
  installDocumentReview(ctx as TopicHostContext)
  const quick = installQuickTranslation(ctx, undefined, false)
  const register = (scope: QuickHostContext): void => {
    const registry = scope.get ? scope.get('typert') as QuickHostContext['typert'] : scope.typert
    registry?.register({ package: PLUGIN_REMOTE.package, face: 'host', schemas: [], invocations: PLUGIN_REMOTE.descriptors,
      model: { package: PLUGIN_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
  }
  if (ctx.inject) ctx.inject(['typert'], register)
  else register(ctx)
  ctx.provide('translationFramework', createTranslationFramework({ ...(quick ? { executionAdapter: quick.adapter, runtime: quick.runtime } : {}) }))
}
