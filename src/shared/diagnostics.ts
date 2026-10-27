export interface DiagnosticContext {
  readonly logger?: { info(message: string): unknown; warn(message: string): unknown; error?(message: string): unknown }
}
type Facts = Readonly<Record<string, number | boolean | string | null | undefined>>
/** Callers supply counts and protocol facts only, never bodies, URLs, credentials or raw errors. */
export function diagnosticSpan(ctx: DiagnosticContext, stage: string, facts: Facts = {}, operationId?: string) {
  const started = Date.now(), traceId = crypto.randomUUID()
  const operation = operationId?.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu)?.[0]
  const emit = (status: string, extra: Facts, error?: unknown): void => {
    try {
      const value = error as { code?: unknown; cause?: { code?: unknown }; stack?: unknown } | null | undefined
      const safeCode = (code: unknown): string | undefined => typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/u.test(code) ? code : undefined
      const frames = typeof value?.stack === 'string' ? value.stack.split('\n').filter(line => /^\s+at .+:\d+:\d+\)?$/u.test(line)).slice(0, 8) : []
      const message = '[dsh-translation] ' + JSON.stringify({ at: new Date().toISOString(), stage, traceId, operation, status, elapsedMs: Date.now() - started, ...facts, ...extra,
        ...(error === undefined ? {} : { errorCode: safeCode(value?.code) ?? 'UNCLASSIFIED', causeCode: safeCode(value?.cause?.code), frames }) })
      // Cordis' default level includes error/info, but may filter warn/debug.
      const level = status === 'failed' ? 'error' : 'info'
      try { if (typeof ctx.logger?.[level] === 'function') { ctx.logger[level](message); return } } catch { /* Use the Host process output if its logger is absent or unavailable. */ }
      console[level](message)
    } catch { /* Diagnostic output must not change translation or storage outcomes. */ }
  }
  emit('started', {})
  return (status: 'completed' | 'failed' | 'cancelled' | 'incomplete' | 'degraded', extra: Facts = {}, error?: unknown): void => emit(status, extra, error)
}
