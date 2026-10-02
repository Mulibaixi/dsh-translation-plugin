declare function require(moduleName: string): unknown

type Disposer = () => void
type ClientComponent = (props?: Readonly<Record<string, unknown>>) => unknown

interface ReactApi {
  createElement(
    type: string,
    props: Readonly<Record<string, unknown>> | null,
    ...children: unknown[]
  ): unknown
}

interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly title: (address: string) => string
  readonly guide: readonly SidebarRightGuideEntry[]
}

interface SidebarRightGuideEntry {
  readonly order: number
  readonly title: () => string
  readonly description: () => string
}

interface ClientPluginContext {
  readonly sidebarRightTabs: {
    register(definition: SidebarRightTabDefinition): Disposer
  }
  readonly slots: {
    register(
      target: { readonly name: string; readonly key: string },
      component: ClientComponent,
    ): Disposer
  }
  effect(effect: () => void | Disposer, name?: string): unknown
}

const react = require('react') as ReactApi
const CLIENT_ID = 'dsh-translation-plugin'

export const name = 'deepseek-translation-client'
export const inject = ['sidebarRightTabs', 'slots'] as const

function withClientDiagnostics<T>(stage: string, action: () => T): T {
  try {
    return action()
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error)
    console.error(`[${CLIENT_ID}] Client ${stage} failed: ${detail}`)
    throw error
  }
}

function TranslationPanel(): unknown {
  return react.createElement(
    'section',
    {
      className: 'dsh-translation-panel',
      'aria-labelledby': 'dsh-translation-panel-title',
    },
    react.createElement('h2', { id: 'dsh-translation-panel-title' }, '翻译工作区'),
    react.createElement(
      'p',
      null,
      '翻译面板框架已加载；输入、模型调用和译文保存功能将在后续步骤实现。',
    ),
  )
}

export function apply(ctx: ClientPluginContext): void {
  withClientDiagnostics('apply', () => {
    ctx.effect(
      () =>
        withClientDiagnostics('sidebarRightTabs.register', () =>
          ctx.sidebarRightTabs.register({
            id: CLIENT_ID,
            kind: 'translation-workspace',
            title: () => '翻译',
            guide: [{
              order: 40,
              title: () => '翻译工作区',
              description: () => '打开独立的翻译面板。',
            }],
          }),
        ),
      'translation tab type',
    )

    ctx.effect(
      () =>
        withClientDiagnostics('sidebar.right.pane.tab register', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: CLIENT_ID },
            TranslationPanel,
          ),
        ),
      'translation tab body',
    )
  })
}
