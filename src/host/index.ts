import { createTranslationFramework } from './framework.js'

export { createTranslationFramework } from './framework.js'
export { TextTranslationRuntime } from './text-runtime.js'
export type * from '../shared/domain-contracts.js'

export const name = 'deepseek-translation-framework'
export const provide = ['translationFramework'] as const

interface HostPluginContext {
  provide(key: string, service: unknown): unknown
}

export function apply(ctx: HostPluginContext): void {
  ctx.provide('translationFramework', createTranslationFramework())
}
