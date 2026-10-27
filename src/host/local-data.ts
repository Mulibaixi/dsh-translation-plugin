import type { TopicHostContext } from './topic-tools.js'
import type { HostStorageUsage, LocalDataClearResult, TopicPurgeResult, SourceReclaimResult } from '../shared/local-data.js'
import { referenceExact, referenceObject, referenceString } from '../shared/reference-memory.js'
import { isViewFileStorageName, isViewFileStorageDirectory, viewFileStorageName, viewUnitStoragePrefix, viewVersionStoragePrefix, viewSessionStoragePrefix } from './view-files.js'
import { sourceReferenceKey, mergeHistoryCleanup, type HistoryCleanup, type HistoryCleanupResult } from '../shared/history-cleanup.js'
import { parseStoredSourceReference, sourceContentDigest } from './source-storage.js'
import type { TranslationSourcesService } from './translation-sources.js'
import type { OtherMemoryService } from './other-memory.js'
import type { TopicArchiveService } from './topic-archive.js'
import type { TopicTermsService } from './topic-terms.js'
import type { EmbeddingService } from './embedding.js'
import type { HistoryService } from './history.js'

type Files = { scan(): Promise<readonly {path:string;bytes:number}[]>; read(path:string):Promise<string>; remove(path:string):Promise<void> }
type Service = { dispose?():void|Promise<void>; hasActiveJobs?():boolean }
function stopped(message: string): Error { return Object.assign(new Error(message), {code:'local_data_blocked'}) }
async function filesFor(ctx: TopicHostContext): Promise<Files> {
  const loader=ctx.get?.('loader') as {internal?:{import(name:string,anchor:string,options:object):Promise<unknown>}}|undefined
  if(!ctx.baseUrl||!loader?.internal)throw stopped('宿主本地数据存储尚未就绪。')
  const home=await loader.internal.import('@deepseek-ai/dsh-home-paths',ctx.baseUrl,{}) as {dshHomePath(...parts:string[]):string}
  const fsName='node:fs/promises',pathName='node:path'
  const fs=await import(fsName) as {readdir(path:string,options:object):Promise<{name:string;isFile():boolean;isDirectory():boolean}[]>;stat(path:string):Promise<{size:number}>;lstat(path:string):Promise<{isSymbolicLink():boolean}>;unlink(path:string):Promise<void>;rmdir(path:string):Promise<void>;readFile(path:string,encoding:'utf8'):Promise<string>}
  const path=await import(pathName) as {join(...parts:string[]):string;resolve(path:string):string;dirname(path:string):string}
  const roots=[['sources','v1','content'],['sources','v1','references'],['references','v1'],['views','v1'],['objects','v1'],['memory','v1']].map(parts=>path.resolve(home.dshHomePath('translation-plugin',...parts)))
  const directories=[[],['sources'],['sources','v1'],['sources','v1','content'],['sources','v1','references'],['references'],['references','v1'],['views'],['views','v1'],['objects'],['objects','v1'],['memory'],['memory','v1']].map(parts=>home.dshHomePath('translation-plugin',...parts))
  const allowed=(file:string):boolean=>{
    const name=file.slice(Math.max(file.lastIndexOf('/'),file.lastIndexOf('\\'))+1), root=path.dirname(path.resolve(file))
    if(root===roots[0])return sourceContentDigest(name)!==undefined
    if(root===roots[1]||root===roots[2])return /^[a-f0-9]{64}\.json$/u.test(name)
    if(root===roots[3])return isViewFileStorageName(name)
    if(path.dirname(root)===roots[3]&&isViewFileStorageDirectory(root.slice(Math.max(root.lastIndexOf('/'),root.lastIndexOf('\\'))+1)))return isViewFileStorageName(viewFileStorageName(file))
    if(root===roots[5])return /^assets\.sqlite(?:-journal|-wal|-shm)?$/u.test(name)
    return root===roots[4]&&/^asset-[0-9a-f-]{36}\.json$/u.test(name)
  }
  return {
    async scan(){const files:{path:string;bytes:number}[]=[];
      for(const directory of directories){try{if((await fs.lstat(directory)).isSymbolicLink())throw stopped('插件存储目录是链接，实际清理范围未确认。')}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}}
      for(const root of roots){let entries:Awaited<ReturnType<typeof fs.readdir>>;try{entries=await fs.readdir(root,{withFileTypes:true})}catch(error){if((error as {code?:string}).code==='ENOENT')continue;throw error}
      for(const entry of entries){const file=path.join(root,entry.name);
        if(root===roots[3]&&entry.isDirectory()&&isViewFileStorageDirectory(entry.name)){
          if((await fs.lstat(file)).isSymbolicLink())throw stopped('插件存储目录是链接，实际清理范围未确认。');
          for(const child of await fs.readdir(file,{withFileTypes:true})){const target=path.join(file,child.name);if(!child.isFile()||!allowed(target))throw stopped('插件存储包含无法识别的条目，清理范围未确认。');files.push({path:target,bytes:(await fs.stat(target)).size})}
        }else{if(!entry.isFile()||!allowed(file))throw stopped('插件存储包含无法识别的条目，清理范围未确认。');files.push({path:file,bytes:(await fs.stat(file)).size})}
      }}
      return files},
    async read(file){if(!allowed(file))throw stopped('读取路径超出插件存储范围。');return fs.readFile(file,'utf8')},
    async remove(file){if(!allowed(file))throw stopped('清理路径超出插件存储范围。');try{await fs.unlink(file)}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
      const parent=path.dirname(path.resolve(file));if(path.dirname(parent)===roots[3])try{await fs.rmdir(parent)}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as {code?:string}).code??''))throw error}},
  }
}

/** Serializes plugin-owned file writes with an explicit, profile-wide data clear. */
export class LocalDataService {
  readonly typertRemote: {readonly service:LocalDataService;readonly serviceKey:'translationLocalData';readonly namespace:'translationLocalData'}={service:this,serviceKey:'translationLocalData',namespace:'translationLocalData'}
  private generation=0
  private tail:Promise<unknown>=Promise.resolve()
  private blocked=false
  private complete=false
  constructor(private readonly ctx:TopicHostContext,private readonly files:()=>Promise<Files>=()=>filesFor(ctx)){
    Object.defineProperty(this,Symbol.for('cordis.tracker'),{value:{associate:'translationLocalData',property:'ctx'}})
  }
  storageWriter():<T>(action:()=>Promise<T>)=>Promise<T>{
    const generation=this.generation
    return <T>(action:()=>Promise<T>):Promise<T>=>{
      const result=this.tail.then(()=>{if(this.blocked||generation!==this.generation)throw stopped('本地数据已经清理，旧写入已停止。');return action()})
      this.tail=result.catch(()=>{});return result
    }
  }
  private authorize():void{if(!this.ctx.invocation?.peer.id)throw stopped('本地数据操作缺少宿主连接身份。')}
  /** Conservative cross-window guard: any unsettled Host job defers scoped cleanup. */
  private hasActiveJobs():boolean{
    const services=['translationFileJobs','translationQuick','translationNormal','translationBatch','translationReview','translationMaterials','translationSources','translationReferences','translationOtherMemoryFiles','translationOtherMemory','translationArchive','translationTerms','translationEmbedding','translationMemorySearch','translationHistory']
    return services.some(name=>(this.ctx.get?.(name) as Service|undefined)?.hasActiveJobs?.())
  }
  private async withSourceCleanup<T>(action:()=>Promise<T>):Promise<T>{
    const sources=this.ctx.get?.('translationSources') as TranslationSourcesService|undefined
    const release=sources?.beginStorageCleanup?.()
    if(sources?.beginStorageCleanup&&!release)throw stopped('仍有原稿读取或保存操作，请完成后重试清理。')
    const references=this.ctx.get?.('translationOtherMemoryFiles') as {beginStorageCleanup?():undefined|(()=>void)}|undefined
    let releaseReferences:(()=>void)|undefined
    try{
      releaseReferences=references?.beginStorageCleanup?.()
      if(references?.beginStorageCleanup&&!releaseReferences)throw stopped('仍有参考文件读取或保存操作，请完成后重试清理。')
      return await action()
    }finally{releaseReferences?.();release?.()}
  }
  async usageRemote():Promise<HostStorageUsage>{this.authorize();const files=await(await this.files()).scan();const db=await(this.ctx.get?.('translationOtherMemory') as OtherMemoryService|undefined)?.databaseForArchives();return {files:files.length,bytes:files.reduce((sum,file)=>sum+file.bytes,0),pendingCleanups:db?.historyCleanups().length??0}}
  /** Business rows are already deleted. Keep the body-free identities until this pass finishes. */
  async cleanupHistoryUnitLocked(task: HistoryCleanup, held: HistoryCleanup, tally?: { removed: Set<string>; retained: Set<string> }): Promise<HistoryCleanupResult> {
    const result = { complete: true, removed: 0, retained: 0 }
    const count = (kind: 'removed' | 'retained', path: string): void => { if (!tally?.[kind].has(path)) result[kind]++; tally?.[kind].add(path); if (kind === 'removed') tally?.retained.delete(path) }
    if (task.topicOwnerId) {
      const db = await (this.ctx.get?.('translationOtherMemory') as OtherMemoryService | undefined)?.databaseForArchives()
      if (db && !db.retired(task.scope.namespaceId, task.scope.topicId)) return { ...result, complete: false }
    }
    if (task.resultVersions || task.revisionIds) {
      const jobs = this.ctx.get?.('translationFileJobs') as { forgetHistoryResultVersion(scope: HistoryCleanup['scope'], unitId: string, version: number): void } | undefined
      const views = this.ctx.get?.('translationViews') as { invalidateHistoryResult(scope: HistoryCleanup['scope'], unitId: string, version: number): boolean; invalidateHistoryVersion(scope: HistoryCleanup['scope'], unitId: string, revisionId: string): boolean } | undefined
      try {
        for (const version of task.resultVersions ?? []) { jobs?.forgetHistoryResultVersion(task.scope, task.unitId, version); if (views && !views.invalidateHistoryResult(task.scope, task.unitId, version)) result.complete = false }
        for (const revisionId of task.revisionIds ?? []) if (views && !views.invalidateHistoryVersion(task.scope, task.unitId, revisionId)) result.complete = false
        const prefixes = await Promise.all([...(task.resultVersions ?? []).map(version => `result:${task.unitId}:${version}`), ...task.revisionIds ?? []].map(revisionId => viewVersionStoragePrefix(task.scope.namespaceId, task.scope.sessionId, task.unitId, revisionId)))
        const files = await this.files()
        for (const file of await files.scan()) { const path = file.path.replace(/\\/gu, '/'), name = viewFileStorageName(path)
          if (path.includes('/views/v1/') && isViewFileStorageName(name) && prefixes.some(prefix => name.startsWith(prefix))) try { await files.remove(file.path); count('removed', file.path) } catch { result.complete = false }
        }
      } catch { result.complete = false }
      if (!task.sourceVersions) return result
    }
    for (const name of ['translationFileJobs', 'translationNormal', 'translationBatch', 'translationAnalysis', 'translationCorrection', 'translationPlanning', 'translationReview', 'translationMaterials'])
      if (task.sourceVersions) {
        for (const version of task.sourceVersions) (this.ctx.get?.(name) as { forgetHistoryUnit?(scope: HistoryCleanup['scope'], unitId: string, version?: number): void } | undefined)?.forgetHistoryUnit?.(task.scope, task.unitId, version)
      } else (this.ctx.get?.(name) as { forgetHistoryUnit?(scope: HistoryCleanup['scope'], unitId: string): void } | undefined)?.forgetHistoryUnit?.(task.scope, task.unitId)
    const sources = this.ctx.get?.('translationSources') as TranslationSourcesService | undefined
    const materials = this.ctx.get?.('translationMaterials') as { heldSourceIds?(): readonly string[] } | undefined
    sources?.forgetSourceIds(new Set(task.sources.map(source => source.sourceId)), new Set([...held.sources.map(source => source.sourceId), ...materials?.heldSourceIds?.() ?? []]))
    const views = this.ctx.get?.('translationViews') as { invalidateHistoryUnit(scope: HistoryCleanup['scope'], unitId: string): boolean; invalidateHistorySession(scope: HistoryCleanup['scope']): boolean } | undefined
    if (!task.sourceVersions && views && !(task.unitId === '*' ? task.scope.sessionId === '*' || views.invalidateHistorySession(task.scope) : views.invalidateHistoryUnit(task.scope, task.unitId))) result.complete = false
    try {
      await this.withSourceCleanup(async () => {
        const store = await this.files(), files = await store.scan(), wanted = new Set(task.references.map(sourceReferenceKey)), liveRefs = new Set(held.references.map(sourceReferenceKey))
        const digests = new Set(task.sources.map(source => source.sha256)), retained = new Set([...held.sources.map(source => source.sha256), ...sources?.heldSourceDigests(new Set(materials?.heldSourceIds?.() ?? [])) ?? []])
        for (const digest of await (this.ctx.get?.('translationOtherMemory') as OtherMemoryService | undefined)?.heldSourceDigests() ?? []) retained.add(digest)
        let unknownHolder = false; const blocked = new Set<string>()
        const prefix = task.unitId === '*' ? task.scope.sessionId === '*' ? undefined : await viewSessionStoragePrefix(task.scope.sessionId) : await viewUnitStoragePrefix(task.scope.namespaceId, task.scope.sessionId, task.unitId)
        for (const file of files) {
          const path = file.path.replace(/\\/gu, '/'), name = path.includes('/views/v1/') ? viewFileStorageName(path) : path.slice(path.lastIndexOf('/') + 1)
          if (task.topicOwnerId && (/\/objects\/v1\/asset-[0-9a-f-]{36}\.json$/u.test(path) || /\/references\/v1\/[a-f0-9]{64}\.json$/u.test(path) && !path.includes('/sources/v1/'))) {
            try {
              const value = JSON.parse(await store.read(file.path)) as { ownerId?: string; topicId?: string; scope?: { ownerId?: string; topicId?: string; namespaceId?: string } }
              if (value.ownerId === task.topicOwnerId && value.topicId === task.scope.topicId || value.scope?.topicId === task.scope.topicId && (value.scope.namespaceId === task.scope.namespaceId || value.scope.namespaceId === undefined && value.scope.ownerId === task.topicOwnerId)) { await store.remove(file.path); count('removed', file.path) }
            } catch { result.complete = false }
          }
          if (/\/sources\/v1\/references\/[a-f0-9]{64}\.json$/u.test(path)) {
            let raw: unknown
            try {
              raw = JSON.parse(await store.read(file.path)); const record = parseStoredSourceReference(raw), key = sourceReferenceKey(record.reference)
              if (wanted.has(key) && !liveRefs.has(key) && digests.has(record.reference.source.sha256)) {
                try { await store.remove(file.path); count('removed', file.path); continue } catch { result.complete = false; blocked.add(record.reference.source.sha256); continue }
              }
              if (record.reference.state !== 'released') retained.add(record.reference.source.sha256)
            } catch {
              result.complete = false
              const digest = (raw as { reference?: { source?: { sha256?: unknown } } } | undefined)?.reference?.source?.sha256
              if (typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)) blocked.add(digest); else unknownHolder = true
            }
          } else if (!task.sourceVersions && prefix && path.includes('/views/v1/') && name.startsWith(prefix) && isViewFileStorageName(name)) {
            try { await store.remove(file.path); count('removed', file.path) } catch { result.complete = false }
          }
        }
        for (const file of files) {
          const path = file.path.replace(/\\/gu, '/'), digest = path.includes('/sources/v1/content/') ? sourceContentDigest(path.slice(path.lastIndexOf('/') + 1)) : undefined
          if (!digest || !digests.has(digest)) continue
          if (retained.has(digest)) { count('retained', file.path); continue }
          if (unknownHolder || blocked.has(digest)) continue
          try { await store.remove(file.path); count('removed', file.path) } catch { result.complete = false }
        }
      })
    } catch { result.complete = false }
    return result
  }
  /** Capture resource identities before business deletion; byte deletion follows its durable commit. */
  async scopeResourcesLocked(task: HistoryCleanup): Promise<HistoryCleanup> {
    const files = await this.files(); let captured = task
    for (const file of await files.scan()) if (/\/sources\/v1\/references\/[a-f0-9]{64}\.json$/u.test(file.path.replace(/\\/gu, '/'))) {
      const record = parseStoredSourceReference(JSON.parse(await files.read(file.path))), ref = record.reference, scope = ref.scope
      if ((scope.namespaceId === task.scope.namespaceId || task.topicOwnerId && scope.namespaceId === undefined && scope.ownerId === task.topicOwnerId) && scope.topicId === task.scope.topicId && (task.scope.sessionId === '*' || scope.translationSessionId === task.scope.sessionId)) captured = mergeHistoryCleanup(captured, { ...task, sources: [{ sourceId: ref.source.sourceId, sha256: ref.source.sha256 }], references: [{ scope, referenceKey: ref.referenceKey }] })
    }
    return captured
  }
  /** Retire business content first; durable resource identities support explicit retry. */
  async purgeTopicRemote(raw:unknown):Promise<TopicPurgeResult>{
    let request:{operationId:string;ownerId:string;topicId:string;namespaceId?:string}
    try {
      this.authorize();referenceObject(raw);referenceExact(raw,['operationId','ownerId','topicId'],['namespaceId'])
      referenceString(raw.operationId);referenceString(raw.ownerId);referenceString(raw.topicId)
      if(Object.hasOwn(raw,'namespaceId'))referenceString(raw.namespaceId)
      request=raw as typeof request
    } catch { return {operationId:'',cleared:false,error:{code:'incomplete',message:'主题清理参数无效。'}} }
    const topics=this.ctx.get?.('translationTopics') as {ownsAssetConnection?(scope:{namespaceId:string;ownerId:string},peerId:string):boolean}|undefined
    const peer=this.ctx.invocation?.peer.id
    if(!peer||!topics?.ownsAssetConnection||!topics.ownsAssetConnection({namespaceId:request.namespaceId??request.ownerId,ownerId:request.ownerId},peer))
      return {operationId:request.operationId,cleared:false,error:{code:'scope_mismatch',message:'主题清理不属于此客户端连接。'}}
    if(this.hasActiveJobs())return {operationId:request.operationId,cleared:false,error:{code:'busy',message:'仍有运行中、等待处理或结果未知的翻译任务，请先结束或确认。'}}
    try {
      const result = await this.storageWriter()(async()=>{
        if(this.hasActiveJobs())throw stopped('仍有运行中、等待处理或结果未知的任务，请先结束或确认。')
        const namespaceId=request.namespaceId??request.ownerId, history=this.ctx.get?.('translationHistory') as HistoryService|undefined, memory=this.ctx.get?.('translationOtherMemory') as OtherMemoryService|undefined
        const db=await memory?.databaseForArchives(true), originals=await memory?.topicSourcesLocked(namespaceId,request.topicId)??[]
        let task=await this.scopeResourcesLocked({scope:{namespaceId,topicId:request.topicId,sessionId:'*'},unitId:'*',topicOwnerId:request.ownerId,sources:originals.map(source=>({sourceId:source.sourceId,sha256:source.sha256})),references:[]})
        task=mergeHistoryCleanup(db?.historyCleanups().find(value=>value.scope.namespaceId===namespaceId&&value.scope.topicId===request.topicId&&value.scope.sessionId==='*'&&value.unitId==='*'),task)
        db?.historyCleanupSave(task)
        await history?.retireTopicLocked(namespaceId,request.topicId)
        await (this.ctx.get?.('translationArchive') as TopicArchiveService|undefined)?.retireTopicLocked(namespaceId,request.topicId)
        await (this.ctx.get?.('translationTerms') as TopicTermsService|undefined)?.retireTopicLocked(namespaceId,request.topicId)
        await memory?.retireTopicLocked(namespaceId,request.topicId)
        ;(this.ctx.get?.('translationObjects') as {forgetTopic?(ownerId:string,topicId:string):void}|undefined)?.forgetTopic?.(request.ownerId,request.topicId)
        ;(this.ctx.get?.('translationReferences') as {forgetTopic?(topicId:string,ownerId:string):void}|undefined)?.forgetTopic?.(request.topicId,request.ownerId)
        ;(this.ctx.get?.('translationSources') as TranslationSourcesService|undefined)?.forgetTopic?.(request.topicId,request.ownerId,request.namespaceId)
        const resourceCleanup=history?await history.cleanupTopicResourcesLocked(namespaceId,request.topicId):await this.cleanupHistoryUnitLocked(task,{scope:task.scope,unitId:'*',sources:[],references:[]})
        if(!history&&resourceCleanup.complete)db?.historyCleanupRemove(namespaceId,'*','*')
        return {operationId:request.operationId,cleared:true as const,resourceCleanup}
      })
      ;(this.ctx.get?.('translationMemorySearch') as { forgetTopic(namespaceId:string,topicId:string):void }|undefined)?.forgetTopic(request.namespaceId??request.ownerId,request.topicId)
      return result
    } catch(error) {
      const known=error as {code?:string;message?:string}
      return {operationId:request.operationId,cleared:false,error:{code:known.code==='local_data_blocked'?'busy':'incomplete',
        message:known.code?.startsWith('local_data_')?known.message??'主题文件清理未完成。':'无法读取或清理主题文件，请检查宿主存储权限并重试同一操作。'}}
    }
  }
  /** Reclaims unheld originals; provenance and released mappings do not retain source bytes. */
  async reclaimRemote(raw:unknown):Promise<SourceReclaimResult>{
    let request:{operationId:string}
    try {
      this.authorize();referenceObject(raw);referenceExact(raw,['operationId']);referenceString(raw.operationId);request=raw as typeof request
    } catch { return {operationId:'',reclaimed:false,error:{code:'incomplete',message:'原稿回收参数无效。'}} }
    if(this.hasActiveJobs())return {operationId:request.operationId,reclaimed:false,error:{code:'busy',message:'仍有运行中、等待处理或结果未知的翻译任务，请先结束或确认。'}}
    try {
      const pending = await this.storageWriter()(() => (this.ctx.get?.('translationHistory') as HistoryService | undefined)?.cleanupResourcesLocked() ?? Promise.resolve({complete:true,removed:0,retained:0}))
      if (!pending.complete) return { operationId: request.operationId, reclaimed: false, resourceCleanup: pending, error: { code: 'incomplete', message: '已删内容的文件清理仍有未完成项，请完成在途文件读取／打开或检查存储权限后重试；正文不会恢复。' } }
      return await this.withSourceCleanup(()=>this.storageWriter()(async()=>{
        if(this.hasActiveJobs())throw stopped('仍有运行中、等待处理或结果未知的任务，请先结束或确认。')
        const store=await this.files(), files=await store.scan(), referenced=new Set<string>(), contents:{path:string;name:string;bytes:number}[]=[]
        const held=await (this.ctx.get?.('translationOtherMemory') as OtherMemoryService|undefined)?.heldSourceDigests()
        for(const digest of held??[])referenced.add(digest)
        for(const source of (await (this.ctx.get?.('translationHistory') as HistoryService|undefined)?.resourceHoldersLocked())?.sources??[])referenced.add(source.sha256)
        for(const digest of (this.ctx.get?.('translationSources') as TranslationSourcesService|undefined)?.heldSourceDigests?.(new Set((this.ctx.get?.('translationMaterials') as { heldSourceIds?(): readonly string[] }|undefined)?.heldSourceIds?.()??[]))??[])referenced.add(digest)
        let incomplete=false, unknownHolder=false
        for(const file of files){
          const name=file.path.replace(/\\/gu,'/')
          const reference=/\/sources\/v1\/references\/([a-f0-9]{64})\.json$/u.exec(name)
          const content=name.includes('/sources/v1/content/')?sourceContentDigest(name.slice(name.lastIndexOf('/')+1)):undefined
          if(reference){
            let raw:unknown
            try {
              raw=JSON.parse(await store.read(file.path))
              const record=parseStoredSourceReference(raw)
              if(record.reference.state!=='released')referenced.add(record.reference.source.sha256)
            } catch {
              incomplete=true
              // A damaged known mapping retains only its identifiable body. Unknown identity retains all.
              const digest=(raw as {reference?:{source?:{sha256?:unknown}}}|undefined)?.reference?.source?.sha256
              if(typeof digest==='string'&&/^[a-f0-9]{64}$/u.test(digest))referenced.add(digest)
              else unknownHolder=true
            }
          } else if(content) contents.push({path:file.path,name:content,bytes:file.bytes})
        }
        let removed=0,bytes=0
        for(const content of contents) if(!unknownHolder&&!referenced.has(content.name)){
          try{await store.remove(content.path);removed++;bytes+=content.bytes}catch{incomplete=true}
        }
        if(incomplete)return {operationId:request.operationId,reclaimed:false as const,resourceCleanup:pending,error:{code:'incomplete' as const,
          message:`原稿回收未完成；已移除 ${removed} 个文件（${bytes} 字节）。无法核对的持有关系或未能删除的文件已保留，请重试同一操作。`}}
        return {operationId:request.operationId,reclaimed:true as const,removed,bytes,resourceCleanup:pending}
      }))
    } catch(error) {
      const known=error as {code?:string;message?:string}
      return {operationId:request.operationId,reclaimed:false,error:{code:known.code==='local_data_blocked'?'busy':'incomplete',
        message:known.code?.startsWith('local_data_')?known.message??'原稿回收未完成。':'无法读取或回收原稿文件，请检查宿主存储权限并重试同一操作。'}}
    }
  }
  async clearLocalDataRemote(raw:unknown):Promise<LocalDataClearResult>{
    this.authorize();referenceObject(raw);referenceExact(raw,['operationId']);referenceString(raw.operationId)
    try {
    if(this.complete)return {operationId:raw.operationId,cleared:true}
    const services=['translationHistory','translationMemorySearch','translationEmbedding','translationFileJobs','translationQuick','translationNormal','translationBatch','translationAnalysis','translationReview','translationCorrection','translationMaterials','translationObjects','translationSources','translationReferences','translationArchive','translationTerms','translationOtherMemoryFiles','translationOtherMemory','translationPreparation','translationPlanning','translationTopics']
    if(!this.blocked&&services.some(name=>(this.ctx.get?.(name) as Service|undefined)?.hasActiveJobs?.()))throw Object.assign(new Error('仍有运行中、等待处理或结果未知的翻译任务，请先结束或确认任务。'), {code:'local_data_busy'})
    // Resolve the complete bounded file inventory before interrupting services or deleting bytes.
    const files=await this.files();await files.scan()
    this.blocked=true;this.generation++
    for(const name of services)await (this.ctx.get?.(name) as Service|undefined)?.dispose?.()
    try { await (this.ctx.get?.('translationEmbedding') as EmbeddingService|undefined)?.clearManagedData() }
    catch { throw stopped('嵌入配置或插件专属凭据未能清理，请检查宿主凭据服务后重试全清。') }
    await this.tail
    for(const file of await files.scan())await files.remove(file.path)
    this.complete=true;return {operationId:raw.operationId,cleared:true}
    } catch(error) {
      const known=error as {code?:string;message?:string}
      return {operationId:raw.operationId,cleared:false,error:{code:known.code==='local_data_busy'?'busy':'incomplete',
        message:known.code?.startsWith('local_data_') ? known.message ?? '本地数据清理未完成。' : '无法读取或清理插件文件，请检查宿主存储权限并重试同一操作。'}}
    }
  }
}
