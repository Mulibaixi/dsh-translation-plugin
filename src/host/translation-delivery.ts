import { sourceSha256 } from './source-storage.js'
import type { QuickHostContext } from './quick-translation.js'

/** Private output directory for real translated artifacts; profile-wide data clear owns it too. */
export interface ArtifactStorage {
  readonly root: string
  write(name: string, content: string): Promise<string>
}
export async function loadArtifactStorage(ctx: QuickHostContext): Promise<ArtifactStorage> {
  const loader = ctx.get?.('loader') as QuickHostContext['loader']
  if (!ctx.baseUrl || !loader?.internal) throw new Error('Host package loader unavailable')
  const [home, atomic] = await Promise.all([
    loader.internal.import('@deepseek-ai/dsh-home-paths', ctx.baseUrl, {}) as Promise<{ dshHomePath(...parts: string[]): string }>,
    loader.internal.import('@deepseek-ai/dsh-atomic-write', ctx.baseUrl, {}) as Promise<{ writeFileAtomic(path: string, content: string, options: { mode: number; dirMode: number }): Promise<void> }>,
  ])
  const fsName = 'node:fs/promises', pathName = 'node:path'
  const fs = await import(fsName) as { access(path: string): Promise<void> }
  const path = await import(pathName) as { join(...parts: string[]): string }
  const root = home.dshHomePath('translation-plugin', 'outputs', 'v1')
  // Serialize with the profile-wide data clear; a cleared profile must not receive stale writes.
  const gate = <T>(action: () => Promise<T>): Promise<T> => {
    const data = ctx.get?.('translationLocalData') as { storageWriter?: () => <U>(action: () => Promise<U>) => Promise<U> } | undefined
    const writer = typeof data?.storageWriter === 'function' ? data.storageWriter() : undefined
    return writer ? writer(action) : action()
  }
  const written = new Map<string, string>()
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
          const digest = (await sourceSha256(new TextEncoder().encode(content))).slice(0, 8)
          destination = path.join(root, name.replace(/(\.[^.]+)$/u, `-${digest}$1`))
        }
      }
      await gate(() => atomic.writeFileAtomic(destination, content, { mode: 0o600, dirMode: 0o700 }))
      written.set(name, destination)
      return destination
    },
  }
}
