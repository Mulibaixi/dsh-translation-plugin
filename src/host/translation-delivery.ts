import { sourceSha256 } from './source-storage.js'
import type { QuickHostContext } from './quick-translation.js'
import type { SourceIdentity } from '../shared/translation-sources.js'

/** Private output directory for real translated artifacts; profile-wide data clear owns it too. */
export interface ArtifactStorage {
  readonly root: string
  write(name: string, content: string | Uint8Array): Promise<string>
  writePdf(name: string, source: SourceIdentity, signal: AbortSignal,
    build: (saveImage: (bytes: Uint8Array) => Promise<string>) => Promise<string>): Promise<{ path: string; besideOriginal: boolean }>
}
export async function loadArtifactStorage(ctx: QuickHostContext): Promise<ArtifactStorage> {
  const loader = ctx.get?.('loader') as QuickHostContext['loader']
  if (!ctx.baseUrl || !loader?.internal) throw new Error('Host package loader unavailable')
  const [home, atomic] = await Promise.all([
    loader.internal.import('@deepseek-ai/dsh-home-paths', ctx.baseUrl, {}) as Promise<{ dshHomePath(...parts: string[]): string }>,
    loader.internal.import('@deepseek-ai/dsh-atomic-write', ctx.baseUrl, {}) as Promise<{ writeFileAtomic(path: string, content: string | Uint8Array, options: { mode: number; dirMode: number }): Promise<void> }>,
  ])
  const fsName = 'node:fs/promises', pathName = 'node:path'
  const fs = await import(fsName) as {
    access(path: string): Promise<void>
    mkdir(path: string, options: { recursive: true }): Promise<unknown>
    open(path: string, flags: string, mode: number): Promise<{ writeFile(content: string | Uint8Array): Promise<void>; close(): Promise<void> }>
    readFile(path: string): Promise<Uint8Array>
    stat(path: string): Promise<{ size: number; isFile(): boolean }>
    unlink(path: string): Promise<void>
  }
  const path = await import(pathName) as { join(...parts: string[]): string; dirname(path: string): string; basename(path: string): string; isAbsolute(path: string): boolean }
  const root = home.dshHomePath('translation-plugin', 'outputs', 'v1')
  // Serialize with the profile-wide data clear; a cleared profile must not receive stale writes.
  const storageWriter = () => {
    const data = ctx.get?.('translationLocalData') as { storageWriter?: () => <U>(action: () => Promise<U>) => Promise<U> } | undefined
    return data?.storageWriter?.() ?? (<T>(action: () => Promise<T>): Promise<T> => action())
  }
  const written = new Map<string, string>()
  async function originalDirectory(source: SourceIdentity): Promise<string | undefined> {
    const original = source.originalFilePath
    if (!original || !path.isAbsolute(original)) return undefined
    try {
      const info = await fs.stat(original)
      if (info.isFile() && info.size === source.bytes && await sourceSha256(await fs.readFile(original)) === source.sha256)
        return path.dirname(original)
    } catch { /* The desktop origin may no longer be accessible. */ }
    return undefined
  }
  async function saveUnique(dir: string, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    await fs.mkdir(dir, { recursive: true })
    for (let number = 1; ; number++) {
      signal.throwIfAborted()
      const destination = path.join(dir, number === 1 ? name : name.replace(/(\.[^.]+)$/u, `-${number}$1`))
      const handle = await fs.open(destination, 'wx', 0o600).catch((error: { code?: string }) => {
        if (error.code === 'EEXIST') return undefined
        throw error
      })
      if (!handle) {
        const info = await fs.stat(destination).catch(() => undefined)
        if (!info?.isFile() || info.size !== bytes.length) continue
        const previous = await fs.readFile(destination).catch(() => undefined)
        if (previous?.length === bytes.length && previous.every((value, index) => value === bytes[index])) return destination
        continue
      }
      try {
        try { await handle.writeFile(bytes) } finally { await handle.close() }
      } catch (error) {
        await fs.unlink(destination).catch(() => undefined)
        throw error
      }
      return destination
    }
  }
  return {
    root,
    async write(name, content) {
      // Re-saving the same artifact in this run updates that file; only a file this run did not write
      // (an earlier run or a user file) keeps the digest suffix.
      const previous = written.get(name)
      let destination = previous ?? path.join(root, name)
      if (!previous) {
        const exists = await fs.access(destination).then(() => true, () => false)
        if (exists) {
          const digest = (await sourceSha256(typeof content === 'string' ? new TextEncoder().encode(content) : content)).slice(0, 8)
          destination = path.join(root, name.replace(/(\.[^.]+)$/u, `-${digest}$1`))
        }
      }
      await storageWriter()(() => atomic.writeFileAtomic(destination, content, { mode: 0o600, dirMode: 0o700 }))
      written.set(name, destination)
      return destination
    },
    async writePdf(name, source, signal, build) {
      const persist = storageWriter()
      const beside = await originalDirectory(source)
      const writeInto = async (directory: string) => {
        const images = `${name.slice(0, -3)}-图表`
        const body = await build(async bytes => {
          const digest = await sourceSha256(bytes)
          const image = await persist(() => saveUnique(path.join(directory, images), `${digest.slice(0, 16)}.png`, bytes, signal))
          return `./${encodeURIComponent(images)}/${path.basename(image)}`
        })
        return persist(() => saveUnique(directory, name, new TextEncoder().encode(body), signal))
      }
      if (beside) {
        try { return { path: await writeInto(beside), besideOriginal: true } }
        catch { signal.throwIfAborted() }
      }
      return { path: await writeInto(root), besideOriginal: false }
    },
  }
}
