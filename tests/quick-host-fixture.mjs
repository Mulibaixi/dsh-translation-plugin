import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Native DSH fixture. runtimeRoot contains dsh/node_modules extracted from the target installation.
 * Run with --expose-internals, as required by DSH's own profile package resolver.
 * All profile files are synthetic and disposable; no real profile or credentials are read.
 */
export async function createQuickHostFixture({ runtimeRoot, pluginPath = fileURLToPath(new URL('..', import.meta.url)), omit = [], installationDependencies = {} }) {
  const modules = resolve(runtimeRoot, 'dsh/node_modules')
  const native = name => import(pathToFileURL(join(modules, name, 'lib/index.js')).href)
  const [{ Context }, { TypertRegistry }, { TypertGatewayService }, llm, { SessionStore }, { Loader }, boot, { OperatorPeer }] = await Promise.all([
    native('@deepseek-ai/cordis'), native('@deepseek-ai/dsh-typert-registry'), native('@deepseek-ai/dsh-api-gateway'),
    native('@deepseek-ai/dsh-llm'), native('@deepseek-ai/dsh-session'), native('@deepseek-ai/cordis-plugin-loader'),
    native('@deepseek-ai/dsh-app-boot'), native('@deepseek-ai/dsh-client-connection'),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'translation-native-'))
  const installation = join(directory, 'installation')
  const home = join(directory, 'home')
  const profileDir = join(home, 'profiles/synthetic')
  await mkdir(installation, { recursive: true })
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await symlink(modules, join(installation, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(pluginPath, join(profileDir, 'node_modules/dsh-translation-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
  const manifestPath = join(installation, 'package.json')
  await writeFile(manifestPath, JSON.stringify({ name: 'synthetic-dsh-installation', version: '0.2.0-rc.2', dependencies: {
    '@deepseek-ai/dsh-llm': '0.2.0-rc.2', '@deepseek-ai/dsh-session': '0.2.0-rc.2', '@deepseek-ai/dsh-api-gateway': '0.2.0-rc.2',
    '@deepseek-ai/dsh-typert-registry': '0.2.0-rc.2', '@deepseek-ai/cordis-plugin-loader': '~1.0.5',
    ...installationDependencies,
  } }))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'synthetic-dsh-profile', version: '1.0.0', dependencies: { 'dsh-translation-plugin': `link:${pluginPath}` } }))
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  const resolution = await boot.createRuntimeResolution({ installAnchor: manifestPath, home, profile: {
    dir: profileDir, skippedBundles: [], layers: [],
  } })
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(profileDir + '/').href
  let nativeEvents = 0
  for (const name of ['session/created', 'session/event', 'session/disposed', 'session/flush']) ctx.on(name, () => nativeEvents++)
  await ctx.plugin(boot.PluginPackages, { resolution })
  await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
  await ctx.plugin(TypertRegistry)
  if (!omit.includes('llm')) await ctx.plugin(llm.LlmRuntime)
  if (!omit.includes('sessions')) await ctx.plugin(SessionStore)
  if (!omit.includes('typertGateway')) await ctx.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 30000, streamInboxBytes: 1_000_000 })
  const sessions = []
  if (ctx.get('sessions')) {
    const original = ctx.sessions.prepare.bind(ctx.sessions)
    ctx.sessions.prepare = (...args) => { const session = original(...args); sessions.push(session); return session }
  }
  class SyntheticProvider extends llm.LlmAdapter {
    calls = []
    preparations = 0
    mode = 'success'
    catalog = ['model-a']
    gate
    prepareGate
    providerInfo(provider) { return { id: provider, name: 'Synthetic provider' } }
    async listModels(provider) { return this.catalog.map(id => ({ provider, id, name: id })) }
    async resolveModel(provider, id) {
      return { provider, id, name: id, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' }, defaultMaxTokens: 1024 }
    }
    async prepareCall(provider, id, signal) {
      this.preparations++
      if (this.prepareGate) await this.prepareGate
      signal?.throwIfAborted()
      return super.prepareCall(provider, id, signal)
    }
    async *stream(options) {
      this.calls.push(options)
      const mode = this.mode
      if (mode === 'throw') throw new llm.HarnessError('synthetic-private-provider-body secret-token', 'QUOTA')
      if (mode === 'tool') {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (!['delta-only', 'block-only'].includes(mode)) yield { type: 'block-start', index: 0, blockType: 'text' }
      if (mode !== 'block-only') yield { type: 'text-delta', index: 0, text: '合成译文' }
      if (this.gate) await Promise.race([this.gate, new Promise(resolve => {
        if (options.signal?.aborted) resolve()
        else options.signal?.addEventListener('abort', resolve, { once: true })
      })])
      if (mode !== 'delta-only') yield { type: 'block-end', index: 0, block: { type: 'text', text: mode === 'mismatched-block' ? '不同正文' : '合成译文' } }
      if (mode !== 'no-usage') yield { type: 'usage', usage: mode === 'zero-usage' ? { inputTokens: 0, outputTokens: 0 } : { inputTokens: 7, outputTokens: 4 } }
      if (mode !== 'missing-terminal') yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : mode === 'truncated' ? 'max-tokens' : 'stop' } }
    }
  }
  const provider = new SyntheticProvider()
  if (ctx.get('llm')) ctx.llm.registerAdapter(['synthetic'], provider)
  await ctx.loader.create({ id: 'translation-under-test', name: 'dsh-translation-plugin' })
  await ctx.loader.await()
  const service = ctx.translationQuick
  const peers = new Map(['operator-a', 'operator-b'].map(name => [name, new OperatorPeer(ctx)]))
  return {
    ctx, service, provider, directory, profileDir, resolution, sessions, native,
    get nativeEvents() { return nativeEvents },
    call(method, request, peer = 'operator-a') {
      return ctx.typertGateway.dispatchRpc(`translationQuick/${method}`, { args: request === undefined ? {} : { request } }, new AbortController().signal, peers.get(peer))
    },
    async dispose() {
      await ctx.fiber.dispose()
      const target = resolve(directory)
      assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('translation-native-'))
      // Unlink both junctions before recursive cleanup so dependencies and the external checkout remain intact.
      await unlink(join(profileDir, 'node_modules/dsh-translation-plugin'))
      await unlink(join(installation, 'node_modules'))
      await rm(target, { recursive: true, force: true })
    },
  }
}

export function unwrapQuickRemote(result) {
  if (!result.ok) throw new Error(`Native Gateway failed: ${result.error?.code}`)
  return result.value
}

export async function waitForQuick(fixture, query, peer, expectedStates) {
  for (let i = 0; i < 100; i++) {
    const result = unwrapQuickRemote(await fixture.call('status', query, peer))
    if (!result.ok || (expectedStates ? expectedStates.includes(result.value.status) : result.value.status !== 'running')) return result
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Synthetic execution did not settle')
}
