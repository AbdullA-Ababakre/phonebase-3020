import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PLATFORMS = ['instagram', 'facebook'] as const;
export type Platform = typeof PLATFORMS[number];
export type PublishPlan = { mode?:'once'; batchId?:string; claimedAt?:number; id:string; mediaId:string; deviceId:string; caption:string; time:string; timezone:string; platforms:Platform[]; enabled:boolean; nextRun:number; createdAt:number };
export type PublishMedia = { id:string; name:string; bytes:number; sha256:string; duration:number; width:number; height:number; path:string; album:string; prepared:boolean; preparedDeviceId?:string; createdAt:number };
export type PublishStep = { id:string; label:string; expect:string[]; absent?:string[]; optional?:boolean; timeoutMs?:number; action?:{type:string;[key:string]:unknown}; targetText?:string; targetMatch?:'unique'|'leftmost'|'label'; targetOffset?:{x:number;y:number}; caption?:boolean; submit?:boolean; verify?:boolean; postCount?:'capture'|'increment'; freshPost?:boolean };
export type PublishWorkflow = { transfer?:'lan'; acceptedRunId?:string; mediaId?:string; id:string; platform:Platform; deviceId:string; name:string; version:number; account:string; trained:boolean; steps:PublishStep[]; updatedAt:number };
export type PublishRun = { id:string;planId:string;platform:Platform;deviceId:string;dueAt:number;trigger?:'scheduled'|'manual';status:string;startedAt:number;endedAt:number|null;step:string;error:string;submitted:boolean;evidence:string[];snapshot:PublishPlan;workflowVersion:number };

export function validatePlan(input:unknown): Omit<PublishPlan,'id'|'createdAt'|'nextRun'> {
  const p=input as PublishPlan;
  if(!p || !/^[\w-]{1,120}$/.test(p.mediaId??'') || !/^[\w-]{1,120}$/.test(p.deviceId??'')) throw Error('请选择视频和手机');
  if(typeof p.caption!=='string'||p.caption.length>2200)throw Error('Caption 最多 2200 个字符');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time??''))throw Error('请输入有效的每日发送时间');
  try {new Intl.DateTimeFormat('en',{timeZone:p.timezone}).format();}catch{throw Error('时区无效');}
  if(typeof p.timezone!=='string'||!p.timezone)throw Error('请选择时区');
  if(!Array.isArray(p.platforms)||!p.platforms.length||p.platforms.some(x=>!PLATFORMS.includes(x)))throw Error('请选择 Instagram 或 Facebook');
  return {mediaId:p.mediaId,deviceId:p.deviceId,caption:p.caption,time:p.time,timezone:p.timezone,platforms:[...new Set(p.platforms)],enabled:p.enabled===true};
}

// Absolute minute iteration handles DST gaps and folds without guessing UTC offsets.
export function nextDaily(time:string,timezone:string,after:number):number {
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const start=Math.floor(after/60000)*60000+60000;
  for(let t=start;t<start+72*3600000;t+=60000)if(fmt.format(t)===time)return t;
  throw Error('无法计算下次发送时间');
}
// Reserve a slot per video. Existing queue items keep their assigned times.
export function allocateSlots(count:number,times:string[],timezone:string,after:number,reserved:number[]=[]):number[]{
  if(!Number.isInteger(count)||count<1||count>200)throw Error('每批请选择 1–200 个视频');
  if(!Array.isArray(times)||!times.length||times.length>24||times.some(t=>typeof t!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))throw Error('请设置有效的每日发布时间');
  if(typeof timezone!=='string'||!timezone)throw Error('请选择时区');
  new Intl.DateTimeFormat('en',{timeZone:timezone});
  const slots=[...new Set(times)].sort(),occupied=new Set(reserved),result:number[]=[];
  let cursor=after;
  const candidates=slots.map(t=>nextDaily(t,timezone,cursor));
  while(result.length<count){
    cursor=Math.min(...candidates);
    if(!occupied.has(cursor))result.push(cursor);
    for(let i=0;i<candidates.length;i++)if(candidates[i]===cursor)candidates[i]=nextDaily(slots[i],timezone,cursor);
  }
  return result;
}
export function occurrenceDate(timezone:string,t:number):string {
  return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(t);
}

export class PublishingStore {
  db:DatabaseSync;
  constructor(path:string){
    mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS publishing_media(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS publishing_plans(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS publishing_workflows(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS publishing_runs(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, platform TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(plan_id,platform,day));');
  }
  all<T>(table:string):T[]{return (this.db.prepare(`SELECT data FROM publishing_${table} ORDER BY rowid DESC`).all() as {data:string}[]).map(x=>JSON.parse(x.data));}
  get<T>(table:string,id:string):T|undefined{const r=this.db.prepare(`SELECT data FROM publishing_${table} WHERE id=?`).get(id) as {data:string}|undefined;return r?JSON.parse(r.data):undefined;}
  put(table:'media'|'plans'|'workflows',value:{id:string}){this.db.prepare(`INSERT INTO publishing_${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id,JSON.stringify(value));}
  run(value:PublishRun){this.db.prepare('UPDATE publishing_runs SET data=? WHERE id=?').run(JSON.stringify(value),value.id);}
  claim(plan:PublishPlan,platform:Platform,dueAt:number,workflowVersion:number):PublishRun|null{
    const run:PublishRun={id:randomUUID(),planId:plan.id,platform,deviceId:plan.deviceId,dueAt,trigger:'scheduled',status:'queued',startedAt:Date.now(),endedAt:null,step:'排队',error:'',submitted:false,evidence:[],snapshot:structuredClone(plan),workflowVersion};
    const r=this.db.prepare('INSERT OR IGNORE INTO publishing_runs(id,plan_id,platform,day,data) VALUES(?,?,?,?,?)').run(run.id,plan.id,platform,occurrenceDate(plan.timezone,dueAt),JSON.stringify(run));return r.changes?run:null;
  }
  claimManual(plan:PublishPlan,platform:Platform,workflowVersion:number):PublishRun {
    const dueAt=Date.now();
    const run:PublishRun={id:randomUUID(),planId:plan.id,platform,deviceId:plan.deviceId,dueAt,trigger:'manual',status:'queued',startedAt:dueAt,endedAt:null,step:'排队',error:'',submitted:false,evidence:[],snapshot:structuredClone(plan),workflowVersion};
    this.db.prepare('INSERT INTO publishing_runs(id,plan_id,platform,day,data) VALUES(?,?,?,?,?)').run(run.id,plan.id,platform,`manual:${run.id}`,JSON.stringify(run));
    return run;
  }
  recover(){for(const r of this.all<PublishRun>('runs'))if(['queued','running'].includes(r.status)){r.status=r.submitted?'needs_review':'interrupted';r.error=r.submitted?'服务重启，发布结果待核实，未自动重发':'服务重启，任务已中断';r.endedAt=Date.now();this.run(r);}}
  close(){this.db.close();}
}
