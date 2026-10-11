import { createTranslationFramework } from './framework.js'
import { installQuickTranslation, type QuickHostContext } from './quick-translation.js'
import { installTopicTools, type TopicHostContext } from './topic-tools.js'
import { PLUGIN_REMOTE } from '../shared/plugin-remote.js'
import { installObjectAssets } from './object-assets.js'
import { installTranslationMaterials, type TranslationMaterialHostContext } from './translation-materials.js'
import { installNormalTranslation } from './normal-translation.js'
import { installTranslationSources } from './translation-sources.js'

export { createTranslationFramework } from './framework.js'
export { TextTranslationRuntime } from './text-runtime.js'
export { QuickTranslationService, installQuickTranslation } from './quick-translation.js'
export { DshTextExecutionAdapter } from './dsh-text-adapter.js'
export { TopicToolsService, installTopicTools } from './topic-tools.js'
export { ObjectAssetsService, installObjectAssets } from './object-assets.js'
export { TranslationMaterialsService, installTranslationMaterials } from './translation-materials.js'
export { NormalTranslationService, installNormalTranslation } from './normal-translation.js'
export { TranslationSourcesService, installTranslationSources } from './translation-sources.js'
export type * from '../shared/domain-contracts.js'

export const name = 'deepseek-translation-framework'
export const provide = ['translationFramework', 'translationQuick', 'translationTopics', 'translationObjects', 'translationMaterials', 'translationNormal', 'translationNormalV2', 'translationSources'] as const

export function apply(ctx: QuickHostContext): void {
  installTopicTools(ctx as TopicHostContext, undefined, false)
  installObjectAssets(ctx, {}, false)
  installTranslationMaterials(ctx as TranslationMaterialHostContext, undefined, false)
  installNormalTranslation(ctx as TopicHostContext, undefined, false)
  installTranslationSources(ctx, false)
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
