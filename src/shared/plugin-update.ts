import { referenceExact, referenceObject, referenceString } from './reference-memory.js'

export const TRANSLATION_PACKAGE = 'dsh-translation-plugin'
export const TRANSLATION_RELEASES = 'https://github.com/Mulibaixi/dsh-translation-plugin/releases'
export const UPDATE_BUSY_MESSAGE = '翻译或批处理任务正在运行。请在任务结束后重新点击更新。'
export const INSTALL_BUSY_MESSAGE = '翻译插件正在安装更新。请在安装结束后重试。'

export const UPDATE_PHASES = ['downloading', 'verifying', 'installing'] as const
export type UpdatePhase = typeof UPDATE_PHASES[number]
export interface UpdateInfo {
  currentVersion: string
  state: 'ready' | 'manual' | 'restart-required' | 'activation-failed'
  installedVersion?: string
  phase?: UpdatePhase
}

export interface UpdateFailure { status: 'failed'; message: string }
export type UpdateCheck = { status: 'current' } | { status: 'available'; version: string } | UpdateFailure
export type UpdateResult = { status: 'applied' | 'restart-required'; version: string } | UpdateFailure

export interface PluginUpdateRemote {
  info(): Promise<unknown>
  check(): Promise<unknown>
  installUpdate(version: string): Promise<unknown>
}

export function releasePage(version: string): string {
  return `${TRANSLATION_RELEASES}/tag/v${encodeURIComponent(version)}`
}

export function releaseDownload(version: string): string {
  return `${TRANSLATION_RELEASES}/download/v${encodeURIComponent(version)}/${TRANSLATION_PACKAGE}-${encodeURIComponent(version)}.tgz`
}

function codec(name: string, parse: (value: unknown) => unknown) {
  return { mode: 'strict' as const, typeSymbol: `${TRANSLATION_PACKAGE}#pluginUpdate/${name}`, create: () => ({ parse }) }
}

function resultCodec(method: 'check' | 'installUpdate') {
  return codec(method, value => {
    referenceObject(value)
    if (value.status === 'failed') {
      referenceExact(value, ['status', 'message']); referenceString(value.message)
    } else if (method === 'check' && value.status === 'current') {
      referenceExact(value, ['status'])
    } else if (method === 'check' ? value.status === 'available' : value.status === 'applied' || value.status === 'restart-required') {
      referenceExact(value, ['status', 'version']); referenceString(value.version)
    } else {
      throw new TypeError('Invalid plugin update result')
    }
    return value
  })
}

const service = 'translationPluginUpdate'
const descriptor = (method: string) => ({ id: `${TRANSLATION_PACKAGE}#${service}/${method}`, service, namespace: service, method, invocation: { kind: 'direct' as const } })
export const PLUGIN_UPDATE_REMOTE = {
  package: TRANSLATION_PACKAGE,
  descriptors: [
    { ...descriptor('info'), parameters: [], result: codec('info', value => {
      referenceObject(value); referenceExact(value, ['currentVersion', 'state'], ['installedVersion', 'phase'])
      referenceString(value.currentVersion)
      if (!['ready', 'manual', 'restart-required', 'activation-failed'].includes(String(value.state))) throw new TypeError('Invalid plugin update state')
      if (value.installedVersion !== undefined) referenceString(value.installedVersion)
      if (value.phase !== undefined && !UPDATE_PHASES.some(phase => phase === value.phase)) throw new TypeError('Invalid plugin update phase')
      return value
    }) },
    { ...descriptor('check'), parameters: [], result: resultCodec('check') },
    { ...descriptor('installUpdate'), parameters: [{ name: 'version', wire: 'version', source: 'json' as const,
      codec: codec('version', value => { referenceString(value); return value }) }], result: resultCodec('installUpdate') },
  ],
}
