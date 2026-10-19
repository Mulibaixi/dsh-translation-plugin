import { referenceExact, referenceObject, referenceString, referenceInteger } from './reference-memory.js'

export interface HostStorageUsage { readonly files: number; readonly bytes: number }
export type LocalDataClearResult = {readonly operationId:string;readonly cleared:true}
  | {readonly operationId:string;readonly cleared:false;readonly error:{readonly code:'busy'|'incomplete';readonly message:string}}
export interface TopicPurgeRemoved { readonly objects: number; readonly sources: number; readonly references: number }
export type TopicPurgeResult = {readonly operationId:string;readonly cleared:true;readonly removed:TopicPurgeRemoved}
  | {readonly operationId:string;readonly cleared:false;readonly error:{readonly code:'busy'|'incomplete'|'scope_mismatch';readonly message:string}}
export type SourceReclaimResult = {readonly operationId:string;readonly reclaimed:true;readonly removed:number;readonly bytes:number}
  | {readonly operationId:string;readonly reclaimed:false;readonly error:{readonly code:'busy'|'incomplete';readonly message:string}}
export interface LocalDataRemotePort {
  usageRemote(): Promise<unknown>
  clearLocalDataRemote(request: { readonly operationId: string }): Promise<unknown>
  purgeTopicRemote(request: { readonly operationId: string; readonly ownerId: string; readonly topicId: string; readonly namespaceId?: string }): Promise<unknown>
  reclaimRemote(request: { readonly operationId: string }): Promise<unknown>
}
const packageName = 'dsh-translation-plugin'
const codec = (name: string, parse: (value: unknown) => unknown) => ({ mode: 'strict' as const, typeSymbol: `${packageName}#localData/${name}`, create: () => ({ parse }) })
export const LOCAL_DATA_REMOTE = { package: packageName, descriptors: [
  { id: `${packageName}#translationLocalData/usageRemote`, service: 'translationLocalData', namespace: 'translationLocalData', method: 'usageRemote', invocation: {kind:'direct' as const}, parameters: [], result: codec('usage', value => {
    referenceObject(value); referenceExact(value,['files','bytes']); referenceInteger(value.files); referenceInteger(value.bytes); return value
  }) },
  { id: `${packageName}#translationLocalData/clearLocalDataRemote`, service: 'translationLocalData', namespace: 'translationLocalData', method: 'clearLocalDataRemote', invocation: {kind:'direct' as const},
    parameters:[{name:'request',wire:'request',source:'json' as const,codec:codec('clear',value=>{referenceObject(value);referenceExact(value,['operationId']);referenceString(value.operationId);return value})}],
    result:codec('cleared',value=>{
      referenceObject(value);referenceString(value.operationId)
      if(value.cleared===true)referenceExact(value,['operationId','cleared'])
      else if(value.cleared===false){referenceExact(value,['operationId','cleared','error']);referenceObject(value.error);referenceExact(value.error,['code','message']);referenceString(value.error.message);if(!['busy','incomplete'].includes(String(value.error.code)))throw new TypeError('Invalid local data failure')}
      else throw new TypeError('Invalid local data receipt')
      return value
    }) },
  { id: `${packageName}#translationLocalData/purgeTopicRemote`, service: 'translationLocalData', namespace: 'translationLocalData', method: 'purgeTopicRemote', invocation: {kind:'direct' as const},
    parameters:[{name:'request',wire:'request',source:'json' as const,codec:codec('purge-topic',value=>{
      referenceObject(value);referenceExact(value,['operationId','ownerId','topicId'],['namespaceId'])
      referenceString(value.operationId);referenceString(value.ownerId);referenceString(value.topicId)
      if(Object.hasOwn(value,'namespaceId'))referenceString(value.namespaceId)
      return value
    })}],
    result:codec('purged',value=>{
      referenceObject(value);referenceString(value.operationId)
      if(value.cleared===true){
        referenceExact(value,['operationId','cleared','removed']);referenceObject(value.removed);referenceExact(value.removed,['objects','sources','references'])
        referenceInteger(value.removed.objects);referenceInteger(value.removed.sources);referenceInteger(value.removed.references)
      } else if(value.cleared===false){
        referenceExact(value,['operationId','cleared','error']);referenceObject(value.error);referenceExact(value.error,['code','message']);referenceString(value.error.message)
        if(!['busy','incomplete','scope_mismatch'].includes(String(value.error.code)))throw new TypeError('Invalid topic purge failure')
      } else throw new TypeError('Invalid topic purge receipt')
      return value
    }) },
  { id: `${packageName}#translationLocalData/reclaimRemote`, service: 'translationLocalData', namespace: 'translationLocalData', method: 'reclaimRemote', invocation: {kind:'direct' as const},
    parameters:[{name:'request',wire:'request',source:'json' as const,codec:codec('reclaim',value=>{referenceObject(value);referenceExact(value,['operationId']);referenceString(value.operationId);return value})}],
    result:codec('reclaimed',value=>{
      referenceObject(value);referenceString(value.operationId)
      if(value.reclaimed===true){referenceExact(value,['operationId','reclaimed','removed','bytes']);referenceInteger(value.removed);referenceInteger(value.bytes)}
      else if(value.reclaimed===false){referenceExact(value,['operationId','reclaimed','error']);referenceObject(value.error);referenceExact(value.error,['code','message']);referenceString(value.error.message);if(!['busy','incomplete'].includes(String(value.error.code)))throw new TypeError('Invalid source reclaim failure')}
      else throw new TypeError('Invalid source reclaim receipt')
      return value
    }) },
] }
