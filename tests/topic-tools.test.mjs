import assert from 'node:assert/strict'
import test from 'node:test'
import { TopicToolsService } from '../dist/host/topic-tools.js'
import { parseTopicBridgeOpen, parseTopicBridgeCommand, parseTopicBridgeDown, parseTopicBridgeReply, MAX_TOPIC_BRIDGE_REPLY_BYTES, TOPIC_BRIDGE_REMOTE } from '../dist/shared/topic-bridge.js'
import { emptyTopicTerms } from '../dist/memory/topic-terms.js'
import { PLUGIN_REMOTE } from '../dist/shared/plugin-remote.js'

function queue() {
  const items = []; let wake; let closed = false
  return { push(value) { items.push(value); wake?.(); wake = undefined },
    [Symbol.asyncIterator]() { return this },
    async next() { if (!items.length && !closed) await new Promise(resolve => { wake = resolve }); return items.length ? { value: items.shift(), done: false } : { done: true } },
    async return() { closed = true; wake?.(); return { done: true } },
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const open = { ownerId: 'synthetic-main', mainSessionId: 'synthetic-main' }
function fixture({ initialAgent = true, timeout = 1000 } = {}) {
  const inbox = queue(), listeners = new Map(), tools = new Map(), calls = []
  const agent = { id: open.mainSessionId, session: { id: open.mainSessionId }, ctx: { tools: {
    register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
  } } }
  const ctx = { invocation: { peer: { id: 'synthetic-peer' }, uplink: () => inbox },
    get(key) { return { agents: { get: () => initialAgent ? agent : undefined }, tools: {}, sessionController: {
      async list(request, signal) { calls.push(request); signal.throwIfAborted(); return { items: [{ sessionId: open.mainSessionId }] } },
    } }[key] },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
  }
  const service = new TopicToolsService(ctx, async () => ({ defineTool: options => options }), timeout)
  const controller = new AbortController(), stream = service.connect(open, controller.signal)
  return { service, stream, controller, inbox, tools, calls, listeners, agent,
    exec: { agent, callId: 'actual-call-id', signal: new AbortController().signal },
    async close() { controller.abort(); await stream.return(); service.dispose() },
  }
}
const sessionsReply = id => ({ requestId: id, ok: true, value: { kind: 'sessions', sessions: [] } })

test('topic bridge仅公开管理/历史协议，严格拒绝凭据、伪造owner和普通材料命令', () => {
  assert.deepEqual(parseTopicBridgeOpen(open), open)
  for (const value of [{ ...open, ownerId: 'other' }, { ...open, profile: {} }]) assert.throws(() => parseTopicBridgeOpen(value))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'read_material', translationSessionId: 's', materialId: 'm' }))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'list_terms', translationSessionId: 's', mainSessionId: 'spoof' }))
  assert.throws(() => parseTopicBridgeReply({ ...sessionsReply('r'), config: { token: 'synthetic-secret' } }))
  assert.throws(() => parseTopicBridgeReply({ requestId: 'r', ok: true, value: { kind: 'sessions', sessions: [{ id: 's', topicId: 't', name: 'Synthetic', mode: 'quick', publishedUnitIds: [], profile: {} }] } }))
  const descriptor = TOPIC_BRIDGE_REMOTE.descriptors.find(item => item.method === 'connect')
  assert.equal(descriptor.mode, 'stream'); assert.equal(descriptor.uplink.codec.mode, 'strict')
  assert.equal(PLUGIN_REMOTE.package, TOPIC_BRIDGE_REMOTE.package)
  assert.equal(PLUGIN_REMOTE.descriptors.length, 7)
  assert.deepEqual(new Set(PLUGIN_REMOTE.descriptors.map(item => item.namespace)), new Set(['translationQuick', 'translationTopics']))
})

test('topic uplink预算拒绝超额，term query子集不会夹带非active条目', () => {
  const huge = { requestId: 'r', ok: true, value: { kind: 'unit', unit: { id: 'u', order: 1, source: '源'.repeat(MAX_TOPIC_BRIDGE_REPLY_BYTES), targetLanguage: '中文', instruction: '', revisions: [], final: null } } }
  assert.throws(() => parseTopicBridgeReply(huge), /budget/)
  const snapshot = emptyTopicTerms(open.ownerId, 'topic', '2026-10-06T00:00:00.000Z')
  assert.deepEqual(parseTopicBridgeReply({ requestId: 'r', ok: true, value: { kind: 'terms_query', snapshot } }).value.snapshot, snapshot)
  assert.throws(() => parseTopicBridgeDown({ kind: 'request', requestId: 'r', mainSessionId: open.mainSessionId, callId: 'c', command: { kind: 'list_sessions' }, chat: [] }))
})

test('metadata绑定无需先激活Agent，created安装五工具且同Agent不重复安装', async () => {
  const f = fixture({ initialAgent: false })
  try {
    assert.equal((await f.stream.next()).value.kind, 'ready'); assert.equal(f.tools.size, 0); assert.deepEqual(f.calls, [{}])
    f.listeners.get('agent/created')({ agent: f.agent }); assert.equal(f.tools.size, 5)
    f.listeners.get('agent/created')({ agent: f.agent }); assert.equal(f.tools.size, 5)
    assert.ok(f.tools.has('translation_query_terms')); assert.ok(!f.tools.has('translation_read_material'))
    f.listeners.get('agent/disposed')({ agent: f.agent }); assert.equal(f.tools.size, 0)
  } finally { await f.close() }
  assert.equal(f.listeners.size, 0)
})

test('同main第二管理连接拒绝占用，已abort/额外字段不会建立连接', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    await assert.rejects(f.service.connect(open, new AbortController().signal).next(), { code: 'connection_occupied' })
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(f.service.connect(open, aborted.signal).next(), { name: 'AbortError' })
    await assert.rejects(f.service.connect({ ...open, profile: {} }, new AbortController().signal).next(), TypeError)
  } finally { await f.close() }
})

test('工具携真实exec Agent/callId双向回执，错误Agent和伪造同id对象拒绝', async () => {
  const f = fixture()
  try {
    await f.stream.next(); const tool = f.tools.get('translation_list_sessions')
    assert.throws(() => tool.execute({}, { ...f.exec, agent: { ...f.agent } }), { code: 'scope_mismatch' })
    const result = tool.execute({}, f.exec), frame = (await f.stream.next()).value
    assert.equal(frame.callId, f.exec.callId); assert.equal(frame.mainSessionId, open.mainSessionId); assert.deepEqual(frame.command, { kind: 'list_sessions' })
    f.inbox.push(sessionsReply(frame.requestId)); const waiting = f.stream.next()
    assert.deepEqual(await result, { kind: 'sessions', sessions: [] })
    f.controller.abort(); await waiting
  } finally { await f.close() }
  assert.equal(f.tools.size, 0)
})

test('Client语义stale返回保留类型，下次显式请求可继续，未重试写', async () => {
  const f = fixture()
  try {
    await f.stream.next(); const tool = f.tools.get('translation_list_terms')
    const result = tool.execute({ translationSessionId: 'translation' }, f.exec)
    const rejected = assert.rejects(result, { code: 'stale' })
    const frame = (await f.stream.next()).value
    f.inbox.push({ requestId: frame.requestId, ok: false, error: { code: 'stale', message: '版本变化' } })
    const waiting = f.stream.next(); await rejected; f.controller.abort(); await waiting
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

test('超时关闭连接并卸载，unknown写不隐式重发', async () => {
  const f = fixture({ timeout: 15 })
  try {
    await f.stream.next()
    const result = f.tools.get('translation_list_sessions').execute({}, f.exec)
    const rejected = assert.rejects(result, { code: 'outcome_unknown' })
    assert.equal((await f.stream.next()).value.kind, 'request')
    await rejected; await tick(); assert.equal(f.tools.size, 0)
    assert.equal((await f.stream.next()).done, true)
  } finally { await f.close() }
})

test('错误correlation不接受结果，pending变unknown并完整cleanup', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    const result = f.tools.get('translation_list_sessions').execute({}, f.exec)
    const rejected = assert.rejects(result, { code: 'outcome_unknown' })
    await f.stream.next(); f.inbox.push(sessionsReply('wrong-id'))
    await assert.rejects(f.stream.next(), { code: 'invalid_reply' }); await rejected
    assert.equal(f.tools.size, 0)
  } finally { await f.close() }
})
