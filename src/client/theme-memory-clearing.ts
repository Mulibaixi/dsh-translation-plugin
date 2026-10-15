import type { SessionStore } from './session-store.js'
import { isDocumentUnit } from './translation-history.js'
import type { TopicMemoryStore, TopicTermClearVersion } from './topic-memory-store.js'
import type { TopicArchiveStore, TopicArchiveVersion } from './topic-archive-store.js'

export interface ThemeMemoryClearSelection { readonly terms: boolean; readonly archive: boolean }
export const DEFAULT_THEME_MEMORY_CLEAR_SELECTION: ThemeMemoryClearSelection = { terms: true, archive: true }
export interface ThemeMemoryClearPlan {
  readonly ownerId: string
  readonly topicId: string
  readonly topicName: string
  readonly terms: TopicTermClearVersion
  readonly archive: TopicArchiveVersion
}
export type ThemeMemoryClearAssetResult = 'cleared' | 'failed' | 'not_selected' | 'not_started'
export interface ThemeMemoryClearResult {
  readonly status: 'cleared' | 'partial' | 'failed' | 'busy' | 'stale' | 'empty_selection'
  readonly terms: ThemeMemoryClearAssetResult
  readonly archive: ThemeMemoryClearAssetResult
  readonly message: string
}

/** User-only asset clearing; topic/session/source identities and prepared call facts remain intact. */
export class ThemeMemoryClearing {
  constructor(private readonly sessions: SessionStore, private readonly terms: TopicMemoryStore, private readonly archive: TopicArchiveStore,
    private readonly options: { readonly isSessionBusy?: (sessionId: string) => boolean; readonly subscribeBusy?: (listener: () => void) => () => void } = {}) {}

  subscribe(listener: () => void): () => void {
    const stops = [this.sessions.subscribe(listener), this.terms.subscribe(listener), this.archive.subscribe(listener), this.options.subscribeBusy?.(listener)]
    return () => { for (const stop of stops) stop?.() }
  }

  getBlockedReason(ownerId: string, topicId: string): string | undefined {
    if (!this.sessions.getTopics(ownerId).some(topic => topic.id === topicId)) return '此主题不存在或已不可用。'
    for (const session of this.sessions.getTopicSessions(topicId)) {
      const history = this.sessions.getTranslationHistory(session.id)
      if (this.sessions.hasDocumentLease(session.id) || this.options.isSessionBusy?.(session.id) || history?.units.some(unit => isDocumentUnit(unit)
        ? unit.tasks.some(task => ['running', 'unknown'].includes(task.status))
        : unit.revisions.some(revision => ['submitting', 'running', 'unknown'].includes(revision.status))) ||
        history?.exchanges.some(exchange => ['open', 'waiting_user', 'resuming', 'unknown'].includes(exchange.status))) {
        return '本主题仍有运行中、等待处理或结果未知的翻译，请先结束或确认任务后再清空记忆。'
      }
    }
    return undefined
  }

  /** Freeze both saved and runtime versions when the confirmation is opened. */
  capture(ownerId: string, topicId: string): ThemeMemoryClearPlan {
    const topic = this.sessions.getTopics(ownerId).find(topic => topic.id === topicId)
    if (!topic) throw new Error('Topic clearing scope is unavailable')
    return { ownerId, topicId, topicName: topic.name, terms: this.terms.captureClearVersion(ownerId, topicId), archive: this.archive.captureClearVersion(ownerId, topicId) }
  }

  async clear(plan: ThemeMemoryClearPlan, selection: ThemeMemoryClearSelection = DEFAULT_THEME_MEMORY_CLEAR_SELECTION): Promise<ThemeMemoryClearResult> {
    const fixed = structuredClone(plan), chosen = { terms: selection.terms === true, archive: selection.archive === true }
    const stopped = (status: ThemeMemoryClearResult['status'], message: string): ThemeMemoryClearResult => ({ status, message,
      terms: chosen.terms ? 'not_started' : 'not_selected', archive: chosen.archive ? 'not_started' : 'not_selected' })
    if (!chosen.terms && !chosen.archive) return stopped('empty_selection', '请选择要清空的记忆类型。')
    try {
      return await this.terms.withTopicLock(() => {
        const topic = this.sessions.getTopics(fixed.ownerId).find(topic => topic.id === fixed.topicId)
        if (!topic || topic.name !== fixed.topicName || [fixed.terms, fixed.archive].some(version => version.ownerId !== this.sessions.getTopicAssetOwner(fixed.topicId) || version.topicId !== fixed.topicId) ||
          chosen.terms && !this.terms.isClearVersionCurrent(fixed.terms) || chosen.archive && !this.archive.isClearVersionCurrent(fixed.archive)) {
          return stopped('stale', '主题或所选记忆已变化，请重新打开清空确认；本次尚未清空任何范围。')
        }
        const blocked = this.getBlockedReason(fixed.ownerId, fixed.topicId)
        if (blocked) return stopped('busy', blocked)
        // Each successful write also updates its runtime seat. Multi-key storage does not promise rollback.
        const terms = chosen.terms ? this.terms.clearLocked(fixed.terms) ? 'cleared' : 'failed' : 'not_selected'
        const archive = chosen.archive ? this.archive.clearLocked(fixed.archive) ? 'cleared' : 'failed' : 'not_selected'
        const completed = [...(terms === 'cleared' ? ['术语'] : []), ...(archive === 'cleared' ? ['结构化档案'] : [])]
        const failed = [...(terms === 'failed' ? ['术语'] : []), ...(archive === 'failed' ? ['结构化档案'] : [])]
        const runtimeOnly = terms === 'cleared' && !fixed.terms.storageAvailable || archive === 'cleared' && !fixed.archive.storageAvailable
        return { status: failed.length ? completed.length ? 'partial' : 'failed' : 'cleared', terms, archive,
          message: failed.length ? `${completed.length ? `已清空${runtimeOnly ? '当前运行期' : ''}：${completed.join('、')}；${runtimeOnly ? '本地保存副本未确认清理；' : ''}` : ''}未清空：${failed.join('、')}。请检查提示后重试未完成范围。`
            : runtimeOnly ? '当前运行期记忆已清空；本地保存副本未确认清理。' : `已清空本主题记忆：${completed.join('、')}。` }
      })
    } catch { return stopped('failed', '无法取得主题存储锁或读取当前副本，本次尚未清空任何范围。') }
  }
}
