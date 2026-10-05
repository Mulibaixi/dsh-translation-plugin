import { emptyMemoryPort } from '../memory/empty-memory.js'
import type { TranslationFrameworkServices } from '../shared/contracts.js'
import type { TextExecutionAdapter } from '../shared/domain-contracts.js'
import { TextTranslationRuntime } from './text-runtime.js'

export function createTranslationFramework(options: { executionAdapter?: TextExecutionAdapter; runtime?: TextTranslationRuntime } = {}): TranslationFrameworkServices {
  return Object.freeze({
    contractVersion: 1,
    memory: emptyMemoryPort,
    domainVersion: 1,
    runtime: options.runtime ?? new TextTranslationRuntime(options.executionAdapter),
  })
}
