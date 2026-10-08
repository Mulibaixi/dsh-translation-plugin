import { TOPIC_BRIDGE_REMOTE, parseTopicBridgeOpen, parseTopicBridgeCommand, type TopicBridgeCapability, type TopicBridgeCommand, type TopicBridgeDown, type TopicBridgeOpen, type TopicBridgeReply, type TopicBridgeRequest, type TopicBridgeValue } from '../shared/topic-bridge.js'
import type { DshExecutionContext } from './dsh-text-adapter.js'

interface ToolExecution { readonly agent?: MainAgent; readonly callId: string; readonly signal: AbortSignal }
interface MainAgent {
  readonly id: string
  readonly session: { readonly id: string }
  readonly ctx: { readonly tools: { register(definition: unknown): () => void } }
}
export interface TopicHostContext extends DshExecutionContext {
  provide(key: string, service: unknown): unknown
  readonly invocation?: { readonly peer: { readonly id: string }; uplink(): AsyncIterable<TopicBridgeReply> }
  readonly root?: { readonly reflect: { readonly props: Record<string, unknown> }; accessor(name: string, descriptor: { get(): undefined }): unknown }
  readonly typert?: { register(contribution: unknown): unknown }
  on?(event: string, listener: (event: { readonly agent: MainAgent }) => void): () => void
  inject?(names: string[], callback: (ctx: TopicHostContext) => unknown): unknown
  effect?(callback: () => (() => void), label?: string): unknown
}
interface Agents { get(id: string): MainAgent | undefined }
interface SessionController { list(request: Record<string, never>, signal: AbortSignal): Promise<{ readonly items: readonly { readonly sessionId: string }[] }> }
interface ToolHelpers { defineTool(options: Record<string, unknown>): unknown }
export type TopicToolLoader = () => Promise<ToolHelpers>
const sessionParameter = { type: 'string', required: true, description: 'Exact translation Session id from translation_list_sessions.' }
const topicParameter = { type: 'string', required: true, description: 'Exact topic id from translation_list_topics or translation_list_sessions.' }
const sessionStartParameter = { required: true, oneOf: [
  { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['new_topic'], required: true } } },
  { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['parent_session'], required: true }, translationSessionId: sessionParameter } },
  { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['existing_topic'], required: true }, topicId: topicParameter } },
] }
const termFields = {
  id: { type: 'string', required: true }, expectedEntryVersion: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
  sourceLanguage: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }, targetLanguage: { type: 'string', required: true },
  sourceForms: { type: 'array', items: { type: 'string' }, required: true }, aliases: { type: 'array', items: { type: 'string' }, required: true },
  sense: { type: 'string', required: true }, preferred: { type: 'string', required: true }, forbidden: { type: 'array', items: { type: 'string' }, required: true },
  origin: { type: 'string', enum: ['inferred', 'source_checked'], required: true }, status: { type: 'string', enum: ['proposal', 'active'], required: true },
  evidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['source', 'final'], required: true }, sessionId: { type: 'string', required: true }, unitId: { type: 'string', required: true },
    revisionId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    selectionEventId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    range: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { start: { type: 'integer', required: true }, end: { type: 'integer', required: true } } }], required: true },
    role: { type: 'string', enum: ['basis', 'example'], required: true },
  } }, required: true },
}
const archiveKinds = ['entity', 'fact', 'relation'] as const
const archiveFields = {
  id: termFields.id, expectedEntryVersion: termFields.expectedEntryVersion, origin: termFields.origin,
  status: termFields.status, evidence: termFields.evidence,
}
const archiveEntryParameter = { required: true, oneOf: [
  { type: 'object', additionalProperties: false, properties: { ...archiveFields, kind: { type: 'string', enum: ['entity'], required: true },
    name: { type: 'string', required: true }, aliases: termFields.aliases, description: { type: 'string', required: true } } },
  { type: 'object', additionalProperties: false, properties: { ...archiveFields, kind: { type: 'string', enum: ['fact'], required: true },
    title: { type: 'string', required: true }, body: { type: 'string', required: true }, entityIds: { type: 'array', items: { type: 'string' }, required: true } } },
  { type: 'object', additionalProperties: false, properties: { ...archiveFields, kind: { type: 'string', enum: ['relation'], required: true },
    sourceEntityId: { type: 'string', required: true }, relation: { type: 'string', required: true }, targetEntityId: { type: 'string', required: true },
    description: { type: 'string', required: true } } },
] }

function hostToolLoader(ctx: TopicHostContext): TopicToolLoader {
  return async () => {
    if (!ctx.baseUrl) throw new Error('Host composition anchor unavailable')
    const loader = ctx.get?.('loader') as DshExecutionContext['loader']
    if (!loader?.internal) throw new Error('Host package loader unavailable')
    return await loader.internal.import('@deepseek-ai/dsh-tools', ctx.baseUrl, {}) as ToolHelpers
  }
}
function bridgeError(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
interface Pending {
  readonly frame: TopicBridgeRequest
  readonly resolve: (value: TopicBridgeValue) => void
  readonly reject: (error: Error) => void
  readonly clean: () => void
}
/** One explicitly connected owner. It carries requests, never a shadow copy of browser records. */
class ManagementConnection {
  pending: Pending | undefined
  closed = false
  ready = false
  private wake: (() => void) | undefined
  readonly stopped: Promise<void>
  private stop!: () => void
  constructor(readonly identity: TopicBridgeOpen, readonly peerId: string, readonly timeoutMs: number) {
    this.stopped = new Promise(resolve => { this.stop = resolve })
  }
  async request(command: TopicBridgeCommand, exec: ToolExecution): Promise<TopicBridgeValue> {
    if (this.closed || exec.agent?.id !== this.identity.mainSessionId || exec.agent.session.id !== this.identity.mainSessionId) throw bridgeError('scope_mismatch', '主题管理连接不属于此主会话。')
    exec.signal.throwIfAborted()
    if (this.pending) throw bridgeError('busy', '上一项主题管理操作仍在等待回执。')
    return new Promise<TopicBridgeValue>((resolve, reject) => {
      const abort = () => this.close(bridgeError('outcome_unknown', '主题管理操作已中断，请查看当前记录后再明确操作。'))
      const timer = setTimeout(() => this.close(bridgeError('outcome_unknown', '未取得主题管理回执，请查看当前记录；操作不会自动重发。')), this.timeoutMs)
      exec.signal.addEventListener('abort', abort, { once: true })
      this.pending = { frame: { kind: 'request', requestId: crypto.randomUUID(), mainSessionId: this.identity.mainSessionId, callId: exec.callId, command }, resolve, reject,
        clean: () => { clearTimeout(timer); exec.signal.removeEventListener('abort', abort) } }
      this.wake?.(); this.wake = undefined
    })
  }
  async next(): Promise<Pending | undefined> {
    if (!this.closed && !this.pending) await new Promise<void>(resolve => { this.wake = resolve })
    return this.closed ? undefined : this.pending
  }
  settle(reply: TopicBridgeReply): void {
    const pending = this.pending
    if (!pending || reply.requestId !== pending.frame.requestId) throw bridgeError('invalid_reply', '主题管理回执与请求不一致。')
    if (reply.ok) {
      const expected = { list_sessions: 'sessions', list_topics: 'topics', create_session: 'session_created', rename_topic: 'sessions',
        set_session_remark: 'sessions', archive_session: 'sessions', read_unit: 'unit', list_terms: 'terms', list_topic_terms: 'terms', query_terms: 'terms_query', upsert_term: 'terms',
        list_topic_archive: 'archive', query_archive: 'archive_query', upsert_archive: 'archive' }[pending.frame.command.kind]
      if (reply.value.kind !== expected) throw bridgeError('invalid_reply', '主题管理回执类型不一致。')
      if (['rename_topic', 'set_session_remark', 'archive_session'].includes(pending.frame.command.kind) && reply.value.kind === 'sessions' && reply.value.persistence === undefined) throw bridgeError('invalid_reply', '主题管理回执缺少实际保存状态。')
      pending.resolve(reply.value)
    } else pending.reject(bridgeError(reply.error.code, reply.error.message))
    pending.clean(); this.pending = undefined
  }
  close(error = bridgeError('outcome_unknown', '主题管理连接已断开，未确认的操作不会重发。')): void {
    if (this.closed) return
    this.closed = true; this.pending?.clean(); this.pending?.reject(error); this.pending = undefined
    this.stop(); this.wake?.(); this.wake = undefined
  }
}

export class TopicToolsService {
  readonly typertRemote: { readonly service: TopicToolsService; readonly serviceKey: 'translationTopics'; readonly namespace: 'translationTopics' }
  private readonly connections = new Map<string, ManagementConnection>()
  private disposed = false
  constructor(readonly ctx: TopicHostContext, private readonly loadTools: TopicToolLoader = hostToolLoader(ctx), private readonly timeoutMs = 15_000) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationTopics', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationTopics', namespace: 'translationTopics' })
  }
  capabilities(): TopicBridgeCapability {
    const ready = !this.disposed && !!this.ctx.get?.('agents') && !!this.ctx.get?.('tools') && !!this.ctx.get?.('sessionController')
    return ready ? { ready: true } : { ready: false, reason: '宿主主题管理接口尚未就绪。' }
  }
  /** Only an authorized, fully established Client connection can address managed objects. */
  ownsConnection(ownerId: string, peerId: string): boolean {
    const connection = this.connections.get(ownerId)
    return !this.disposed && !!connection?.ready && !connection.closed && connection.peerId === peerId
  }
  async *connect(request: TopicBridgeOpen, signal: AbortSignal): AsyncGenerator<TopicBridgeDown> {
    request = parseTopicBridgeOpen(request)
    signal.throwIfAborted()
    const peerId = this.ctx.invocation?.peer.id
    if (!peerId || request.ownerId !== request.mainSessionId || !this.capabilities().ready) throw bridgeError('unavailable', '主题管理连接不可用。')
    if (this.connections.has(request.mainSessionId)) throw bridgeError('connection_occupied', '此主会话的主题管理连接已被占用。')
    const connection = new ManagementConnection(request, peerId, this.timeoutMs)
    this.connections.set(request.mainSessionId, connection)
    const abort = () => connection.close()
    signal.addEventListener('abort', abort, { once: true })
    const installed = new Map<MainAgent, readonly (() => void)[]>()
    const clear = () => { for (const disposers of installed.values()) disposers.forEach(dispose => dispose()); installed.clear() }
    const stop = connection.stopped.then(clear)
    let created: (() => void) | undefined, removed: (() => void) | undefined
    let uplink: AsyncIterator<TopicBridgeReply> | undefined
    try {
      const controller = this.ctx.get?.('sessionController') as SessionController
      // Public metadata-only, cold-safe Session lookup. This never resumes or prompts an Agent.
      const visible = await controller.list({}, signal)
      if (!visible.items.some(item => item.sessionId === request.mainSessionId)) throw bridgeError('not_found', '主会话不存在或不可访问。')
      const helpers = await this.loadTools()
      signal.throwIfAborted()
      const install = ({ agent }: { readonly agent: MainAgent }): void => {
        if (connection.closed || agent.id !== request.mainSessionId || agent.session.id !== request.mainSessionId || installed.has(agent)) return
        installed.set(agent, this.installTools(agent, connection, helpers))
      }
      created = this.ctx.on?.('agent/created', install)
      removed = this.ctx.on?.('agent/disposed', ({ agent }) => {
        installed.get(agent)?.forEach(dispose => dispose()); installed.delete(agent)
      })
      const agent = (this.ctx.get?.('agents') as Agents).get(request.mainSessionId)
      if (agent) install({ agent })
      uplink = this.ctx.invocation!.uplink()[Symbol.asyncIterator]()
      connection.ready = true
      yield { kind: 'ready', ...request }
      while (!connection.closed) {
        const pending = await connection.next()
        if (!pending) break
        yield pending.frame
        const reply = await Promise.race([uplink.next(), connection.stopped.then(() => undefined)])
        if (!reply || reply.done) break
        connection.settle(reply.value)
      }
    } finally {
      connection.close(); await uplink?.return?.(); await stop; created?.(); removed?.()
      signal.removeEventListener('abort', abort)
      const materials = this.ctx.get?.('translationMaterials') as { releaseConnection(ownerId: string, peerId: string): void } | undefined
      materials?.releaseConnection(request.ownerId, peerId)
      if (this.connections.get(request.mainSessionId) === connection) this.connections.delete(request.mainSessionId)
    }
  }
  private installTools(agent: MainAgent, connection: ManagementConnection, helpers: ToolHelpers): readonly (() => void)[] {
    const definitions: readonly { readonly name: string; readonly description: string; readonly kind: TopicBridgeCommand['kind']; readonly parameters: Record<string, unknown> }[] = [
      { name: 'translation_list_sessions', kind: 'list_sessions', parameters: {}, description: 'List quick and normal translation Sessions belonging to this main Session, including only metadata and explicitly published reference ids. Terms management does not change execution mode.' },
      { name: 'translation_list_topics', kind: 'list_topics', parameters: {}, description: 'List topic metadata belonging to this main Session, including empty topics and topics whose last translation Session was deleted. Does not expose drafts or source bodies.' },
      { name: 'translation_create_session', kind: 'create_session', parameters: { start: sessionStartParameter, reason: { type: 'string', required: true } }, description: 'Create a translation Session in the background within the user-assigned task scope. Use a parent Session for a same-topic child, an existing topic id to reuse a topic including an empty topic, or new_topic only when the user explicitly intends a separate topic. A nonempty reason is returned as an explanation, never saved as the Session remark. Uses existing defaults or inherited settings; does not select the new Session or execute translation.' },
      { name: 'translation_rename_topic', kind: 'rename_topic', parameters: { topicId: topicParameter, expectedName: { type: 'string', required: true }, name: { type: 'string', required: true } }, description: 'Rename one owned topic, including an empty topic, only if its current name equals the observed expectedName. Changes metadata for its translation Sessions; does not alter drafts, models or requirements. Check returned persistence or an error; errors may require querying current metadata.' },
      { name: 'translation_set_session_remark', kind: 'set_session_remark', parameters: { translationSessionId: sessionParameter, expectedRemark: { type: 'string', required: true }, remark: { type: 'string', required: true } }, description: 'Set one owned translation Session remark only if it still equals expectedRemark. Remark is separate from topic naming and translation requirements. This does not edit the draft or invoke a model. An empty string clears a remark.' },
      { name: 'translation_archive_session', kind: 'archive_session', parameters: { translationSessionId: sessionParameter, expectedArchived: { type: 'boolean', required: true }, archived: { type: 'boolean', required: true } }, description: 'Archive or restore one owned translation Session only if its archived state still equals expectedArchived. Keeps content and topic assets, never deletes. Restoration happens in the background and does not select the Session. Check persistence; a failed save is not a rollback guarantee.' },
      { name: 'translation_read_unit', kind: 'read_unit', parameters: { translationSessionId: sessionParameter, unitId: { type: 'string', required: true } }, description: 'Read one historical text unit explicitly exposed by the user. Unpublished history and current drafts are inaccessible.' },
      { name: 'translation_list_terms', kind: 'list_terms', parameters: { translationSessionId: { type: 'string', description: sessionParameter.description }, topicId: { type: 'string', description: topicParameter.description } }, description: 'Read owned topic terminology, status, versions and evidence references. Supply exactly one translationSessionId or topicId; a topic id also works after its last Session was deleted. Source bodies are not included.' },
      { name: 'translation_query_terms', kind: 'query_terms', parameters: { translationSessionId: sessionParameter, sourceLanguage: termFields.sourceLanguage, targetLanguage: termFields.targetLanguage, forms: { type: 'array', items: { type: 'string' }, required: true } }, description: 'Select active topic terms by exact source language, target language and explicit forms or aliases. Invalid or outdated basis is excluded.' },
      { name: 'translation_upsert_term', kind: 'upsert_term', parameters: { translationSessionId: sessionParameter, expectedVersion: { type: 'integer', required: true }, entry: { type: 'object', additionalProperties: false, properties: termFields, required: true } }, description: 'Propose or source-check one topic term against the observed topic/entry versions. Source evidence must have been explicitly published. Cannot create user confirmation or rewrite a user-adopted rule.' },
      { name: 'translation_list_topic_archive', kind: 'list_topic_archive', parameters: { topicId: topicParameter }, description: 'Read entity, fact and relation entries, statuses, versions and evidence references for one owned topic, including a retained topic without translation Sessions. Does not include source bodies or drafts.' },
      { name: 'translation_query_archive', kind: 'query_archive', parameters: { translationSessionId: sessionParameter,
        kinds: { type: 'array', items: { type: 'string', enum: archiveKinds }, required: true }, forms: { type: 'array', items: { type: 'string' }, required: true } },
        description: 'Select active topic archive entries by explicit exact names, aliases, titles or relation forms. The translation Session fixes owner, topic and actual mode; Quick returns no entries. Outdated basis and unavailable entity references are excluded.' },
      { name: 'translation_upsert_archive', kind: 'upsert_archive', parameters: { topicId: topicParameter, expectedVersion: { type: 'integer', required: true }, entry: archiveEntryParameter },
        description: 'Propose or source-check one entity, fact or relation in an owned topic against observed topic and entry versions. Evidence must be explicitly published by the user; inferred entries stay proposals. Cannot create user confirmation, overwrite user-adopted entries, edit translation text or invoke translation. Retained topics without Sessions also accept proposals.' },
    ]
    const disposers: (() => void)[] = []
    try {
      for (const definition of definitions) disposers.push(agent.ctx.tools.register(helpers.defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters,
        output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: (args: Record<string, unknown>, exec: ToolExecution) => {
          if (exec.agent !== agent) throw bridgeError('scope_mismatch', '主题工具不属于此 Agent。')
          if (definition.kind === 'list_terms') {
            const session = args.translationSessionId !== undefined, topic = args.topicId !== undefined
            if (session === topic) throw bridgeError('invalid_target', '术语读取必须恰好指定翻译会话或主题 ID。')
            return connection.request(parseTopicBridgeCommand(topic ? { kind: 'list_topic_terms', topicId: args.topicId } : { kind: 'list_terms', translationSessionId: args.translationSessionId }), exec)
          }
          return connection.request(parseTopicBridgeCommand({ ...args, kind: definition.kind }), exec)
        },
      })))
      return disposers
    } catch (error) { disposers.forEach(dispose => dispose()); throw error }
  }
  dispose(): void { this.disposed = true; for (const connection of this.connections.values()) connection.close(); this.connections.clear() }
}
export function installTopicTools(ctx: TopicHostContext, loadTools?: TopicToolLoader, registerRemote = true): TopicToolsService {
  if (ctx.root && !Object.hasOwn(ctx.root.reflect.props, 'invocation')) ctx.root.accessor('invocation', { get: () => undefined })
  const service = new TopicToolsService(ctx, loadTools)
  ctx.provide('translationTopics', service)
  const register = (scope: TopicHostContext): void => {
    const registry = (scope.get?.('typert') ?? scope.typert) as TopicHostContext['typert']
    registry?.register({ package: TOPIC_BRIDGE_REMOTE.package, face: 'host', schemas: [], invocations: TOPIC_BRIDGE_REMOTE.descriptors,
      model: { package: TOPIC_BRIDGE_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
  }
  if (registerRemote) {
    if (ctx.inject) ctx.inject(['typert'], register)
    else register(ctx)
  }
  ctx.effect?.(() => () => service.dispose(), 'translation topic management lifetime')
  return service
}
