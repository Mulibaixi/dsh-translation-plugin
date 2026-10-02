import { emptyMemoryPort } from '../memory/empty-memory.js'
import type { TranslationFrameworkServices } from '../shared/contracts.js'

export function createTranslationFramework(): TranslationFrameworkServices {
  return Object.freeze({
    contractVersion: 1,
    memory: emptyMemoryPort,
  })
}
