/** Bodies cross the live bridge only; saved call metadata retains identities, not copied history. */
export interface DirectHistoryRef { readonly unitId: string; readonly sourceVersion: number; readonly revisionId: string }
export interface DirectHistoryRefs { readonly base?: DirectHistoryRef; readonly nearby: readonly DirectHistoryRef[] }
export interface DirectHistoryContext {
  readonly base?: DirectHistoryRef & { readonly text: string }
  readonly nearby: readonly (DirectHistoryRef & { readonly source: string; readonly text: string })[]
}
export function historyContextRefs(value: DirectHistoryContext): DirectHistoryRefs {
  const ref = ({ unitId, sourceVersion, revisionId }: DirectHistoryRef): DirectHistoryRef => ({ unitId, sourceVersion, revisionId })
  return { ...(value.base ? { base: ref(value.base) } : {}), nearby: value.nearby.map(ref) }
}
export function parseDirectHistoryRefs(value: unknown): DirectHistoryRefs { return parse(value, false) as DirectHistoryRefs }
export function parseDirectHistoryContext(value: unknown): DirectHistoryContext { return parse(value, true) as DirectHistoryContext }
function parse(value: unknown, bodies: boolean): DirectHistoryContext | DirectHistoryRefs {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('Invalid translation history context')
    return v as Record<string, unknown>
  }
  const text = (v: unknown, limit: number): void => { if (typeof v !== 'string' || !v.trim() || Array.from(v).length > limit) throw new TypeError('Invalid translation history context text') }
  const c = object(value)
  if (Object.keys(c).some(k => !['base', 'nearby'].includes(k)) || !Array.isArray(c.nearby) || c.nearby.length > 3) throw new TypeError('Invalid translation history context fields')
  const check = (v: unknown, base: boolean): void => {
    const r = object(v), fields = ['unitId', 'sourceVersion', 'revisionId', ...(bodies ? base ? ['text'] : ['source', 'text'] : [])]
    if (Object.keys(r).length !== fields.length || fields.some(k => !Object.hasOwn(r, k))) throw new TypeError('Unexpected translation history context fields')
    text(r.unitId, 2048); text(r.revisionId, 2048)
    if (!Number.isSafeInteger(r.sourceVersion) || (r.sourceVersion as number) < 1) throw new TypeError('Invalid translation history source version')
    if (bodies) { text(r.text, base ? 20000 : 1200); if (!base) text(r.source, 1200) }
  }
  if (c.base !== undefined) check(c.base, true)
  c.nearby.forEach(r => check(r, false))
  return structuredClone(value) as DirectHistoryContext | DirectHistoryRefs
}
