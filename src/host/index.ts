import { createTranslationFramework } from './framework.js'

export const name = 'deepseek-translation-framework'
export const provide = ['translationFramework'] as const

interface HostPluginContext {
  provide(key: string, service: unknown): unknown
}

export function apply(ctx: HostPluginContext): void {
  ctx.provide('translationFramework', createTranslationFramework())
}
