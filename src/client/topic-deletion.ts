import type { SessionStore, TopicDeletionPlan, TopicDeletionResult } from './session-store.js'
import type { ThemeMemoryClearPlan, ThemeMemoryClearing } from './theme-memory-clearing.js'
import type { ReferenceStore } from './reference-store.js'
import type { ViewFilesClient } from './view-files-client.js'
import type { LocalDataClient } from './local-data.js'
import type { TopicBridgeClient } from './topic-bridge.js'

export interface TopicDeletionPreview {
  readonly plan: TopicDeletionPlan
  readonly memory: ThemeMemoryClearPlan
  readonly termsCount: number
  readonly archiveCount: number
  readonly referenceCount: number
}

export interface TopicDeletionPorts {
  readonly sessions: SessionStore
  readonly clearing: ThemeMemoryClearing
  readonly references: ReferenceStore
  readonly viewFiles?: ViewFilesClient | undefined
  readonly localData?: LocalDataClient | undefined
  readonly topics?: Pick<TopicBridgeClient, 'revokeTopic'> | undefined
  readonly isSessionBusy?: ((sessionId: string) => boolean) | undefined
}

/** Orchestrates the three phases around the store-owned identity/session barriers. */
export class TopicDeletionClient {
  constructor(private readonly ports: TopicDeletionPorts) {}

  capture(callerOwnerId: string, topicId: string): TopicDeletionPreview | undefined {
    const plan = this.ports.sessions.captureTopicDeletion(callerOwnerId, topicId)
    if (!plan) return undefined
    const memory = this.ports.clearing.capture(plan.ownerId, topicId)
    return { plan, memory, termsCount: memory.terms.currentCount, archiveCount: memory.archive.currentCount,
      referenceCount: this.ports.references.getTopicDocumentCount(plan.ownerId, topicId) }
  }

  getBlockedReason(preview: TopicDeletionPreview): string | undefined {
    const plan = preview.plan
    const blocked = this.ports.sessions.getTopicDeletionBlockedReason(plan)
    if (blocked) return blocked
    if (plan.sessionIds.some(sessionId => this.ports.isSessionBusy?.(sessionId))) return '主题内仍有运行中的翻译，请先结束或查询。'
    return this.ports.clearing.getBlockedReason(plan.ownerId, plan.topicId)
  }

  /** Closing an unfinished confirmation releases the deletion barrier; committed deletions have no intent left. */
  async cancel(preview: TopicDeletionPreview, message = '已取消主题删除。'): Promise<boolean> {
    return this.ports.sessions.abortTopicDeletionAsync(preview.plan, message)
  }

  /** Re-capture after a partial attempt: the intent keeps the same operation and the same remaining scope. */
  async delete(preview: TopicDeletionPreview): Promise<TopicDeletionResult> {
    const plan = structuredClone(preview.plan), operationId = plan.operationId
    const result = (status: TopicDeletionResult['status'], message: string, remaining?: readonly string[]): TopicDeletionResult =>
      ({ status, operationId, message, ...(remaining?.length ? { remaining } : {}) })
    const blocked = this.getBlockedReason(preview)
    if (blocked) return result('blocked', blocked)
    if (!await this.ports.sessions.beginTopicDeletionAsync(plan)) return result('stale', '主题或会话已变化，请重新打开删除确认；本次未删除任何内容。')
    if (!await this.ports.sessions.deleteTopicSessionsAsync(plan)) return result('partial', '主题会话未全部删除，主题仍保留；请重试同一删除操作。', ['会话'])
    const memory = await this.ports.clearing.clear(preview.memory)
    if (memory.status !== 'cleared') return result('partial', `会话已删除，但主题记忆未清空：${memory.message}`, ['主题记忆'])
    if (preview.referenceCount > 0 && !await this.ports.references.clearTopic(plan.ownerId, plan.topicId))
      return result('partial', '会话与主题记忆已删除，但参考资料未清理；请重试。', ['参考资料'])
    this.ports.references.discardTopic(plan.ownerId, plan.topicId)
    if (this.ports.viewFiles) {
      const sessionIds = this.ports.sessions.getTopicDeletionIntent(plan.topicId)?.sessionIds ?? plan.sessionIds
      await this.ports.viewFiles.clear([{ ownerId: plan.callerOwnerId, sessionIds: [...sessionIds] }])
    }
    if (this.ports.localData) {
      const purged = await this.ports.localData.purgeTopic(operationId, plan.ownerId, plan.topicId, this.ports.references.getAssetNamespaceId())
      if (!purged.ok) return result('partial', `会话与主题记忆已删除，但宿主文件未清理：${purged.message ?? '请重试。'}`, ['宿主文件'])
    }
    if (!await this.ports.sessions.commitTopicDeletionAsync(plan)) return result('failed', '主题删除未提交；请核对当前主题与会话后重试。')
    this.ports.topics?.revokeTopic(plan.topicId)
    return result('deleted', `已删除主题「${preview.plan.topicName}」及其会话与记忆资产。`)
  }
}
