import { createTranslationFramework } from './framework.js'
import { installQuickTranslation, type QuickHostContext } from './quick-translation.js'
import { installTopicTools, type TopicHostContext } from './topic-tools.js'
import { PLUGIN_REMOTE } from '../shared/plugin-remote.js'

export { createTranslationFramework } from './framework.js'
export { TextTranslationRuntime } from './text-runtime.js'
export { QuickTranslationService, installQuickTranslation } from './quick-translation.js'
export { DshTextExecutionAdapter } from './dsh-text-adapter.js'
export { TopicToolsService, installTopicTools } from './topic-tools.js'
export type * from '../shared/domain-contracts.js'

export const name = 'deepseek-translation-framework'
export const provide = ['translationFramework', 'translationQuick', 'translationTopics'] as const

export function apply(ctx: QuickHostContext): void {
  installTopicTools(ctx as TopicHostContext, undefined, false)
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
