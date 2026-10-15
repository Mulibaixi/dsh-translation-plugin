import { referenceExact, referenceObject, referenceString, referenceInteger } from './reference-memory.js'

export interface HostStorageUsage { readonly files: number; readonly bytes: number }
export type LocalDataClearResult = {readonly operationId:string;readonly cleared:true}
  | {readonly operationId:string;readonly cleared:false;readonly error:{readonly code:'busy'|'incomplete';readonly message:string}}
export interface LocalDataRemotePort {
  usageRemote(): Promise<unknown>
  clearLocalDataRemote(request: { readonly operationId: string }): Promise<unknown>
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
] }
