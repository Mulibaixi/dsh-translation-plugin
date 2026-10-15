import type { LocalDataRemotePort, HostStorageUsage } from '../shared/local-data.js'
import { LOCAL_DATA_GENERATION } from './storage-fence.js'
import { PLUGIN_STORAGE_PREFIX } from './storage-usage.js'
import { h, react } from './react.js'
import { styles } from './view-styles.js'

/** The generation barrier is written before asynchronous Host cleanup begins. */
export class LocalDataClient {
  private readonly listeners=new Set<()=>void>()
  private frozen=false
  private clearing=false
  private cleared=false
  private operationId:string|undefined
  private message:string|undefined
  private readonly storage:Storage|undefined
  private readonly generation:string|null
  private readonly onStorage=(event:StorageEvent):void=>{if(event.storageArea===this.storage&&event.key===LOCAL_DATA_GENERATION&&event.newValue!==this.generation&&event.newValue?.startsWith('cleared:'))this.freeze()}
  constructor(private readonly remote:()=>Promise<LocalDataRemotePort|undefined>,private readonly stop:()=>Promise<void>,private readonly busy:()=>boolean){
    let storage:Storage|undefined
    try{storage=typeof window==='undefined'?undefined:window.localStorage}catch{ /* Report unavailable on clear. */ }
    this.storage=storage
    let generation:string|null=null
    try{generation=storage?.getItem(LOCAL_DATA_GENERATION)??null}catch{ /* Clearing reports inaccessible storage. */ }
    this.generation=generation
    if(typeof window!=='undefined')window.addEventListener('storage',this.onStorage)
  }
  subscribe(listener:()=>void):()=>void{this.listeners.add(listener);return()=>this.listeners.delete(listener)}
  private emit():void{for(const listener of this.listeners)listener()}
  private freeze():void{if(this.frozen)return;this.frozen=true;void this.stop();this.emit()}
  isFrozen():boolean{return this.frozen}
  isClearing():boolean{return this.clearing}
  isCleared():boolean{return this.cleared}
  getMessage():string|undefined{return this.message}
  async usage():Promise<HostStorageUsage|undefined>{
    try{const reply=await(await this.remote())?.usageRemote() as {ok?:boolean;value?:HostStorageUsage}|undefined;return reply?.ok===true?reply.value:undefined}catch{return undefined}
  }
  async clear():Promise<void>{
    if(this.clearing)return
    if(!this.frozen&&this.busy()){this.message='仍有运行中、等待处理或结果未知的翻译，请先结束或确认任务。';this.emit();return}
    this.clearing=true;this.message=undefined;this.emit()
    try{
      if(!this.storage)throw new Error('浏览器存储不可访问，无法确认完整清理。')
      const remote=await this.remote();if(!remote)throw new Error('宿主清理服务尚未就绪。')
      this.operationId??=`local-data-clear:${crypto.randomUUID()}`
      const previousGeneration=this.storage.getItem(LOCAL_DATA_GENERATION)
      this.storage.setItem(LOCAL_DATA_GENERATION,`pending:${this.operationId}`)
      const reply=await remote.clearLocalDataRemote({operationId:this.operationId}) as {ok?:boolean;value?:{cleared?:boolean;operationId?:string;error?:{code?:string;message?:string}};error?:{message?:string;code?:string}}
      if(reply.ok===true&&reply.value?.error?.code==='busy'&&!this.frozen){
        if(previousGeneration===null)this.storage.removeItem(LOCAL_DATA_GENERATION)
        else this.storage.setItem(LOCAL_DATA_GENERATION,previousGeneration)
        throw new Error(reply.value.error.message)
      }
      this.storage.setItem(LOCAL_DATA_GENERATION,`cleared:${this.operationId}`)
      this.frozen=true;await this.stop();this.emit()
      if(reply.ok!==true||reply.value?.cleared!==true||reply.value.operationId!==this.operationId)throw new Error(reply.value?.error?.message??reply.error?.message??'宿主清理回执未确认。')
      const keys:string[]=[]
      for(let at=0;at<this.storage.length;at++){const key=this.storage.key(at);if(key?.startsWith(PLUGIN_STORAGE_PREFIX)&&key!==LOCAL_DATA_GENERATION)keys.push(key)}
      for(const key of keys)this.storage.removeItem(key)
      this.cleared=true
      this.message='本插件的本地数据已清除。请关闭后重新启用翻译插件。'
    }catch(error){
      try{if(this.operationId&&this.storage?.getItem(LOCAL_DATA_GENERATION)?.endsWith(this.operationId)){
        this.storage.setItem(LOCAL_DATA_GENERATION,`cleared:${this.operationId}`);this.frozen=true;await this.stop()
      }}catch{this.frozen=true}
      this.message=`清理尚未完成：${error instanceof Error?error.message:'请重试同一清理操作。'}${this.frozen?' 当前翻译已停止，请重试清理；完成后重新启用插件。':''}`
    }
    finally{this.clearing=false;this.emit()}
  }
  dispose():void{if(typeof window!=='undefined')window.removeEventListener('storage',this.onStorage);this.listeners.clear()}
}
export function useLocalDataFrozen(data:LocalDataClient):boolean{
  const [,update]=react.useState(0)
  react.useEffect(()=>data.subscribe(()=>update(value=>value+1)),[data])
  return data.isFrozen()
}
export function ClearedDataView():unknown{return h('section',{className:'dsh-tp'},h('style',null,styles),h('p',{role:'status',className:'dsh-tp-message'},'本地数据已进入清理流程。请在设置中确认清理完成，再关闭后重新启用翻译插件。'))}
export function LocalDataClearView({data}:{readonly data:LocalDataClient}):unknown{
  useLocalDataFrozen(data)
  const [confirm,setConfirm]=react.useState(false)
  return h('section',{className:'dsh-tp dsh-tp-settings-section'},h('style',null,styles),h('h3',null,'本地数据'),
    h('p',{className:'dsh-tp-muted'},'清除当前浏览器来源中的本插件数据，以及当前 DSH 数据目录中的插件自有原稿和参考片段。包含会话、记忆资产、准备记录、偏好和设置。用户原文件、主聊天附件与聊天历史保留。清除后需重新启用插件。'),
    data.isCleared()?null:h('button',{type:'button',disabled:data.isClearing(),onClick:()=>setConfirm(true)},data.isFrozen()?'重试清除本地数据':'清除本地数据'),
    confirm?h('div',{role:'alertdialog','aria-label':'清除本地数据确认'},h('p',null,'确定永久清除上述本地数据？此操作无法撤销。'),
      h('button',{type:'button',disabled:data.isClearing(),onClick:()=>{setConfirm(false);void data.clear()}},'确认清除'),
      h('button',{type:'button',disabled:data.isClearing(),onClick:()=>setConfirm(false)},'取消')):null,
    data.getMessage()?h('p',{role:'status',className:'dsh-tp-message'},data.getMessage()):null)
}
