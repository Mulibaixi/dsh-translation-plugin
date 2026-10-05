import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createQuickHostFixture } from '../tests/quick-host-fixture.mjs'
import { mount } from '../tests/quick-client-fixture.mjs'

// Real DSH ClientRemoteService + Cordis lifecycle + current plugin bundle.
// The Connection carrier only addresses the synthetic Host fixture; no real profile or network is used.
const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required; it must contain an external dsh/node_modules tree from DSH 0.2.0-rc.2')
const native = name => import(pathToFileURL(join(resolve(runtimeRoot, 'dsh/node_modules'), name)).href)
const [{ Context }, { TypertRegistry }, gateway] = await Promise.all([
  native('@deepseek-ai/cordis/lib/index.js'), native('@deepseek-ai/dsh-typert-registry/lib/index.js'),
  native('@deepseek-ai/dsh-api-gateway/lib/types/client/index.js'),
])
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function fixture({ mountGate } = {}) {
  const host = await createQuickHostFixture({ runtimeRoot })
  const ctx = new Context()
  const calls = []
  ctx.provide('connection', {
    rpc: {
      async call(path, endpoint, payload) {
        assert.equal(path, '/api'); assert.match(endpoint, /^translationQuick\//)
        calls.push({ endpoint, payload: structuredClone(payload) })
        return host.call(endpoint.split('/')[1], payload.args.request)
      },
      async *open() { throw new Error('Synthetic carrier does not open streams') },
    },
    registerGenerationSource() { return () => {} },
    start() { return { stop() {} } },
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(gateway)
  assert.equal(ctx.remote.translationQuick, undefined)
  if (mountGate) void ctx.remote.enqueue(() => mountGate.promise)
  let fiber
  const app = mount({ applyClient(plugin, mock) {
    ctx.provide('remote.session', { async modelCatalog() { return { ok: true, value: {
      default: null, failures: [], groups: [{ id: 'synthetic', name: 'Synthetic', models: [{ id: 'model-a', name: 'Synthetic Model' }] }],
    } } } })
    ctx.provide('slots', mock.slots)
    ctx.provide('sidebarRightTabs', mock.sidebarRightTabs)
    fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply(child) {
      plugin.apply(child)
      assert.equal(child.remote.translationQuick, undefined, 'actual $mount has not installed the namespace when apply returns')
    } })
    return fiber
  } })
  await app.applied
  return { app, ctx, host, calls, fiber, async close() {
    await app.dispose(); await ctx.fiber.dispose(); await host.dispose()
  } }
}

test('实际ClientRemoteService.$mount + 发布bundle：异步namespace可就绪、发送，禁用后完整卸载', async () => {
  const state = await fixture(); const { app, ctx, calls, host } = state; const ui = app.renderer
  try {
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    for (let i = 0; i < 100 && !calls.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 5)); await ui.flush()
    }
    assert.ok(ctx.remote.translationQuick)
    assert.ok(calls.length, `capabilities RPC was not called: ${ui.text()} / ${ui.button('发送快译').props.title}`)
    assert.equal(calls[0].endpoint, 'translationQuick/capabilities')
    await ui.click('模型：选择模型'); await ui.click('选择模型'); await ui.click('Synthetic Model')
    await ui.input('待翻译内容', 'Synthetic source'); await ui.click('发送快译')
    for (let i = 0; i < 100 && !ui.text().includes('合成译文'); i++) {
      await new Promise(resolve => setTimeout(resolve, 5)); await ui.flush()
    }
    assert.match(ui.text(), /合成译文/)
    assert.equal(host.provider.calls.length, 1)
    assert.equal(calls.filter(call => call.endpoint === 'translationQuick/submit').length, 1)
    ui.dispose(); await state.fiber.dispose()
    assert.equal(ctx.remote.translationQuick, undefined)
    assert.deepEqual(ctx.typert.remotes.list(), [])
  } finally { await state.close() }
})

test('实际ClientRemoteService.$mount + Cordis：挂载队列等待时禁用，晚到namespace与贡献被清理', async () => {
  const gate = deferred(); const state = await fixture({ mountGate: gate }); const { app, ctx, calls } = state
  try {
    app.renderer.render(app.panel, { sessionId: 'synthetic-main' }); await app.renderer.flush()
    assert.equal(ctx.remote.translationQuick, undefined)
    const disposing = state.fiber.dispose()
    gate.resolve(); await disposing
    assert.equal(ctx.remote.translationQuick, undefined)
    assert.deepEqual(ctx.typert.remotes.list(), [])
    assert.equal(calls.length, 0)
  } finally { gate.resolve(); await state.close() }
})
