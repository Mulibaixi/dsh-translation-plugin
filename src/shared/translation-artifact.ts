import { parseNormalTranslationTarget, type NormalTranslationTarget } from './normal-translation.js'

export const TRANSLATION_ARTIFACT_FORMATS = ['txt', 'md', 'json', 'html'] as const
export type TranslationArtifactFormat = typeof TRANSLATION_ARTIFACT_FORMATS[number]
/** Save the exact current result of a material or unit as a real file; opening is a separate step. */
export interface TranslationArtifactSave {
  readonly target: NormalTranslationTarget
  readonly format: TranslationArtifactFormat
  /** Optional display name; the Host sanitizes it and always appends the real extension. */
  readonly fileName?: string
}
export interface TranslationArtifactCheck { readonly code: string; readonly message: string }
export interface TranslationArtifactSaved {
  readonly path: string
  readonly fileName: string
  readonly format: TranslationArtifactFormat
  readonly bytes: number
  readonly codePoints: number
  readonly revisionIds: readonly string[]
  readonly segments: number
  readonly checks: readonly TranslationArtifactCheck[]
}
export interface TranslationArtifactOpen { readonly path: string }

type Data = Record<string, unknown>
function object(value: unknown): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected artifact object')
}
function exact(value: Data, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError('Unexpected artifact fields')
}
export function isArtifactFormat(value: unknown): value is TranslationArtifactFormat {
  return typeof value === 'string' && (TRANSLATION_ARTIFACT_FORMATS as readonly string[]).includes(value)
}
export function parseArtifactSave(value: unknown): TranslationArtifactSave {
  object(value); exact(value, ['target', 'format', ...(value.fileName === undefined ? [] : ['fileName'])])
  if (!isArtifactFormat(value.format)) throw new TypeError('Unsupported artifact format')
  if (value.fileName !== undefined) {
    if (typeof value.fileName !== 'string' || !value.fileName.trim() || Array.from(value.fileName).length > 120 ||
      /[\\/<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value.fileName)) throw new TypeError('Invalid artifact file name')
  }
  return { target: parseNormalTranslationTarget(value.target), format: value.format,
    ...(value.fileName === undefined ? {} : { fileName: value.fileName as string }) }
}
export function parseArtifactOpen(value: unknown): TranslationArtifactOpen {
  object(value); exact(value, ['path'])
  if (typeof value.path !== 'string' || !value.path.trim() || value.path.length > 4096) throw new TypeError('Invalid artifact path')
  return { path: value.path }
}
/** The only extension the Host will append; the model never chooses an arbitrary file type. */
export function artifactExtension(format: TranslationArtifactFormat): string { return format === 'md' ? '.md' : format === 'json' ? '.json' : format === 'html' ? '.html' : '.txt' }
