declare function require(moduleName: string): unknown

type StateSetter<T> = (value: T | ((current: T) => T)) => void

interface ReactApi {
  createElement(type: unknown, props: Readonly<Record<string, unknown>> | null, ...children: unknown[]): unknown
  useState<T>(initial: T | (() => T)): [T, StateSetter<T>]
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
  useRef<T>(initial: T): { current: T }
}

export const react = require('react') as ReactApi
export const h = react.createElement
