import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { list } from 'tar'
import { INSTALL_BUSY_MESSAGE, TRANSLATION_PACKAGE, TRANSLATION_RELEASES, UPDATE_BUSY_MESSAGE, releaseDownload,
  type UpdateCheck, type UpdateFailure, type UpdateInfo, type UpdatePhase, type UpdateResult } from '../shared/plugin-update.js'
import { translationTasksActive } from './plugin-update-gate.js'

const composerPackage = 'dsh-composer-extension'
const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url))
const checksumUrl = `${TRANSLATION_RELEASES}/latest/download/SHA256SUMS.txt`
const bundleLimit = 64 * 1024 * 1024
const manifestLimit = 64 * 1024

type Release = { version: string; sha256: string }
type Peer = { readonly id: string; readonly principal?: { readonly kind: string } }
type Host = {
  readonly baseUrl?: string
  readonly invocation?: { readonly peer: Peer; readonly signal?: AbortSignal }
  get?(name: string): unknown
}
interface Bundle {
  name: string
  version?: string
  source?: string
  installed: boolean
  enabled: boolean
  availability?: string
  readOnlyReason?: string
  error?: unknown
}
interface PluginManager {
  listBundles(): Promise<Bundle[]>
  installBundle(path: string, options: { enabled: true; expected: { name: string; version: string } }): Promise<{
    application: string; stage?: string; bundle?: string; version?: string
  }>
}
interface PackageManifest {
  name?: string
  version?: string
  dsh?: { bundle?: { patch?: string } }
  engines?: { dsh?: string }
  peerDependencies?: Record<string, string>
}

function failed(message: string): UpdateFailure { return { status: 'failed', message } }

export function parseReleaseChecksums(text: string): Release {
  const matches = text.split(/\r?\n/u).flatMap(line => {
    const match = /^([A-Fa-f\d]{64})[\t ]+\*?dsh-translation-plugin-(\d+\.\d+\.\d+)\.tgz[\t ]*$/u.exec(line)
    return match?.[1] && match[2] && semver.valid(match[2]) ? [{ version: match[2], sha256: match[1].toLowerCase() }] : []
  })
  if (matches.length !== 1) throw new Error('Invalid release checksum')
  return matches[0]!
}

async function download(url: string, limit: number, timeout: number, parent?: AbortSignal): Promise<Buffer> {
  const deadline = AbortSignal.timeout(timeout)
  const response = await fetch(url, { signal: parent ? AbortSignal.any([parent, deadline]) : deadline })
  if (!response.ok || !response.body) throw new Error('Release download failed')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, length)
      length += value.length
      if (length > limit) throw new Error('Release download exceeds size limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function packageManifest(bytes: Buffer): Promise<PackageManifest> {
  const chunks: Buffer[] = []
  let found = false, invalid = false
  await pipeline(Readable.from([bytes]), list({ strict: true, filter: path => path === 'package/package.json', onReadEntry(entry) {
    if (found || entry.type !== 'File' || entry.size > manifestLimit) { invalid = true; return }
    found = true
    entry.on('data', (chunk: Buffer) => chunks.push(chunk))
  } }))
  if (!found || invalid) throw new Error('Invalid package manifest entry')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as PackageManifest
}

function isTarball(source: string | undefined): boolean {
  if (!source) return false
  if (isAbsolute(source)) return source.toLowerCase().endsWith('.tgz')
  try {
    const url = new URL(source)
    return ['file:', 'https:', 'http:'].includes(url.protocol) && url.pathname.toLowerCase().endsWith('.tgz')
  } catch { return false }
}

function updateable(bundle: Bundle | undefined): boolean {
  return bundle?.installed === true && bundle.enabled && bundle.availability !== 'installation' &&
    !bundle.readOnlyReason && isTarball(bundle.source)
}

async function hostModule<T>(ctx: Host, name: string): Promise<T> {
  const loader = ctx.get?.('loader') as { internal?: { import(name: string, anchor: string, options: object): Promise<unknown> } } | undefined
  if (!loader?.internal || !ctx.baseUrl) throw new Error('DSH update support unavailable')
  return await loader.internal.import(name, ctx.baseUrl, {}) as T
}

/** Release discovery and installation run on the same Host as the profile manager. */
export class PluginUpdateService {
  readonly typertRemote: { service: PluginUpdateService; serviceKey: 'translationPluginUpdate'; namespace: 'translationPluginUpdate' } =
    { service: this, serviceKey: 'translationPluginUpdate', namespace: 'translationPluginUpdate' }
  private readonly offers = new WeakMap<Peer, Release>()
  private readonly lifetime = new AbortController()
  private currentVersion?: Promise<string>
  private phase: UpdatePhase | undefined

  constructor(private readonly ctx: Host) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationPluginUpdate', property: 'ctx' } })
  }

  dispose(): void { this.lifetime.abort() }
  isInstalling(): boolean { return this.phase === 'installing' }

  private version(): Promise<string> {
    return this.currentVersion ??= readFile(manifestPath, 'utf8').then(raw => (JSON.parse(raw) as { version: string }).version)
  }

  private manager(): PluginManager | undefined {
    if (this.ctx.invocation?.peer.principal?.kind !== 'owner') return undefined
    const manager = this.ctx.get?.('pluginManager') as PluginManager | undefined
    return typeof manager?.listBundles === 'function' && typeof manager.installBundle === 'function' ? manager : undefined
  }

  private profileDirectory(): string | undefined {
    return (this.ctx.get?.('profileContext') as { dir?: string } | undefined)?.dir
  }

  async info(): Promise<UpdateInfo> {
    const currentVersion = await this.version()
    const manager = this.manager()
    if (!manager || !this.profileDirectory()) return { currentVersion, state: 'manual' }
    if (this.phase) return { currentVersion, state: 'ready', phase: this.phase }
    try {
      const installed = (await manager.listBundles()).find(bundle => bundle.name === TRANSLATION_PACKAGE)
      if (installed?.installed && installed.version && installed.version !== currentVersion) {
        return { currentVersion, installedVersion: installed.version, state: installed.error ? 'activation-failed' : 'restart-required' }
      }
      return { currentVersion, state: updateable(installed) ? 'ready' : 'manual' }
    } catch { return { currentVersion, state: 'manual' } }
  }

  async check(): Promise<UpdateCheck> {
    const invocation = this.ctx.invocation
    if (invocation?.peer.principal?.kind !== 'owner') return failed('当前宿主连接无法检查更新，请打开发行页面查看版本。')
    this.offers.delete(invocation.peer)
    try {
      const signal = invocation.signal ? AbortSignal.any([invocation.signal, this.lifetime.signal]) : this.lifetime.signal
      const bytes = await download(checksumUrl, 16 * 1024, 15_000, signal)
      const release = parseReleaseChecksums(bytes.toString('utf8'))
      if (!semver.gt(release.version, await this.version())) return { status: 'current' }
      this.offers.set(invocation.peer, release)
      return { status: 'available', version: release.version }
    } catch { return failed('检查更新失败。请检查 GitHub 连接，或打开发行页面查看版本。') }
  }

  async installUpdate(version: string): Promise<UpdateResult> {
    const invocation = this.ctx.invocation, manager = this.manager(), profile = this.profileDirectory()
    if (!invocation || !manager || !profile) return failed('请在 DSH 插件管理器中手动更新。')
    if (this.phase) return failed('已有更新请求正在处理。')
    if (translationTasksActive(this.ctx)) return failed(UPDATE_BUSY_MESSAGE)
    const release = this.offers.get(invocation.peer)
    if (!release || release.version !== version) return failed('请重新检查更新，再选择要安装的版本。')

    this.phase = 'downloading'
    try {
      const current = await this.version()
      const bundles = await manager.listBundles()
      const initial = this.validateInstalled(bundles, current, version)
      if (initial) return initial
      if (translationTasksActive(this.ctx)) return failed(UPDATE_BUSY_MESSAGE)
      const signal = invocation.signal ? AbortSignal.any([invocation.signal, this.lifetime.signal]) : this.lifetime.signal
      const bytes = await download(releaseDownload(version), bundleLimit, 120_000, signal)
      this.phase = 'verifying'
      if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) return failed('安装包 SHA-256 校验失败。请重新检查更新。')
      const manifest = await packageManifest(bytes)
      if (manifest?.name !== TRANSLATION_PACKAGE || manifest.version !== version || typeof manifest.dsh?.bundle?.patch !== 'string' ||
        typeof manifest.engines?.dsh !== 'string' || !semver.validRange(manifest.engines.dsh)) return failed('安装包声明无效，请查看发行说明。')
      const boot = await hostModule<{ evaluatePluginCompatibility?: (manifest: PackageManifest) => unknown }>(this.ctx, '@deepseek-ai/dsh-app-boot')
      if (!boot.evaluatePluginCompatibility) return failed('当前 DSH 无法核对安装包兼容性，请在插件管理器中手动安装。')
      if (boot.evaluatePluginCompatibility(manifest)) return failed(`此版本需要 DSH ${manifest.engines.dsh}。请查看发行说明。`)
      const composerRange = manifest.peerDependencies?.[composerPackage]
      if (composerRange !== undefined && (typeof composerRange !== 'string' || !semver.validRange(composerRange))) return failed('安装包的 Composer 依赖声明无效。')
      const atomic = await hostModule<{ writeFileAtomic(path: string, data: Uint8Array, options: { mode: number; dirMode: number }): Promise<void> }>(this.ctx, '@deepseek-ai/dsh-atomic-write')
      const file = join(profile, 'translation-plugin-updates', `${TRANSLATION_PACKAGE}-${version}.tgz`)
      await atomic.writeFileAtomic(file, bytes, { mode: 0o600, dirMode: 0o700 })
      const latest = await manager.listBundles()
      const refusal = this.validateInstalled(latest, current, version)
      if (refusal) return refusal
      const composer = latest.find(bundle => bundle.name === composerPackage && bundle.installed && bundle.enabled && !bundle.error)
      if (composerRange && composer?.version && !semver.satisfies(composer.version, composerRange)) {
        return failed(`此版本需要 Composer ${composerRange}。请先按发行说明更新 Composer。`)
      }
      signal.throwIfAborted()

      // This check and the phase change must share a synchronous admission point with translation starts.
      if (translationTasksActive(this.ctx)) return failed(UPDATE_BUSY_MESSAGE)
      this.phase = 'installing'
      const result = await manager.installBundle(file, { enabled: true, expected: { name: TRANSLATION_PACKAGE, version } })
      if (result.application === 'applied' || result.application === 'restart-required') {
        // Some Hosts apply the profile but keep the old package fiber running.
        const reloaded = result.application === 'applied' && this.lifetime.signal.aborted
        return { status: reloaded ? 'applied' : 'restart-required', version }
      }
      if (result.stage === 'enable') return failed(`已安装 v${version}，但加载失败。请在 DSH 插件管理器中查看状态。`)
      return failed('安装未完成。请在 DSH 插件管理器中查看状态，或打开该版本的发行页面。')
    } catch {
      if (this.phase === 'installing') return failed('安装结果未确认。请查看 DSH 插件管理器中的安装状态。')
      return failed(this.phase === 'verifying' ? '无法校验或准备安装包。请查看发行说明。' : '下载更新失败。请检查连接后重试。')
    } finally { this.phase = undefined }
  }

  private validateInstalled(bundles: Bundle[], current: string, version: string): UpdateResult | undefined {
    const bundle = bundles.find(item => item.name === TRANSLATION_PACKAGE)
    if (!updateable(bundle) || !bundle?.version || !semver.valid(bundle.version)) return failed('当前安装来源请通过 DSH 插件管理器或源码流程更新。')
    if (bundle.version === version && bundle.version !== current) return bundle.error
      ? failed(`已安装 v${version}，但加载失败。请查看 DSH 插件管理器。`) : { status: 'restart-required', version }
    if (bundle.version !== current || !semver.gt(version, current)) return failed('当前安装版本已变化，请重新打开设置并检查更新。')
  }
}
