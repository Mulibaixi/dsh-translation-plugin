import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createQuickHostFixture } from './quick-host-fixture.mjs'
import { PLUGIN_REMOTE } from '../dist/shared/plugin-remote.js'
import { TopicBridgeClient } from '../dist/client/topic-bridge.js'

/** Actual installed Agent/Loop/Tools/SessionController/Gateway and ClientRemoteService.
 * Unused image/upload/workspace ports are inert; this fixture never touches real profiles or a network.
 */
export async function createTopicToolsNativeFixture({ runtimeRoot, mountContribution = true }) {
  const host = await createQuickHostFixture({ runtimeRoot, installationDependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' } })
  const [agents, loop, tools, prompts, projections, query, controller, { Context }, { TypertRegistry }, clientGateway, { OperatorPeer }] = await Promise.all([
    host.native('@deepseek-ai/dsh-agent'), host.native('@deepseek-ai/dsh-agent-loop'), host.native('@deepseek-ai/dsh-tools'),
    host.native('@deepseek-ai/dsh-system-prompt'), host.native('@deepseek-ai/dsh-session-projection'), host.native('@deepseek-ai/dsh-session-query'),
    host.native('@deepseek-ai/dsh-api-session-controller'), host.native('@deepseek-ai/cordis'), host.native('@deepseek-ai/dsh-typert-registry'),
    import(pathToFileURL(join(resolve(runtimeRoot, 'dsh/node_modules'), '@deepseek-ai/dsh-api-gateway/lib/types/client/index.js')).href),
    host.native('@deepseek-ai/dsh-client-connection'),
  ])
  // Import the explicit public client entry from the same extracted package tree.
  const clientModule = clientGateway
  const ctx = host.ctx
  await ctx.plugin(agents.AgentRegistry)
  await ctx.plugin(prompts.SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(tools.ToolRuntime, { mode: 'native' })
  await ctx.plugin(projections.SessionProjectionRegistry)
  await ctx.plugin(query.SessionQueryEngine)
  await ctx.plugin(loop.AgentLoop, { agents: [], maxParallelToolCalls: 10 })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'model-a' }) })
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] } })
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
  ctx.provide('fs', {})
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
  await ctx.plugin(controller.SessionController, { nativeOpen: false })
  assert.equal(ctx.translationTopics.capabilities().ready, true)
  const client = new Context(), peer = new OperatorPeer(ctx), requests = [], replies = [], carrierErrors = []
  client.provide('connection', {
    rpc: {
      async call(path, endpoint, payload, signal) { assert.equal(path, '/api'); return ctx.typertGateway.dispatchRpc(endpoint, payload, signal, peer) },
      async *open(path, endpoint, payload, signal, uplink) {
        assert.equal(path, '/api'); assert.equal(endpoint, 'translationTopics/connect')
        const observed = { async *[Symbol.asyncIterator]() { for await (const item of uplink) { replies.push(structuredClone(item)); yield item } } }
        try {
          const source = await ctx.typertGateway.openWireStream(endpoint, payload, observed, peer, signal, new AbortController())
          for await (const item of source) { if (item.kind === 'request') requests.push(structuredClone(item)); yield item }
        } catch (error) { carrierErrors.push(error); throw error }
      },
    },
    registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
  })
  await client.plugin(TypertRegistry)
  await client.plugin(clientModule)
  const unmount = mountContribution ? await client.remote.$mount(PLUGIN_REMOTE) : undefined
  const bridges = []
  return { host, client, requests, replies, carrierErrors, get remote() { return client.remote.translationTopics },
    async createAgent(sessionId) { return ctx.agents.create({ sessionId, agentOptions: { provider: 'synthetic', model: 'model-a' } }) },
    bridge(sessions, terms, archive) { const bridge = new TopicBridgeClient(client.remote.translationTopics, sessions, terms, archive); bridges.push(bridge); return bridge },
    async close() { for (const bridge of bridges) await bridge.dispose(); await unmount?.(); await client.fiber.dispose(); await host.dispose() },
  }
}

export async function waitTopicReady(bridge, ownerId, errors = []) {
  for (let i = 0; i < 100; i++) {
    if (bridge.getStatus(ownerId).ready) return
    if (bridge.getStatus(ownerId).reason) throw new AggregateError(errors, bridge.getStatus(ownerId).reason)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Synthetic management connection did not become ready')
}
