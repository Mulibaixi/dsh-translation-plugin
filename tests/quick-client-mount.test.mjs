import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'

const ok = value => ({ ok: true, value })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function remote() {
  const calls = { capabilities: 0, submit: [] }
  return { calls, port: {
    async capabilities() { calls.capabilities++; return ok(ok({ ready: true, mode: 'quick', storage: 'runtime_only' })) },
    async open(request) { return ok(ok({ ...request, sessionKey: 'quick:synthetic-mount' })) },
    async submit(request) { calls.submit.push(request); return ok(ok({ sessionKey: request.sessionKey, operationId: request.operationId, draftVersion: request.draftVersion, accepted: true, status: 'completed', text: 'Synthetic translation' })) },
  } }
}

test('真实bundle：等待异步mount后读取首次出现的namespace，可就绪并发送', async () => {
  const gate = deferred(); const rpc = remote(); const app = mount({ quick: rpc.port, mountGate: gate.promise })
  const ui = app.renderer
  try {
    assert.equal(app.remote.translationQuick, undefined)
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    assert.equal(ui.button('发送快译').props.disabled, true)
    assert.equal(rpc.calls.capabilities, 0)
    gate.resolve(); await ui.flush()
    assert.equal(app.remote.translationQuick, rpc.port)
    assert.equal(rpc.calls.capabilities, 1)
    await ui.click('模型：选择模型'); await ui.click('选择模型'); await ui.click('Model 1')
    await ui.input('待翻译内容', 'Synthetic source'); await ui.click('发送快译')
    assert.equal(rpc.calls.submit.length, 1)
    assert.match(ui.text(), /Synthetic translation/)
  } finally { gate.resolve(); await app.dispose() }
  assert.equal(app.unmountCalls, 1)
  assert.equal(app.remote.translationQuick, undefined)
})

test('真实bundle：mount拒绝被观察，显示连接失败，重检不会发送请求', async () => {
  const rpc = remote(); const app = mount({ quick: rpc.port, mountError: new Error('synthetic mount failure') })
  const ui = app.renderer
  try {
    // Let mounting fail before the UI requests capabilities: no unhandled rejection may escape.
    await new Promise(resolve => setImmediate(resolve))
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    assert.match(ui.button('发送快译').props.title, /无法连接快译服务/)
    assert.ok(!ui.text().includes('翻译执行尚未接入'))
    await ui.click('重新检查翻译服务')
    assert.equal(rpc.calls.capabilities, 0); assert.equal(rpc.calls.submit.length, 0)
  } finally { await app.dispose() }
  assert.equal(app.unmountCalls, 0)
})

test('真实bundle：mount尚未完成时卸载，等待真实disposer且不再访问RPC', async () => {
  const gate = deferred(); const rpc = remote(); const app = mount({ quick: rpc.port, mountGate: gate.promise })
  app.renderer.render(app.panel, { sessionId: 'synthetic-main' }); await app.renderer.flush()
  const disposing = app.dispose()
  assert.equal(app.unmountCalls, 0)
  gate.resolve(); await disposing
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(app.mountCalls, 1); assert.equal(app.unmountCalls, 1)
  assert.equal(app.remote.translationQuick, undefined)
  assert.equal(rpc.calls.capabilities, 0)
})
