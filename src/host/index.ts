import { createTranslationFramework } from './framework.js'
import { installQuickTranslation, type QuickHostContext } from './quick-translation.js'

export { createTranslationFramework } from './framework.js'
export { TextTranslationRuntime } from './text-runtime.js'
export { QuickTranslationService, installQuickTranslation } from './quick-translation.js'
export { DshTextExecutionAdapter } from './dsh-text-adapter.js'
export type * from '../shared/domain-contracts.js'

export const name = 'deepseek-translation-framework'
export const provide = ['translationFramework', 'translationQuick'] as const

export function apply(ctx: QuickHostContext): void {
  const quick = installQuickTranslation(ctx)
  ctx.provide('translationFramework', createTranslationFramework({ ...(quick ? { executionAdapter: quick.adapter, runtime: quick.runtime } : {}) }))
}
