import { Worker } from 'node:worker_threads';
import type { EventInput, ObservabilityStore } from './observability';

/** Disk writes and historical queries never run on the device-control event loop. */
export class ObservabilityClient {
  private worker: Worker;
  private nextId=0;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private failed=false;
  private dropped=0;
  constructor(path:string){
    this.worker=new Worker(new URL('./observability-worker.mjs',import.meta.url),{workerData:{path}});
    this.worker.on('message',message=>{
      const pending=this.pending.get(message.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      if(message.error)pending.reject(new Error(message.error));else pending.resolve(message.result);
    });
    const failed=()=>{this.failed=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Activity storage unavailable'))}this.pending.clear()};
    this.worker.on('error',failed);this.worker.on('exit',failed);this.worker.unref();
  }
  private call(method:string,args:unknown[]):Promise<unknown>{
    if(this.failed || this.pending.size>=10000)return Promise.reject(new Error('Activity storage unavailable'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Activity storage timeout'))},10000);timer.unref();
      this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,method,args});
    });
  }
  record(event:EventInput){void this.call('record',[event]).catch(()=>{this.dropped++})}
  flag(...args:Parameters<ObservabilityStore['flag']>){void this.call('flag',args).catch(()=>{this.dropped++})}
  async query(params:URLSearchParams){return await this.call('query',[params.toString()]) as ReturnType<ObservabilityStore['query']>}
  async summary(){
    const value=await this.call('summary',[]) as ReturnType<ObservabilityStore['summary']>;
    return {...value,storage:{...value.storage,writeFailures:value.storage.writeFailures+this.dropped,pendingWrites:this.pending.size}};
  }
  async flush(){await this.call('summary',[])}
}
