interface UpdateContext { get?(name: string): unknown }

export function installingTranslationUpdate(ctx: UpdateContext): boolean {
  return (ctx.get?.('translationPluginUpdate') as { isInstalling(): boolean } | undefined)?.isInstalling() === true
}

export function translationTasksActive(ctx: UpdateContext): boolean {
  const services = ['translationQuick', 'translationNormal', 'translationFileJobs', 'translationBatch', 'translationBatchProcessing',
    'translationAnalysis', 'translationHistory']
  return services.some(name => (ctx.get?.(name) as { hasActiveJobs?(): boolean } | undefined)?.hasActiveJobs?.())
}
