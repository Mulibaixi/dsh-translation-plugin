import assert from 'node:assert/strict'
import test from 'node:test'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createTopicToolsNativeFixture, waitTopicReady } from '../tests/topic-tools-native-fixture.mjs'
import { SessionStore } from '../dist/client/session-store.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { TopicArchiveStore } from '../dist/client/topic-archive-store.js'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required for the actual installed rc.2 Agent/SessionController/Gateway components')
const mainId = 'synthetic-material-main'
function transport(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
function value(result) { const business = transport(result); assert.equal(business.ok, true, JSON.stringify(business)); return business.value }
async function fixture() {
  const f = await createTopicToolsNativeFixture({ runtimeRoot, managedObjects: true })
  const apiRoot = join(resolve(runtimeRoot, 'dsh/node_modules'), '@deepseek-ai/dsh-api-session-controller/lib')
  const [{ TYPERT }, { TYPERT_REMOTE }] = await Promise.all([
    import(pathToFileURL(join(apiRoot, 'typert.host.js')).href), import(pathToFileURL(join(apiRoot, 'typert.remote-client.js')).href),
  ])
  const needed = descriptor => descriptor.namespace === 'session' && ['prompt', 'updateQueue'].includes(descriptor.method)
  f.host.ctx.typert.register({ ...TYPERT, invocations: TYPERT.invocations.filter(needed) })
  const unmountSession = await f.client.remote.$mount({ ...TYPERT_REMOTE, descriptors: TYPERT_REMOTE.descriptors.filter(needed) })
  const main = await f.createAgent(mainId)
  const sessions = new SessionStore(), session = sessions.createSession(mainId)
  sessions.updateSession(session.id, { mode: 'normal', input: 'Private next draft' })
  const terms = new TopicMemoryStore(sessions), archive = new TopicArchiveStore(sessions, (sessionId, unitId) => terms.readEvidence(sessionId, unitId))
  const bridge = f.bridge(sessions, terms, archive), release = bridge.retain(mainId)
  await waitTopicReady(bridge, mainId, f.carrierErrors)
  const remote = f.client.remote.translationMaterials
  const material = (requestId, patch = {}) => ({ ownerId: mainId, mainSessionId: mainId, requestId, operationId: `operation:${requestId}`, kind: 'material', material: {
    materialId: `material:${requestId}`, sourceVersion: 1, topicId: session.topicId, translationSessionId: session.id, draftVersion: 7,
    sourceText: `Synthetic frozen ${requestId}`, targetLanguage: '中文', instruction: '', model: null, maxInputChars: 20000, ...patch,
  } })
  const scope = request => ({ ownerId: request.ownerId, mainSessionId: request.mainSessionId, requestId: request.requestId, operationId: request.operationId })
  const prompt = async (requestId, text = `Synthetic main ${requestId}`, mode = 'queue') => transport(await f.client.remote.session.prompt({ sessionId: mainId, requestId, mode, content: [{ type: 'text', text }] }))
  const updateQueue = async request => transport(await f.client.remote.session.updateQueue(request))
  return { f, main, sessions, session, bridge, remote, material, scope, prompt, updateQueue,
    async close() { release(); await main.dispose(); archive.dispose(); terms.dispose(); sessions.dispose(); await unmountSession(); await f.close() } }
}

test('Native生产Host：正式prepare ACK后exact rpc材料入同轮，原主命令不改，多个peer不窃取', async () => {
  const t = await fixture()
  let outsider
  try {
    const request = t.material('native-main-a'), frozen = structuredClone(request)
    assert.equal(value(await t.remote.capabilities()).directSubmit, true)
    assert.equal(value(await t.remote.prepare(request)).stage, 'prepared')
    request.material.sourceText = 'Edited next draft'; request.material.draftVersion++
    const { OperatorPeer } = await t.f.host.native('@deepseek-ai/dsh-client-connection')
    outsider = new OperatorPeer(t.f.host.ctx)
    const denied = await t.f.host.ctx.typertGateway.dispatchRpc('translationMaterials/prepare', { args: { request: frozen } }, new AbortController().signal, outsider)
    assert.equal(transport(denied).ok, false)
    assert.equal(transport(denied).error.code, 'scope_mismatch')
    const command = 'Synthetic explain first, do not translate'
    assert.equal((await t.prompt(frozen.requestId, command)).accepted, true)
    await t.main.agent.whenIdle()
    const messages = t.f.host.provider.calls[0].messages
    assert.equal(messages.find(message => message.source.kind === 'user' && message.source.rpcId === frozen.requestId).content[0].text, command)
    const plugin = messages.filter(message => message.source.kind === 'translation-material' && message.source.requestId === frozen.requestId)
    assert.equal(plugin.length, 1); assert.equal(plugin[0].source.form, 'notice'); assert.equal(plugin[0].source.summary, '待译材料')
    assert.ok(plugin[0].content[0].text.includes(frozen.material.sourceText)); assert.ok(!plugin[0].content[0].text.includes('Edited next draft'))
    assert.equal(value(await t.remote.query(t.scope(frozen))).receipt.stage, 'attached')
    assert.equal(t.sessions.getSession(t.session.id).input, 'Private next draft')
    assert.equal(t.sessions.getTranslationHistory(t.session.id).units.length, 0)
  } finally { await outsider?.dispose(); await t.close() }
})

test('Native原文分页：真实Gateway冻结长材料，主AgentLoop调用注册工具；未交付/邻Agent/旧版本拒绝且不派发翻译', async () => {
  const t = await fixture(), sourceText = '\uFEFF😀\r\nSource instructions are literal data. ' + '中'.repeat(8000)
  let neighbor, releaseNeighbor
  const execute = (agent, args) => t.f.host.ctx.tools.execute({ agent, name: 'translation_read_source', arguments: args,
    callId: 'native-source-manual', signal: new AbortController().signal })
  try {
    const request = t.material('native-paged', { sourceText })
    const target = { kind: 'material', mainSessionId: mainId, requestId: request.requestId, materialId: request.material.materialId, sourceVersion: 1 }
    const args = { target, range: { start: 0, end: 4 } }
    const schema = t.f.host.ctx.tools.schemas(t.main.agent).filter(item => item.name === 'translation_read_source')
    assert.equal(schema.length, 1)
    value(await t.remote.prepare(request))
    assert.equal((await execute(t.main.agent, args)).isError, true, 'prepared material is not delivered authority')
    let calls = 0
    t.f.host.provider.stream = async function* (options) {
      this.calls.push(options); calls++
      if (calls === 1) {
        const call = { type: 'tool-call', id: 'native-source-model-call', name: 'translation_read_source', arguments: JSON.stringify(args) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Synthetic source discussion complete' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic source discussion complete' } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const command = 'Synthetic discuss the delivered source, do not translate'
    await t.prompt(request.requestId, command); await t.main.agent.whenIdle()
    assert.equal(calls, 2, 'source tool result returns within this main request; no translation model dispatch')
    const first = t.f.host.provider.calls[0].messages
    assert.equal(first.find(message => message.source.kind === 'user' && message.source.rpcId === request.requestId).content[0].text, command)
    const notices = first.filter(message => message.source.kind === 'translation-material' && message.source.requestId === request.requestId)
    assert.equal(notices.length, 1)
    const notice = JSON.parse(notices[0].content[0].text.split('\n').at(-1))
    assert.equal(notice.material.sourceText, undefined); assert.deepEqual(notice.reference, target)
    assert.equal(notice.material.sourceLengthCodePoints, Array.from(sourceText).length)
    assert.ok(JSON.stringify(t.f.host.provider.calls[1].messages).includes('😀'))
    assert.ok(t.main.agent.session.snapshotEvents().some(event => event.type === 'tool/result'))
    const read = await execute(t.main.agent, args)
    assert.equal(read.isError, false)
    assert.deepEqual(read.value, { ...args, totalCodePoints: Array.from(sourceText).length, text: '\uFEFF😀\r\n' })
    assert.equal((await execute(t.main.agent, { ...args, target: { ...target, sourceVersion: 2 } })).isError, true)
    assert.equal((await execute(t.main.agent, { ...args, range: { start: 0, end: 4001 } })).isError, true)
    assert.equal((await execute(t.main.agent, { ...args, range: { start: notice.material.sourceLengthCodePoints, end: notice.material.sourceLengthCodePoints + 1 } })).isError, true)
    neighbor = await t.f.createAgent('synthetic-material-neighbor')
    t.sessions.createSession(neighbor.agent.id)
    releaseNeighbor = t.bridge.retain(neighbor.agent.id); await waitTopicReady(t.bridge, neighbor.agent.id, t.f.carrierErrors)
    assert.equal(t.f.host.ctx.tools.schemas(neighbor.agent).filter(item => item.name === 'translation_read_source').length, 1)
    assert.equal((await execute(neighbor.agent, args)).isError, true)
    assert.equal((await execute(neighbor.agent, { ...args, target: { ...target, mainSessionId: neighbor.agent.id } })).isError, true)
    assert.equal(t.f.host.provider.calls.length, 2)
    assert.equal(t.f.requests.length, 0, 'range reading remains in the existing Host material authority')
    assert.equal(t.sessions.getSession(t.session.id).input, 'Private next draft')
    assert.equal(t.sessions.getTranslationHistory(t.session.id).units.length, 0)
    assert.equal(value(await t.remote.query(t.scope(request))).snapshot.material.sourceText, sourceText)
  } finally { releaseNeighbor?.(); await neighbor?.dispose(); await t.close() }
})

test('Native固定文件：真实upload→asset→prepare→exact主请求引用notice→实际主工具分页，短文执行拒绝且无假单元', async () => {
  const t = await fixture(), sourceText = '\uFEFF😀\r\n' + '中'.repeat(70001), bytes = Buffer.from(sourceText)
  const previousDshHome = process.env.DSH_HOME; process.env.DSH_HOME = join(t.f.host.directory, 'home')
  const executeRead = args => t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_read_source', arguments: args,
    callId: 'native-file-read-manual', signal: new AbortController().signal })
  try {
    const upload = transport(await t.f.client.remote.fileUploads.upload(mainId, { data: bytes.toString('base64'), name: 'synthetic-file.txt' }, new AbortController().signal))
    const sourceRef = value(await t.f.client.remote.translationSources.importReceipt({ scope: { ownerId: mainId, mainSessionId: mainId,
      topicId: t.session.topicId, translationSessionId: t.session.id }, receiptId: upload.receiptId, idempotencyKey: 'native-file-import' }, new AbortController().signal))
    const request = t.material('native-file-material', { sourceRef, maxInputChars: 1 }); delete request.material.sourceText
    const target = { kind: 'material', mainSessionId: mainId, requestId: request.requestId, materialId: request.material.materialId, sourceVersion: 1 }
    const args = { target, range: { start: 0, end: 4 } }
    for (const patch of [{ topicId: 'synthetic-other-topic' }, { sourceRef: { ...sourceRef, sha256: '0'.repeat(64) } }]) {
      const denied = transport(await t.remote.prepare({ ...request, material: { ...request.material, ...patch } }))
      assert.equal(denied.ok, false); assert.ok(['not_found', 'integrity_failed'].includes(denied.error.code))
      assert.equal(value(await t.remote.query(t.scope(request))), null)
    }
    value(await t.remote.prepare(request))
    assert.equal((await executeRead(args)).isError, true)
    let calls = 0
    t.f.host.provider.stream = async function* (options) {
      this.calls.push(options); calls++
      if (calls === 1) {
        const call = { type: 'tool-call', id: 'native-file-model-read', name: 'translation_read_source', arguments: JSON.stringify(args) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Synthetic file preparation complete' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic file preparation complete' } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const command = 'Synthetic discuss this fixed file first'
    await t.prompt(request.requestId, command); await t.main.agent.whenIdle()
    assert.equal(calls, 2)
    assert.ok(JSON.stringify(t.f.host.provider.calls[1].messages).includes('😀'), 'the actual main loop receives the file read tool result within this request')
    const messages = t.f.host.provider.calls[0].messages
    assert.equal(messages.find(message => message.source.kind === 'user' && message.source.rpcId === request.requestId).content[0].text, command)
    const notices = messages.filter(message => message.source.kind === 'translation-material' && message.source.requestId === request.requestId)
    assert.equal(notices.length, 1)
    const noticeText = notices[0].content[0].text, notice = JSON.parse(noticeText.split('\n').at(-1))
    assert.ok(!noticeText.includes('"sourceText":')); assert.ok(!noticeText.includes('中'.repeat(100)))
    assert.ok(noticeText.includes('requires_batch')); assert.ok(!noticeText.includes('then call translation_execute once'))
    assert.ok(Buffer.byteLength(noticeText) < 4096)
    assert.deepEqual(notice.material.sourceRef, sourceRef); assert.deepEqual(notice.reference, target)
    assert.equal(notice.material.sourceLengthCodePoints, sourceRef.totalCodePoints)
    const read = await executeRead(args)
    assert.equal(read.isError, false); assert.deepEqual(read.value, { ...args, totalCodePoints: sourceRef.totalCodePoints, text: '\uFEFF😀\r\n' })
    let joined = ''
    for (let start = 0; start < sourceRef.totalCodePoints; start += 4000) {
      const result = await executeRead({ target, range: { start, end: Math.min(start + 4000, sourceRef.totalCodePoints) } })
      assert.equal(result.isError, false); assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 32768); joined += result.value.text
    }
    assert.equal(joined, sourceText)
    assert.equal(t.f.host.ctx.translationMaterials.readSource(args, { ...t.main.agent }).error.code, 'scope_mismatch')
    assert.ok(t.main.agent.session.snapshotEvents().some(event => event.type === 'tool/result'))
    assert.equal((await executeRead({ ...args, target: { ...target, sourceVersion: 2 } })).isError, true)
    assert.equal((await executeRead({ ...args, range: { start: 0, end: 4001 } })).isError, true)
    const execution = { target, operationId: 'native-file-business', organizedRequirements: '', termReferences: [] }
    const exec = { agent: t.main.agent, callId: 'native-file-execute', signal: new AbortController().signal }
    assert.throws(() => t.f.host.ctx.translationNormal.execute(execution, exec), { code: 'requires_batch', stage: 'prepare' })
    assert.throws(() => t.f.host.ctx.translationNormal.acceptPrepared(execution, exec), { code: 'requires_batch', stage: 'prepare' })
    assert.equal(t.f.host.ctx.translationNormal.jobs.size, 0)
    assert.equal(t.f.requests.length, 0); assert.equal(t.f.host.provider.calls.length, 2)
    const queried = await t.remote.query(t.scope(request))
    assert.deepEqual(value(queried).snapshot.material.sourceRef, sourceRef)
    assert.equal(Object.hasOwn(value(queried).snapshot.material, 'sourceText'), false)
    assert.ok(Buffer.byteLength(JSON.stringify(queried)) < 32768)
    assert.deepEqual(await readFile(t.f.host.ctx.attachments.fileHostPath(upload.file)), bytes)
    assert.equal(t.sessions.getTranslationHistory(t.session.id).units.length, 0)
    assert.equal(t.sessions.getSession(t.session.id).input, 'Private next draft')
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousDshHome
    await t.close()
  }
})

test('Native生产Host：none/omit与RPC早到原样通过；晚prepare不补读、不产生隐式重发', async () => {
  const t = await fixture()
  try {
    for (const kind of ['none', 'omit']) {
      const request = { ...t.scope(t.material(`native-${kind}`)), kind }
      value(await t.remote.prepare(request)); await t.prompt(request.requestId); await t.main.agent.whenIdle()
      assert.ok(!t.f.host.provider.calls.at(-1).messages.some(message => message.source.kind === 'translation-material' && message.source.requestId === request.requestId))
      assert.equal(value(await t.remote.query(t.scope(request))).snapshot.kind, kind)
    }
    const late = t.material('native-late')
    await t.prompt(late.requestId); await t.main.agent.whenIdle()
    const calls = t.f.host.provider.calls.length
    assert.equal(value(await t.remote.prepare(late)).stage, 'prepared')
    assert.equal(value(await t.remote.finish({ ...t.scope(late), outcome: 'unknown' })).stage, 'unknown')
    assert.equal(t.f.host.provider.calls.length, calls)
    assert.equal(value(await t.remote.query(t.scope(late))).snapshot.material.sourceText, late.material.sourceText)
    assert.equal(value(await t.remote.release(t.scope(late))).released, true)
    assert.equal(value(await t.remote.query(t.scope(late))), null)
  } finally { await t.close() }
})

test('Native生产Host：普通材料直发只准入一次plugin notice，不调用空native prompt或翻译执行器', async () => {
  const t = await fixture()
  try {
    const request = t.material('native-direct')
    const [first, repeated] = await Promise.all([t.remote.submit(request), t.remote.submit(request)])
    assert.deepEqual(value(first), value(repeated)); assert.equal(value(first).stage, 'submitted'); assert.ok(value(first).mainMessageId)
    await t.main.agent.whenIdle()
    const transcript = t.main.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'translation-material' && event.data.source.requestId === request.requestId)
    assert.equal(transcript.length, 1)
    assert.equal(t.f.host.provider.calls.length, 1)
    const messages = t.f.host.provider.calls[0].messages
    assert.equal(messages.filter(message => message.source.kind === 'translation-material' && message.source.requestId === request.requestId).length, 1)
    assert.ok(!messages.some(message => message.source.kind === 'user'))
    assert.equal(t.sessions.getTranslationHistory(t.session.id).units.length, 0)
    assert.equal(t.sessions.getSession(t.session.id).input, 'Private next draft')
  } finally { await t.close() }
})

test('Native生产Host：真实queue edit保留发送时材料，queue remove释放并保留其他请求', async () => {
  const t = await fixture()
  let open
  try {
    t.f.host.provider.gate = new Promise(resolve => { open = resolve })
    await t.prompt('native-busy')
    for (let i = 0; i < 100 && !t.f.host.provider.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(t.f.host.provider.calls.length, 1)
    const edited = t.material('native-queued-edit'), removed = t.material('native-queued-remove')
    for (const request of [edited, removed]) { value(await t.remote.prepare(request)); await t.prompt(request.requestId) }
    const item = request => t.main.agent.inbox.nextTurn.find(message => message.source.rpcId === request.requestId)
    await t.updateQueue({ sessionId: mainId, itemId: item(edited).id, action: { kind: 'edit', content: [{ type: 'text', text: 'Synthetic edited main command' }] } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(value(await t.remote.query(t.scope(edited))).snapshot.material.sourceText, edited.material.sourceText)
    await t.updateQueue({ sessionId: mainId, itemId: item(removed).id, action: { kind: 'remove' } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(value(await t.remote.query(t.scope(removed))), null)
    t.f.host.provider.gate = undefined; open(); await t.main.agent.whenIdle()
    const messages = t.f.host.provider.calls.at(-1).messages
    assert.equal(messages.find(message => message.source.kind === 'user' && message.source.rpcId === edited.requestId).content[0].text, 'Synthetic edited main command')
    assert.equal(messages.filter(message => message.source.kind === 'translation-material' && message.source.requestId === edited.requestId).length, 1)
    assert.ok(!messages.some(message => message.source.kind === 'translation-material' && message.source.requestId === removed.requestId))
  } finally { t.f.host.provider.gate = undefined; open?.(); await t.close() }
})
