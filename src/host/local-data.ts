import type { TopicHostContext } from './topic-tools.js'
import type { HostStorageUsage, LocalDataClearResult, TopicPurgeResult, SourceReclaimResult } from '../shared/local-data.js'
import { referenceExact, referenceObject, referenceString } from '../shared/reference-memory.js'
import { isViewFileStorageName } from './view-files.js'
import { parseStoredSourceReference } from './source-storage.js'

type Files = { scan(): Promise<readonly {path:string;bytes:number}[]>; read(path:string):Promise<string>; remove(path:string):Promise<void> }
type Service = { dispose?():void|Promise<void>; hasActiveJobs?():boolean }
function stopped(message: string): Error { return Object.assign(new Error(message), {code:'local_data_blocked'}) }
async function filesFor(ctx: TopicHostContext): Promise<Files> {
  const loader=ctx.get?.('loader') as {internal?:{import(name:string,anchor:string,options:object):Promise<unknown>}}|undefined
  if(!ctx.baseUrl||!loader?.internal)throw stopped('宿主本地数据存储尚未就绪。')
  const home=await loader.internal.import('@deepseek-ai/dsh-home-paths',ctx.baseUrl,{}) as {dshHomePath(...parts:string[]):string}
  const fsName='node:fs/promises',pathName='node:path'
  const fs=await import(fsName) as {readdir(path:string,options:object):Promise<{name:string;isFile():boolean}[]>;stat(path:string):Promise<{size:number}>;lstat(path:string):Promise<{isSymbolicLink():boolean}>;unlink(path:string):Promise<void>;readFile(path:string,encoding:'utf8'):Promise<string>}
  const path=await import(pathName) as {join(...parts:string[]):string;resolve(path:string):string;dirname(path:string):string}
  const roots=[['sources','v1','content'],['sources','v1','references'],['references','v1'],['views','v1'],['objects','v1']].map(parts=>path.resolve(home.dshHomePath('translation-plugin',...parts)))
  const directories=[[],['sources'],['sources','v1'],['sources','v1','content'],['sources','v1','references'],['references'],['references','v1'],['views'],['views','v1'],['objects'],['objects','v1']].map(parts=>home.dshHomePath('translation-plugin',...parts))
  const allowed=(file:string):boolean=>{const name=file.slice(Math.max(file.lastIndexOf('/'),file.lastIndexOf('\\'))+1);return roots.includes(path.dirname(path.resolve(file)))&&(/^[a-f0-9]{64}\.(json|txt)$/.test(name)||isViewFileStorageName(name)||/^asset-[0-9a-f-]{36}\.json$/.test(name))}
  return {
    async scan(){const files:{path:string;bytes:number}[]=[];
      for(const directory of directories){try{if((await fs.lstat(directory)).isSymbolicLink())throw stopped('插件存储目录是链接，实际清理范围未确认。')}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}}
      for(const root of roots){let entries:Awaited<ReturnType<typeof fs.readdir>>;try{entries=await fs.readdir(root,{withFileTypes:true})}catch(error){if((error as {code?:string}).code==='ENOENT')continue;throw error}
      for(const entry of entries){const file=path.join(root,entry.name);if(!entry.isFile()||!allowed(file))throw stopped('插件存储包含无法识别的条目，清理范围未确认。');files.push({path:file,bytes:(await fs.stat(file)).size})}}
      return files},
    async read(file){if(!allowed(file))throw stopped('读取路径超出插件存储范围。');return fs.readFile(file,'utf8')},
    async remove(file){if(!allowed(file))throw stopped('清理路径超出插件存储范围。');try{await fs.unlink(file)}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}},
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
    const services=['translationFileJobs','translationQuick','translationNormal','translationBatch','translationReview','translationMaterials']
    return services.some(name=>(this.ctx.get?.(name) as Service|undefined)?.hasActiveJobs?.())
  }
  async usageRemote():Promise<HostStorageUsage>{this.authorize();const files=await(await this.files()).scan();return {files:files.length,bytes:files.reduce((sum,file)=>sum+file.bytes,0)}}
  /** Removes only the Host registrations owned by one topic; shared source bodies stay for explicit reclamation. */
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
      return await this.storageWriter()(async()=>{
        const store=await this.files(), files=await store.scan()
        const targets:{path:string;kind:'objects'|'sources'|'references'}[]=[]
        for(const file of files){
          const name=file.path.replace(/\\/gu,'/')
          if(/\/objects\/v1\/asset-[0-9a-f-]{36}\.json$/u.test(name)){
            const value=JSON.parse(await store.read(file.path)) as {ownerId?:unknown;topicId?:unknown}
            if(value&&typeof value==='object'&&value.ownerId===request.ownerId&&value.topicId===request.topicId)targets.push({path:file.path,kind:'objects'})
          } else if(/\/sources\/v1\/references\/[a-f0-9]{64}\.json$/u.test(name)){
            const record=parseStoredSourceReference(JSON.parse(await store.read(file.path)))
            if(record.reference.scope.topicId===request.topicId)targets.push({path:file.path,kind:'sources'})
          } else if(/\/references\/v1\/[a-f0-9]{64}\.json$/u.test(name)){
            const value=JSON.parse(await store.read(file.path)) as {scope?:{topicId?:unknown;namespaceId?:unknown}}
            if(value&&typeof value==='object'&&value.scope?.topicId===request.topicId&&(!request.namespaceId||value.scope.namespaceId===request.namespaceId))
              targets.push({path:file.path,kind:'references'})
          }
        }
        const removed={objects:0,sources:0,references:0}
        for(const target of targets){await store.remove(target.path);removed[target.kind]++}
        ;(this.ctx.get?.('translationObjects') as {forgetTopic?(ownerId:string,topicId:string):void}|undefined)?.forgetTopic?.(request.ownerId,request.topicId)
        ;(this.ctx.get?.('translationReferences') as {forgetTopic?(topicId:string,ownerId:string):void}|undefined)?.forgetTopic?.(request.topicId,request.ownerId)
        return {operationId:request.operationId,cleared:true as const,removed}
      })
    } catch(error) {
      const known=error as {code?:string;message?:string}
      return {operationId:request.operationId,cleared:false,error:{code:known.code==='local_data_blocked'?'busy':'incomplete',
        message:known.code?.startsWith('local_data_')?known.message??'主题文件清理未完成。':'无法读取或清理主题文件，请检查宿主存储权限并重试同一操作。'}}
    }
  }
  /** Deletes source bodies that no saved scope mapping references; never touches a live mapping. */
  async reclaimRemote(raw:unknown):Promise<SourceReclaimResult>{
    let request:{operationId:string}
    try {
      this.authorize();referenceObject(raw);referenceExact(raw,['operationId']);referenceString(raw.operationId);request=raw as typeof request
    } catch { return {operationId:'',reclaimed:false,error:{code:'incomplete',message:'原稿回收参数无效。'}} }
    if(this.hasActiveJobs())return {operationId:request.operationId,reclaimed:false,error:{code:'busy',message:'仍有运行中、等待处理或结果未知的翻译任务，请先结束或确认。'}}
    try {
      return await this.storageWriter()(async()=>{
        const store=await this.files(), files=await store.scan(), referenced=new Set<string>(), contents:{path:string;name:string;bytes:number}[]=[]
        for(const file of files){
          const name=file.path.replace(/\\/gu,'/')
          const reference=/\/sources\/v1\/references\/([a-f0-9]{64})\.json$/u.exec(name), content=/\/sources\/v1\/content\/([a-f0-9]{64})\.txt$/u.exec(name)
          if(reference){
            const record=parseStoredSourceReference(JSON.parse(await store.read(file.path)))
            referenced.add(record.reference.source.sha256)
          } else if(content) contents.push({path:file.path,name:content[1]!,bytes:file.bytes})
        }
        let removed=0,bytes=0
        for(const content of contents) if(!referenced.has(content.name)){await store.remove(content.path);removed++;bytes+=content.bytes}
        return {operationId:request.operationId,reclaimed:true as const,removed,bytes}
      })
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
    const services=['translationFileJobs','translationQuick','translationNormal','translationBatch','translationAnalysis','translationReview','translationCorrection','translationMaterials','translationObjects','translationSources','translationReferences','translationPreparation','translationPlanning','translationTopics']
    if(!this.blocked&&services.some(name=>(this.ctx.get?.(name) as Service|undefined)?.hasActiveJobs?.()))throw Object.assign(new Error('仍有运行中、等待处理或结果未知的翻译任务，请先结束或确认任务。'), {code:'local_data_busy'})
    // Resolve the complete bounded file inventory before interrupting services or deleting bytes.
    const files=await this.files();await files.scan()
    this.blocked=true;this.generation++
    for(const name of services)await (this.ctx.get?.(name) as Service|undefined)?.dispose?.()
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
