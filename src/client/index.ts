import { adaptLibrarySourcesRemote, type LibrarySourcesRemotePort } from './library-sources-client.js'
import { LocalDataClient, LocalDataClearView, useLocalDataFrozen, ClearedDataView } from './local-data.js'
import type { LocalDataRemotePort } from '../shared/local-data.js'
import { ReferenceStore } from './reference-store.js'
import { OtherMemoryClient, type OtherMemoryRemotePort, type OtherMemoryFilesRemotePort } from './other-memory-client.js'
import { h, react } from './react.js'
import { PanelRouter, SettingsView, MemoryAssetsView } from './views.js'
import { createSessionStore } from './session-store.js'
import { HistoryPersistenceClient } from './history-persistence.js'
import type { HistoryRemoteClientPort } from '../shared/history-remote.js'
import { ModelCatalog, type ModelCatalogPort } from './models.js'
import { QuickTranslationClient } from './quick-translation.js'
import { adaptQuickRemote, type QuickRemotePort } from './quick-transport.js'
import { PLUGIN_REMOTE } from '../shared/plugin-remote.js'
import { TopicBridgeClient, type TopicBridgeRemotePort } from './topic-bridge.js'
import { TopicMemoryStore, type TopicTermsRemotePort } from './topic-memory-store.js'
import { EmbeddingClient } from './embedding-client.js'
import type { EmbeddingRemotePort } from '../shared/embedding.js'
import { MemoryIndexClient } from './memory-index-client.js'
import type { MemorySearchRemotePort } from '../shared/memory-search.js'
import { TopicArchiveStore, type TopicArchiveRemotePort } from './topic-archive-store.js'
import { isTextUnit } from './translation-history.js'
import { ThemeMemoryClearing } from './theme-memory-clearing.js'
import { RecordObjectStore } from './record-object-store.js'
import { ObjectAssetsClient, adaptObjectAssetsRemote, type ObjectAssetsRemotePort, type NativeFileUploadPort } from './object-assets-client.js'
import { ViewFilesClient, adaptViewFilesRemote, type ViewFilesRemotePort } from './view-files-client.js'
import { TopicDeletionClient } from './topic-deletion.js'
import { MemoryAssetsTitle } from './memory-assets-title.js'
import { MaterialSubmissionsClient, type MaterialSubmissionRegistry, type NativeMaterialSubmissionRegistry, type TranslationMaterialsRemotePort } from './material-submissions.js'
import { PreparationStore } from './preparation-store.js'
import { DocumentTasksClient, type TranslationBatchRemotePort } from './document-tasks.js'
import { DocumentReviewClient, type DocumentReviewRemotePort } from './document-review-client.js'
import { FileJobsClient, type FileJobsRemotePort } from './file-jobs-client.js'
import { FileHistoryClient } from './file-history.js'
import { NormalTranslationClient, type NormalTranslationRemotePort, type NormalTranslationV2RemotePort } from './normal-translation.js'
import { adaptTranslationSourcesRemote, type TranslationSourcesRemotePort } from './sources-client.js'
import { adaptTranslationSourceStorageRemote, TranslationSourceStorageClient, type TranslationSourceStorageRemotePort } from './source-storage-client.js'
import { adaptTranslationSourceIntegrityRemote, type TranslationSourceIntegrityRemotePort } from './source-integrity-client.js'
import { TranslationSourceReader } from './source-reader.js'
export { adaptTranslationSourceStorageRemote, TranslationSourceStorageClient } from './source-storage-client.js'
export type { TranslationSourceHistoryCommit, TranslationSourceHistoryCallbacks, TranslationSourceSaveTransaction,
  TranslationSourceSaveOutcome, TranslationSourceStorageRemotePort } from './source-storage-client.js'
import type { Capability, ComposerExtensionService } from 'dsh-composer-extension/contracts'
import {
  MEMORY_ASSETS_TAB_ID, MEMORY_ASSETS_TAB_KIND, MEMORY_ASSETS_PATTERN,
  openMemoryAssets, parseMemoryAssetsAddress, readMemoryAssetsNavigation, type MemoryAssetsSidebar, type MemoryAssetsTabInfo,
} from './memory-assets-window.js'

type Disposer = () => void
type AsyncDisposer = () => void | Promise<void>
type ClientComponent = (props?: Readonly<Record<string, unknown>>) => unknown

interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly title: (address: string) => string
  readonly patterns?: readonly string[]
  readonly canOpen?: (address: string) => boolean
  readonly keepMounted?: boolean
  readonly guide?: readonly {
    readonly id: string
    readonly order: number
    readonly title: () => string
    readonly description: () => string
  }[]
}

type ClientPluginContext = Parameters<ComposerExtensionService['register']>[0] & {
  get(name: 'remote.translationHistory'): HistoryRemoteClientPort | undefined
  get(name: 'remote.translationMemorySearch'): MemorySearchRemotePort | undefined
  get(name: 'remote.translationEmbedding'): EmbeddingRemotePort | undefined
  get(name: 'remote.translationTerms'): TopicTermsRemotePort | undefined
  get(name: 'remote.translationArchive'): TopicArchiveRemotePort | undefined
  get(name: 'remote.translationOtherMemory'): OtherMemoryRemotePort | undefined
  get(name: 'remote.translationOtherMemoryFiles'): OtherMemoryFilesRemotePort | undefined
  get(name: 'remote.translationReferences'): { persistRemote?(request: import('../shared/reference-memory.js').ReferenceScope):Promise<unknown>; readRemote(request: import('../shared/reference-memory.js').ReferenceReadRequest): Promise<unknown>; clearRemote(request: import('../shared/reference-memory.js').ReferenceScope): Promise<unknown> } | undefined
  get(name: 'remote.translationLocalData'): LocalDataRemotePort | undefined
  get(name: 'remote.translationQuick'): QuickRemotePort | undefined
  get(name: 'remote.translationTopics'): TopicBridgeRemotePort | undefined
  get(name: 'remote.translationObjects'): ObjectAssetsRemotePort | undefined
  get(name: 'remote.translationViews'): ViewFilesRemotePort | undefined
  get(name: 'remote.translationMaterials'): TranslationMaterialsRemotePort | undefined
  get(name: 'remote.translationNormal'): NormalTranslationRemotePort | undefined
  get(name: 'remote.translationNormalV2'): NormalTranslationV2RemotePort | undefined
  get(name: 'remote.translationBatch'): TranslationBatchRemotePort | undefined
  get(name: 'remote.translationReview'): DocumentReviewRemotePort | undefined
  get(name: 'remote.translationFileJobs'): FileJobsRemotePort | undefined
  get(name: 'remote.translationSources'): (TranslationSourcesRemotePort & TranslationSourceStorageRemotePort & TranslationSourceIntegrityRemotePort & LibrarySourcesRemotePort) | undefined
  get(name: 'locale'): { getLocale(): { readonly active: string } } | undefined
  readonly conversation?: { readonly submissions?: NativeMaterialSubmissionRegistry }
  readonly composerExtension?: ComposerExtensionService
  readonly fileUpload: NativeFileUploadPort
  readonly remote: {
    readonly translationHistory?: HistoryRemoteClientPort
    readonly translationMemorySearch?: MemorySearchRemotePort
    readonly translationEmbedding?: EmbeddingRemotePort
    readonly translationTerms?: TopicTermsRemotePort
    readonly translationArchive?: TopicArchiveRemotePort
    readonly translationOtherMemory?: OtherMemoryRemotePort
    readonly translationOtherMemoryFiles?: OtherMemoryFilesRemotePort
    readonly session: ModelCatalogPort
    readonly translationReferences?: { persistRemote?(request: import('../shared/reference-memory.js').ReferenceScope):Promise<unknown>; readRemote(request: import('../shared/reference-memory.js').ReferenceReadRequest): Promise<unknown>; clearRemote(request: import('../shared/reference-memory.js').ReferenceScope): Promise<unknown> }
    readonly translationLocalData?: LocalDataRemotePort
    readonly translationQuick?: QuickRemotePort
    readonly translationTopics?: TopicBridgeRemotePort
    readonly translationObjects?: ObjectAssetsRemotePort
    readonly translationViews?: ViewFilesRemotePort
    readonly translationMaterials?: TranslationMaterialsRemotePort
    readonly translationNormal?: NormalTranslationRemotePort
    readonly translationNormalV2?: NormalTranslationV2RemotePort
    readonly translationBatch?: TranslationBatchRemotePort
    readonly translationReview?: DocumentReviewRemotePort
    readonly translationFileJobs?: FileJobsRemotePort
    readonly translationSources?: TranslationSourcesRemotePort & TranslationSourceStorageRemotePort & TranslationSourceIntegrityRemotePort & LibrarySourcesRemotePort
    $mount?(contribution: typeof PLUGIN_REMOTE): Promise<AsyncDisposer>
    $on(event: string, listener: () => void): Disposer
  }
  on(event: string, listener: () => void): Disposer
  readonly sidebarRightTabs: { register(definition: SidebarRightTabDefinition): Disposer }
  readonly sidebarRight: MemoryAssetsSidebar
  readonly slots: {
    register(
      target: { readonly name: string; readonly key?: string; readonly id?: string; readonly order?: number; readonly label?: string },
      component: ClientComponent,
    ): Disposer
    inject(name: string, register: () => Disposer): Disposer
  }
  effect(effect: () => void | AsyncDisposer, name?: string): unknown
}

const CLIENT_ID = 'dsh-translation-plugin'
export const name = 'dsh-translation-client'
export const inject = ['sidebarRightTabs', 'sidebarRight', 'slots', 'remote', 'remote.session', 'fileUpload', 'conversation'] as const

function materialSubmissionBridge(
  ctx: ClientPluginContext,
  extension: ComposerExtensionService | null | undefined = ctx.get ? ctx.get('composerExtension') : ctx.composerExtension,
): { registry?: MaterialSubmissionRegistry; composerReason?: string } {
  const capability: Capability | undefined = extension?.capabilities()
  if (extension) return capability?.state === 'available'
    ? { registry: extension }
    : { composerReason: capability?.reason ?? 'composer_extension_unavailable' }

  const native = ctx.conversation?.submissions
  if (native?.protocolVersion === 1) return {
    registry: {
      capabilities: () => ({ state: 'available', version: 1, reason: null }),
      register: (owner, adapter) => native.register(owner, { freeze: adapter.freeze }),
    },
  }

  const composerReason = capability?.reason ?? (native === undefined ? undefined : native.protocolVersion === undefined
    ? 'composer_protocol_undeclared' : `composer_protocol_unsupported:${native.protocolVersion}`)
  return composerReason === undefined ? {} : { composerReason }
}

function withClientDiagnostics<T>(stage: string, action: () => T): T {
  try { return action() } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
    console.error(`[${CLIENT_ID}] Client ${stage} failed: ${detail}`)
    throw error
  }
}

/** The active DSH interface locale resolved by the loaded locale service; undefined before it loads. */
function activeUiLocale(ctx: ClientPluginContext): string | undefined {
  try { return ctx.get?.('locale')?.getLocale().active } catch { return undefined }
}

export function apply(ctx: ClientPluginContext): void {
  withClientDiagnostics('apply', () => {
    const store = createSessionStore(true)
    const history = new HistoryPersistenceClient(store, async () => {
      await memoryRemoteReady()
      return ctx.get?.('remote.translationHistory') ?? ctx.remote.translationHistory
    })
    store.setHistoryBackend(history)
    ctx.effect(() => () => history.dispose(), 'translation history persistence')
    const models = new ModelCatalog(ctx.remote.session)
    const embedding = new EmbeddingClient(async () => {
      const mounted = await mountedRemote
      return remoteDisposed || ctx.remote.$mount && !mounted ? undefined : ctx.get?.('remote.translationEmbedding') ?? ctx.remote.translationEmbedding
    })
    ctx.effect(() => () => embedding.dispose(), 'translation embedding settings')
    let remoteDisposed = false
    // One DSH contribution owns the namespaces; mounting the package twice replaces its face.
    const mountedRemote = (async () => ctx.remote.$mount?.(PLUGIN_REMOTE))().catch(error => {
      const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
      console.error(`[${CLIENT_ID}] Client translation remote mount failed: ${detail}`)
      return undefined
    })
    const sourcesRemote = ctx.remote.$mount ? async () => {
      const unmountRemote = await mountedRemote
      return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationSources')
    } : ctx.remote.translationSources
    const sources = adaptTranslationSourcesRemote(sourcesRemote)
    const storage = adaptTranslationSourceStorageRemote(sourcesRemote, () => store.getNamespaceId())
    const sourceStorage = new TranslationSourceStorageClient(storage)
    const integrity = adaptTranslationSourceIntegrityRemote(sourcesRemote)
    const evidence = new TranslationSourceReader({ sessions: store, sources, storage, integrity, library: adaptLibrarySourcesRemote(sourcesRemote), assetNamespaceId: () => references.getAssetNamespaceId() })
    const fileJobs = new FileJobsClient(store, evidence, ctx.remote.$mount ? async () => {
      const unmountRemote = await mountedRemote
      return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationFileJobs')
    } : ctx.remote.translationFileJobs, () => activeUiLocale(ctx))
    const objects = new RecordObjectStore(store)
    const quick = new QuickTranslationClient(adaptQuickRemote(ctx.remote.$mount ? async () => {
      const unmountRemote = await mountedRemote
      return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationQuick')
    } : ctx.remote.translationQuick), store, models, { canManualEdit: (session, unitId, revisionId) => !objects.hasRevisionObjects(store.getTopicStorageScope(session.topicId)!,  session.topicId, session.id, unitId, revisionId) })
    const terms = new TopicMemoryStore(store, undefined, undefined, undefined, (sessionId, unitId) => fileJobs.readEvidence(sessionId, unitId), {
      remote: async () => {
        await memoryRemoteReady()
        return ctx.get?.('remote.translationTerms') ?? ctx.remote.translationTerms
      },
    })
    const archive = new TopicArchiveStore(store, (sessionId, unitId) => terms.readEvidence(sessionId, unitId), undefined, undefined, undefined, {
      remote: async () => {
        await memoryRemoteReady()
        return ctx.get?.('remote.translationArchive') ?? ctx.remote.translationArchive
      },
    })
    terms.setEvidenceReader(fileJobs)
    archive.setEvidenceReader(fileJobs)
    const topics = new TopicBridgeClient(ctx.remote.$mount ? async () => {
      const unmountRemote = await mountedRemote
      return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationTopics')
    } : ctx.remote.translationTopics, store, terms, archive)
    fileJobs.setAssets(terms, archive, ownerId => topics.retain(ownerId))
    const references = new ReferenceStore(store, async () => {
      if (ctx.remote.$mount) await mountedRemote
      return remoteDisposed ? undefined : ctx.get ? ctx.get('remote.translationReferences') : ctx.remote.translationReferences
    }, undefined, {withOwner:async <T>(_storageScope:string,action:()=>Promise<T>):Promise<T>=>{
      if(!topics.getLibraryStatus().ready)await new Promise<void>((resolve,reject)=>{
        let stop:()=>void=()=>{}
        const timer=setTimeout(()=>{stop();reject(new Error(topics.getLibraryStatus().reason ?? '资料库连接尚未就绪。'))},15000)
        const check=():void=>{if(topics.getLibraryStatus().ready){clearTimeout(timer);stop();resolve()}}
        stop=topics.subscribe(check);check()
      })
      return await action()
    }})
    topics.setReferences(references)
    terms.setReferenceEvidence(references)
    archive.setReferenceEvidence(references)
    ctx.effect(() => () => references.dispose(), 'translation references')
    async function memoryRemoteReady(): Promise<void> {
      if (ctx.remote.$mount && !await mountedRemote) throw new Error('插件连接失败，请检查宿主服务后重试。')
      if (remoteDisposed) throw new Error('记忆资产连接已关闭。')
      if (!topics.getLibraryStatus().ready) await new Promise<void>((resolve, reject) => {
        let stop: () => void = () => {}
        const timer = setTimeout(() => { stop(); reject(new Error(topics.getLibraryStatus().reason ?? '资料库连接尚未就绪。')) }, 15000)
        const check = (): void => { if (topics.getLibraryStatus().ready) { clearTimeout(timer); stop(); resolve() } }
        stop = topics.subscribe(check); check()
      })
      if (remoteDisposed) throw new Error('记忆资产连接已关闭。')
    }
    const memoryIndex = new MemoryIndexClient(() => store.getNamespaceId(), async () => {
      await memoryRemoteReady()
      return ctx.get?.('remote.translationMemorySearch') ?? ctx.remote.translationMemorySearch
    })
    ctx.effect(() => () => memoryIndex.dispose(), 'translation memory index')
    const otherMemory = new OtherMemoryClient(store, async () => {
      await memoryRemoteReady()
      return ctx.get?.('remote.translationOtherMemory') ?? ctx.remote.translationOtherMemory
    }, { uploads: ctx.fileUpload, filesRemote: async () => {
      await memoryRemoteReady()
      return ctx.get?.('remote.translationOtherMemoryFiles') ?? ctx.remote.translationOtherMemoryFiles
    } })
    ctx.effect(() => () => otherMemory.dispose(), 'translation other memory')
    const submissionBridge = materialSubmissionBridge(ctx)
    const materials = new MaterialSubmissionsClient({ store, topics, owner: ctx, ...submissionBridge,
      upload: ctx.fileUpload,
      sources,
      sourceStorage, sourceStoragePort: storage,
      uiLocale: () => activeUiLocale(ctx),
      remote: ctx.remote.$mount ? async () => {
        const unmountRemote = await mountedRemote
        return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationMaterials')
      } : ctx.remote.translationMaterials,
    })
    // Cordis re-runs this scope when the optional service is loaded or replaced.
    fileJobs.setMaterials(materials, () => references.getAssetNamespaceId())
    topics.setFileHistory(new FileHistoryClient(store, fileJobs, materials, () => references.getAssetNamespaceId(), () => activeUiLocale(ctx), evidence))
    // Keep drafts and submission receipts in the root client across those changes.
    ctx.inject(['composerExtension'], scope => {
      const bridge = materialSubmissionBridge(ctx, scope.get('composerExtension'))
      materials.setComposerBridge(bridge.registry, bridge.composerReason)
      scope.effect(() => () => {
        // The service may still be visible while its dependency scope is stopping.
        const fallback = materialSubmissionBridge(ctx, null)
        materials.setComposerBridge(fallback.registry, fallback.composerReason)
      })
    })
    const preparations = new PreparationStore({ ...store.createPreparationStoreOptions(), isTopicTermsCurrent: snapshot => terms.isSnapshotCurrent(snapshot),
      isTopicTermsCurrentAsync: snapshot => terms.isSnapshotCurrentAsync(snapshot) })
    void history.start()
    topics.setPreparation(preparations, envelope => materials.resolveSubmittedMaterial(envelope), target => materials.resolveSubmittedTarget(target))
    const objectAssets = new ObjectAssetsClient(adaptObjectAssetsRemote(ctx.remote.$mount ? async () => {
      const unmountRemote = await mountedRemote
      return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationObjects')
    } : ctx.remote.translationObjects), ctx.fileUpload, store, objects, ownerId => topics.getStatus(ownerId))
    const viewFiles = new ViewFilesClient(adaptViewFilesRemote(ctx.remote.$mount ? async () => {
      const unmountRemote = await mountedRemote
      return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationViews')
    } : ctx.remote.translationViews), store, { sources, sourceStorage: storage, library: adaptLibrarySourcesRemote(sourcesRemote) })
    const normal = new NormalTranslationClient(store, materials, terms, ownerId => topics.retain(ownerId), {
      isSessionBusy: sessionId => quick.isBusy(sessionId), subscribeBridge: listener => topics.subscribe(listener), bridgeReady: ownerId => topics.getStatus(ownerId).ready,
      uiLocale: () => activeUiLocale(ctx),
      canCorrectSource: (ownerId, topicId, sessionId, unitId) => !objects.getReferences({ ownerId, topicId, sessionId, unitId, side: 'source', revisionId: null }).length,
      remote: ctx.remote.$mount ? async () => {
        const unmountRemote = await mountedRemote
        return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationNormal')
      } : ctx.remote.translationNormal,
      remoteV2: ctx.remote.$mount ? async () => {
        const unmountRemote = await mountedRemote
        return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationNormalV2')
      } : ctx.remote.translationNormalV2,
    })
    topics.setNormalTranslation(normal)
    const memoryClearing = new ThemeMemoryClearing(store, terms, archive, {
      isSessionBusy: sessionId => quick.isBusy(sessionId) || normal.isBusy(sessionId) ||
        (store.getTranslationHistory(sessionId)?.units.some(unit => normal.getRetranslationStatus(sessionId, unit.id)?.pending || normal.getUnitStatus(sessionId, unit.id)?.querying) ?? false),
      subscribeBusy: listener => { const stops = [quick.subscribe(listener), normal.subscribe(listener)]; return () => { for (const stop of stops) stop() } },
    })
    const documents = new DocumentTasksClient(store, materials, preparations, ownerId => topics.retain(ownerId), {
      canCorrectSource: (ownerId, topicId, sessionId, unitId) => !objects.getReferences({ ownerId, topicId, sessionId, unitId, side: 'source', revisionId: null }).length,
      isSessionBusy: sessionId => quick.isBusy(sessionId) || normal.isBusy(sessionId), reader: evidence,
      sourceStorage, subscribeBridge: listener => topics.subscribe(listener), bridgeReady: ownerId => topics.getStatus(ownerId).ready,
      uiLocale: () => activeUiLocale(ctx),
      remote: ctx.remote.$mount ? async () => {
        const unmountRemote = await mountedRemote
        return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationBatch')
      } : ctx.remote.translationBatch,
    })
    topics.setDocumentTasks(documents)
    const stopFileAcceptance = fileJobs.subscribe(() => { for (const record of fileJobs.all()) documents.observeFileTask(record.summary) })
    ctx.effect(() => stopFileAcceptance, 'translation file retranslation acceptance')
    const documentReviews = new DocumentReviewClient(store, preparations, evidence, ownerId => topics.retain(ownerId), {
      isSessionBusy: sessionId => quick.isBusy(sessionId) || normal.isBusy(sessionId),
      remote: ctx.remote.$mount ? async () => {
        const unmountRemote = await mountedRemote
        return remoteDisposed || !unmountRemote ? undefined : ctx.get('remote.translationReview')
      } : ctx.remote.translationReview,
    })
    topics.setDocumentReviews(documentReviews)
    ctx.effect(() => () => store.dispose(), 'translation client store')
    ctx.effect(() => () => models.dispose(), 'translation model catalog')
    ctx.effect(() => () => terms.dispose(), 'translation topic terms')
    ctx.effect(() => () => archive.dispose(), 'translation topic archive')
    ctx.effect(() => () => evidence.dispose(), 'translation evidence reader')
    ctx.effect(() => () => { objectAssets.dispose(); objects.dispose() }, 'translation record objects')
    ctx.effect(() => () => viewFiles.dispose(), 'translation view files')
    ctx.effect(() => async () => {
      remoteDisposed = true
      materials.dispose()
      documents.dispose()
      fileJobs.dispose()
      documentReviews.dispose()
      preparations.dispose()
      normal.dispose()
      quick.dispose()
      await topics.dispose()
      const unmountRemote = await mountedRemote
      await unmountRemote?.()
    }, 'translation remote clients')
    ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => models.invalidate()), 'translation catalog invalidation')
    ctx.effect(() => ctx.remote.$on('settings/document-updated', () => models.invalidate()), 'translation catalog settings')
    ctx.effect(() => ctx.on('connection/reset', () => { evidence.clearCache(); models.invalidate(true); quick.reset(); normal.reset(); materials.reset(); otherMemory.reset(); embedding.reset(); memoryIndex.reset(); terms.reset(); archive.reset(); void topics.reset() }), 'translation catalog connection')

    const localData = new LocalDataClient(async () => {
      if (ctx.remote.$mount) await mountedRemote
      return ctx.get?.('remote.translationLocalData') ?? ctx.remote.translationLocalData
    }, async () => {
      history.dispose()
      materials.dispose(); documents.dispose(); fileJobs.dispose(); documentReviews.dispose(); preparations.dispose()
      normal.dispose(); quick.dispose(); references.dispose(); otherMemory.dispose(); embedding.dispose(); memoryIndex.dispose(); terms.dispose(); archive.dispose()
      evidence.dispose(); objects.dispose(); objectAssets.dispose(); viewFiles.dispose(); models.dispose(); store.dispose()
      await topics.dispose()
    }, () => store.hasUnsettledWork() || store.getAllSessions().some(session => quick.isBusy(session.id) || normal.isBusy(session.id)))
    ctx.effect(() => () => localData.dispose(), 'translation local data')

    const onDeleteTerm = (snapshot: { ownerId: string; topicId: string; version: number }, entry: { id: string; version: number }) => terms.deleteEntryAsync(snapshot.ownerId, snapshot.topicId, entry.id, snapshot.version, entry.version)
    const topicDeletion = new TopicDeletionClient({ sessions: store, clearing: memoryClearing, references, viewFiles, localData,
      isSessionBusy: sessionId => quick.isBusy(sessionId) || normal.isBusy(sessionId) || store.hasDocumentLease(sessionId) })
    const historyLoading = (): unknown => h('section', { className: 'dsh-translation' }, h('p', null, store.getNotice() ?? '正在读取会话历史…'),
      h('button', { type: 'button', onClick: () => void history.start() }, '重试读取'))
    const TranslationPanel: ClientComponent = (props = {}) => {
      const frozen = useLocalDataFrozen(localData)
      const [, historyChanged] = react.useState(0)
      react.useEffect(() => store.subscribe(() => historyChanged(value => value + 1)), [])
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const tabInfo = typeof props.useTabInfo === 'function' ? (props.useTabInfo as () => MemoryAssetsTabInfo)() : undefined
      if (frozen) return h(ClearedDataView, null)
      if (!store.isHistoryReady()) return historyLoading()
      return h(PanelRouter, {
        store, models, quick, normal, topics, materials, terms, archive, references, otherMemory, memoryIndex, memoryClearing, topicDeletion, objects, objectAssets, viewFiles, documents: evidence, documentTasks: documents, documentReviews, fileJobs, onDeleteTerm, sessionId,
        onOpenAssets: sessionId && tabInfo ? (ownerId: string, topicId: string, associatedSessionId?: string, jobId?: string) => {
          if (!store.getTopics(ownerId).some(topic => topic.id === topicId)) return
          openMemoryAssets(ctx.sidebarRight, { ownerId: sessionId, tab: tabInfo.tab }, { ownerId, topicId, sessionId: associatedSessionId, jobId },
            typeof window === 'undefined' ? undefined : { width: window.innerWidth, height: window.innerHeight })
        } : undefined,
      })
    }
    const MemoryAssetsPanel: ClientComponent = (props = {}) => {
      const frozen = useLocalDataFrozen(localData)
      const [, historyChanged] = react.useState(0)
      react.useEffect(() => store.subscribe(() => historyChanged(value => value + 1)), [])
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const tabInfo = typeof props.useTabInfo === 'function' ? (props.useTabInfo as () => MemoryAssetsTabInfo)() : undefined
      if (frozen) return h(ClearedDataView, null)
      if (!store.isHistoryReady()) return historyLoading()
      const scope = readMemoryAssetsNavigation(sessionId ?? store.getNamespaceId(), tabInfo?.tab)
      const onClose = tabInfo ? () => tabInfo.tab.actions.close() : undefined
      if (!scope) return h('section', { className: 'dsh-translation' },
        h('h2', null, '记忆资产不可用'), h('p', null, '资源地址无效。'),
        onClose ? h('button', { type: 'button', onClick: onClose }, '关闭') : null)
      return h(MemoryAssetsView, { store, quick, topics, terms, archive, references, otherMemory, memoryIndex, mainSessionId: scope.ownerId === store.getNamespaceId() ? undefined : scope.ownerId, objects, objectAssets, viewFiles, documents: evidence, fileJobs, memoryClearing, onDeleteTerm, ...scope,
        onSelectTopic: tabInfo ? (topicId: string) => {
          if (tabInfo.tab.signal.aborted || !store.getTopics(scope.ownerId).some(topic => topic.id === topicId)) return
          tabInfo.tab.actions.openResource(tabInfo.tab.navigation.address, { params: { topicId } })
        } : undefined })
    }
    const MemoryAssetsCaption: ClientComponent = (props = {}) => {
      const frozen = useLocalDataFrozen(localData)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const tabInfo = typeof props.useTabInfo === 'function' ? (props.useTabInfo as () => MemoryAssetsTabInfo)() : undefined
      if (frozen) return null
      const scope = readMemoryAssetsNavigation(sessionId ?? store.getNamespaceId(), tabInfo?.tab)
      return h(MemoryAssetsTitle, { store, scope,
        onSelectTopic: scope && tabInfo ? (topicId: string) => {
          if (tabInfo.tab.signal.aborted || !store.getTopics(scope.ownerId).some(topic => topic.id === topicId)) return
          tabInfo.tab.actions.openResource(tabInfo.tab.navigation.address, { params: { topicId } })
        } : undefined })
    }
    const TranslationSettings: ClientComponent = (props = {}) => {
      const frozen = useLocalDataFrozen(localData)
      return frozen ? h(LocalDataClearView, {data:localData}) : h(SettingsView, {
        store, terms, localData, embedding, memoryIndex, onClose: typeof props.close === 'function' ? props.close : undefined,
      })
    }
    const MaterialAttachmentMarker: ClientComponent = (props = {}) => {
      const [, update] = react.useState(0)
      react.useEffect(() => materials.subscribe(() => update(value => value + 1)), [])
      const ownerId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      react.useEffect(() => ownerId ? topics.retain(ownerId) : undefined, [ownerId])
      const frozen = useLocalDataFrozen(localData)
      const attachment = !frozen && ownerId ? materials.getAttachment(ownerId) : undefined
      if (!attachment || !ownerId) return null
      return h('span', { className: 'dsh-translation-material-marker', role: 'status' },
        h('span', null, attachment.omitted ? '本次不附带待译稿' : attachment.label),
        attachment.available ? h('button', { type: 'button', onClick: () => materials.setOmit(ownerId, !attachment.omitted) }, attachment.omitted ? '恢复附带' : '本次不附带') : null)
    }
    ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
      { name: 'conversation.input.left', id: `${CLIENT_ID}-material`, order: 40 }, MaterialAttachmentMarker,
    )), 'translation material marker')

    ctx.effect(() => withClientDiagnostics('sidebarRightTabs.register', () => ctx.sidebarRightTabs.register({
      id: CLIENT_ID,
      kind: 'translation-workspace',
      title: () => '翻译',
      keepMounted: true,
      guide: [{ id: 'translation-workspace', order: 40, title: () => '翻译', description: () => '打开翻译会话。' }],
    })), 'translation tab type')

    ctx.effect(() => withClientDiagnostics('sidebar.right.pane.tab register', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: CLIENT_ID }, TranslationPanel,
    )), 'translation tab body')

    ctx.effect(() => withClientDiagnostics('memory asset type register', () => ctx.sidebarRightTabs.register({
      id: MEMORY_ASSETS_TAB_ID,
      kind: MEMORY_ASSETS_TAB_KIND,
      title: () => '记忆资产',
      patterns: [MEMORY_ASSETS_PATTERN],
      canOpen: address => parseMemoryAssetsAddress(address) !== undefined,
      keepMounted: true,
    })), 'translation memory asset tab type')
    ctx.effect(() => withClientDiagnostics('memory asset body register', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: MEMORY_ASSETS_TAB_ID }, MemoryAssetsPanel,
    )), 'translation memory asset tab body')
    ctx.effect(() => withClientDiagnostics('memory asset title register', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: MEMORY_ASSETS_TAB_ID }, MemoryAssetsCaption,
    )), 'translation memory asset tab title')

    ctx.effect(() => withClientDiagnostics('settings.section register', () => ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: CLIENT_ID, order: 40, label: '翻译' }, TranslationSettings,
    ))), 'translation settings page')
  })
}
