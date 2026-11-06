import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PublishingStore, allocateSlots, nextDaily, validatePlan, PLATFORMS, type PublishPlan, type PublishMedia, type PublishWorkflow, type PublishRun } from './publishing-store';
import { PublishingRunner, workflowIssue } from './publishing-runner';
import {instagramCandidate} from './publishing-instagram';
import {openPublishingTransfer} from './publishing-transfer';
import {writeFile} from 'node:fs/promises';

const exec=promisify(execFile);
const MAX_VIDEO=500*1024*1024;
async function body(req:IncomingMessage){let bytes=0;const chunks:Buffer[]=[];for await(const c of req){bytes+=c.length;if(bytes>100000)throw Error('请求过大');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
function send(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
function transferEndpoint(){
  const host=process.env.PHONEBASE_TRANSFER_HOST?.trim();
  const phoneIp=process.env.PHONEBASE_TRANSFER_PHONE_IP?.trim();
  if(!host||!phoneIp)throw Error('文件传输需要配置本站点的 PHONEBASE_TRANSFER_HOST 和 PHONEBASE_TRANSFER_PHONE_IP');
  return {host,phoneIp};
}

export class PublishingService {
  store:PublishingStore;
  private root:string;
  private locks=new Set<string>();
  private cancelled=new Set<string>();
  private ticking=false;
  private thumbnails=new Map<string,Promise<void>>();
  private timer:ReturnType<typeof setInterval>;
  private runner:PublishingRunner;
  constructor(private base:string,private token='',directory=process.env.PHONEBASE_PUBLISHING_DIR??'.runtime/publishing'){
    this.root=resolve(directory);
    this.store=new PublishingStore(join(this.root,'publishing.sqlite'));
    this.runner=new PublishingRunner(base,join(this.root,'evidence'),token);
    this.store.recover();
    this.timer=setInterval(()=>void this.tick(),1500);this.timer.unref();
  }
  close(){clearInterval(this.timer);this.store.close();}
  stopDevice(deviceId:string){for(const p of this.store.all<PublishPlan>("plans"))if(p.deviceId===deviceId)this.cancelled.add(p.id);}
  busy(deviceId:string){return this.locks.has(deviceId);}
  readiness(p:PublishPlan){
    const issues:string[]=[];const media=this.store.get<PublishMedia>('media',p.mediaId);
    const transfers=p.platforms.every(platform=>this.store.get<PublishWorkflow>('workflows',`${p.deviceId}-${platform}`)?.transfer==='lan');
    if(!transfers&&(!media?.prepared||media.preparedDeviceId!==p.deviceId))issues.push('视频待导入手机并确认相册');
    for(const platform of p.platforms){const w=this.store.get<PublishWorkflow>('workflows',`${p.deviceId}-${platform}`);if(!w?.trained||(w.mediaId!==p.mediaId&&!(p.mode==='once'&&w.transfer==='lan'&&w.acceptedRunId&&platform==='instagram'&&media&&w.version===instagramCandidate(media).version))||(p.mode==='once'&&w.transfer==='lan'&&platform==='instagram'&&(!w.acceptedRunId||!media||w.version!==instagramCandidate(media).version))||workflowIssue(w))issues.push(`${platform==='instagram'?'Instagram':'Facebook'} 首次录制与发布验证待完成`);}
    return issues;
  }
  private async operationalReadiness(p:PublishPlan,trial=false){
    const issues=trial?[]:this.readiness(p);
    try{
      const response=await fetch(`${this.base}/api/v1/devices/${encodeURIComponent(p.deviceId)}`,{headers:this.token?{authorization:`Bearer ${this.token}`}:{},signal:AbortSignal.timeout(5000)});
      const payload=await response.json() as {device?:{connected?:boolean;capabilities?:{observation?:{screenshot?:{available?:boolean;reason?:string}};actions?:Record<string,{available?:boolean;reason?:string}>}};error?:string};
      if(!response.ok||!payload.device)throw Error(payload.error||`HTTP ${response.status}`);
      const device=payload.device;
      if(!device.connected)issues.push('手机当前离线');
      const screenshot=device.capabilities?.observation?.screenshot;
      if(!screenshot?.available)issues.push(screenshot?.reason||'手机画面当前不可用');
      const required=new Set<string>();
      for(const platform of p.platforms){
        const workflow=this.store.get<PublishWorkflow>('workflows',`${p.deviceId}-${platform}`);
        for(const step of workflow?.steps??[]){
          const type=step.caption?'input_text':step.targetText?'tap':step.action?.type;
          if(type)required.add(type);
        }
      }
      for(const type of required){
        const capability=device.capabilities?.actions?.[type];
        if(!capability?.available)issues.push(capability?.reason||`手机暂不能执行 ${type}`);
      }
    }catch(error){issues.push(`无法检查手机状态：${error instanceof Error?error.message:String(error)}`);}
    return [...new Set(issues)];
  }
  private async tick(){
    if(this.ticking)return;this.ticking=true;
    try{
      for(const plan of this.store.all<PublishPlan>('plans').sort((a,b)=>a.nextRun-b.nextRun)){
        if(plan.claimedAt||!plan.enabled||plan.nextRun>Date.now()||this.locks.has(plan.deviceId)||this.readiness(plan).length)continue;
        const due=plan.nextRun;
        let runs:PublishRun[];
        this.store.db.exec('BEGIN IMMEDIATE');
        try {
          runs=plan.platforms.map(platform=>this.store.claim(plan,platform,due,this.store.get<PublishWorkflow>('workflows',`${plan.deviceId}-${platform}`)!.version)).filter((x):x is PublishRun=>Boolean(x));
          if(plan.mode==='once')plan.claimedAt=Date.now();else plan.nextRun=nextDaily(plan.time,plan.timezone,Math.max(Date.now(),due));this.store.put('plans',plan);
          this.store.db.exec('COMMIT');
        }catch(error){this.store.db.exec('ROLLBACK');throw error;}
        if(Date.now()-due>15*60000){for(const r of runs){r.status='skipped';r.error='错过发送时间超过 15 分钟，已跳过，避免补发打扰';r.endedAt=Date.now();this.store.run(r);}continue;}
        this.locks.add(plan.deviceId);void this.executeRuns(plan,runs).finally(()=>this.locks.delete(plan.deviceId));
      }
    }catch(error){console.error('Publishing scheduler:',error instanceof Error?error.message:error);}finally{this.ticking=false;}
  }
  private async executeRuns(plan:PublishPlan,runs:PublishRun[],respectEnabled=true){
    this.cancelled.delete(plan.id);
    for(const r of runs){
      try{
        if(this.cancelled.has(plan.id)||(respectEnabled&&!this.store.get<PublishPlan>('plans',plan.id)?.enabled))throw Error('计划已暂停');
        const media=this.store.get<PublishMedia>('media',plan.mediaId)!;
        const w=this.store.get<PublishWorkflow>('workflows',`${plan.deviceId}-${r.platform}`)!;
        r.status='running';this.store.run(r);
        if(w.transfer==='lan'){const bound=plan.mode==='once'&&w.platform==='instagram'?{...instagramCandidate(media),account:w.account,trained:w.trained,transfer:w.transfer}:w;await this.executeTrial(r,media,bound,false);continue;}
        await this.runner.execute(r,media,w,x=>this.store.run(x),()=>this.cancelled.has(plan.id));
        r.status='succeeded';r.step='发布后已验证';
      }catch(error){r.status=r.submitted?'needs_review':'failed';r.error=error instanceof Error?error.message:String(error);}
      r.endedAt=Date.now();this.store.run(r);
    }
  }
  private async executeTrial(run:PublishRun,media:PublishMedia,w:PublishWorkflow,promote=true){
    let transfer:Awaited<ReturnType<typeof openPublishingTransfer>>|undefined;
    try{
      run.status='running';run.step='启动视频传输与自动发布';this.store.run(run);
      const endpoint=transferEndpoint();
      transfer=await openPublishingTransfer(media,run.snapshot.caption,endpoint.host,endpoint.phoneIp);
      const dir=join(this.root,'evidence',run.id);await mkdir(dir,{recursive:true});
      await writeFile(join(dir,'workflow.json'),JSON.stringify(w,null,2));
      await this.runner.trial(run,media,w,r=>this.store.run(r),()=>this.cancelled.has(run.planId),()=>{
        const status=transfer!.status();if(!status.downloaded||!status.copied)throw Error('未确认完整下载与文案复制，停止提交');
      });
      run.status='succeeded';run.step='整轮无人值守发布与验证通过';
      if(promote)this.store.put('workflows',{...w,id:run.deviceId+'-instagram',mediaId:media.id,transfer:'lan',acceptedRunId:run.id,trained:true,name:'Instagram：整轮无人值守验收通过',updatedAt:Date.now()} as PublishWorkflow);
      media.prepared=true;media.preparedDeviceId=run.deviceId;media.album='Recents';this.store.put('media',media);
      await writeFile(join(dir,'acceptance.json'),JSON.stringify({runId:run.id,mediaId:media.id,sha256:media.sha256,uninterrupted:true,submitted:run.submitted,workflowVersion:w.version,elapsedMs:Date.now()-run.startedAt},null,2));
    }catch(error){run.status=run.submitted?'needs_review':'failed';run.error=error instanceof Error?error.message:String(error);}
    finally{transfer?.close();run.endedAt=Date.now();this.store.run(run);}
  }
  async handle(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
    if(!url.pathname.startsWith('/api/v1/publishing'))return false;
    const address=req.socket.remoteAddress??'';
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)){send(res,403,{ok:false,error:'发布工作区仅在本机开放'});return true;}
    const origin=req.headers.origin;
    if(origin){try{const o=new URL(origin);if(!['127.0.0.1','localhost','[::1]'].includes(o.hostname))throw Error();}catch{send(res,403,{ok:false,error:'来源不允许'});return true;}}
    const route=url.pathname.slice('/api/v1/publishing'.length)||'/';
    try{
      if(req.method==='GET'&&route==='/'){
        const media=this.store.all<PublishMedia>('media').map(m=>{const value={...m} as Partial<PublishMedia>;delete value.path;return value;});
        const workflows=this.store.all<PublishWorkflow>('workflows').map(w=>({id:w.id,platform:w.platform,deviceId:w.deviceId,trained:w.trained,version:w.version,account:w.account,name:w.name,issue:workflowIssue(w)}));
        send(res,200,{ok:true,media,workflows,plans:this.store.all<PublishPlan>('plans').map(p=>({...p,readiness:this.readiness(p)})),runs:this.store.all<PublishRun>('runs').slice(0,100),busyDevices:[...this.locks]});return true;
      }
      if(req.method==='POST'&&route==='/media'){
        const id=randomUUID();const name=basename(url.searchParams.get('name')??'video.mp4').slice(0,180);
        if(!/\.(mp4|mov|m4v)$/i.test(name))throw Error('请选择 MP4、MOV 或 M4V 视频');
        if(Number(req.headers['content-length']??0)>MAX_VIDEO)throw Error('视频不能超过 500 MB');
        const dir=join(this.root,'media',id);await mkdir(dir,{recursive:true});const temp=join(dir,'upload.tmp');const path=join(dir,'video.mp4');let bytes=0;const hash=createHash('sha256');
        try{
          await pipeline(req,new Transform({transform(c,_,cb){bytes+=c.length;if(bytes>MAX_VIDEO){cb(Error('视频不能超过 500 MB'));return;}hash.update(c);cb(null,c);}}),createWriteStream(temp,{flags:'wx'}));
          if(bytes<100)throw Error('视频文件为空或不完整');
          const {stdout}=await exec(process.env.PHONEBASE_FFPROBE??'/opt/homebrew/bin/ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',temp],{timeout:30000,maxBuffer:100000});
          const probe=JSON.parse(stdout);const stream=probe.streams?.find((s:{codec_type:string})=>s.codec_type==='video');const duration=Number(probe.format?.duration);
          if(!stream||!Number.isFinite(duration)||duration<=0)throw Error('无法识别视频内容');
          await rename(temp,path);
          const m:PublishMedia={id,name,bytes,sha256:hash.digest('hex'),duration,width:stream.width,height:stream.height,path,album:`PB-${id.slice(0,8)}`,prepared:false,createdAt:Date.now()};this.store.put('media',m);
          const publicMedia={...m} as Partial<PublishMedia>;delete publicMedia.path;send(res,201,{ok:true,media:publicMedia});
        }catch(error){await rm(dir,{recursive:true,force:true});throw error;}return true;
      }
      const thumbnail=route.match(/^\/media\/([\w-]+)\/thumbnail$/);
      if(req.method==='GET'&&thumbnail){
        const m=this.store.get<PublishMedia>('media',thumbnail[1]);if(!m){send(res,404,{ok:false,error:'视频不存在'});return true;}
        const path=join(this.root,'media',m.id,'thumbnail.jpg');
        try{await stat(path);}catch{
          let pending=this.thumbnails.get(m.id);
          if(!pending){pending=(async()=>{
            const temp=path+'.tmp.jpg';
            await exec(process.env.PHONEBASE_FFMPEG??'/opt/homebrew/bin/ffmpeg',['-y','-v','error','-threads','1','-ss',String(Math.min(.5,m.duration/2)),'-i',m.path,'-frames:v','1','-vf','scale=320:320:force_original_aspect_ratio=decrease','-q:v','4',temp],{timeout:30000,maxBuffer:100000});
            await rename(temp,path);
          })().finally(()=>this.thumbnails.delete(m.id));this.thumbnails.set(m.id,pending);}
          await pending;
        }
        await this.file(req,res,path,'image/jpeg');return true;
      }
      const mediaMatch=route.match(/^\/media\/([\w-]+)(\/prepared)?$/);
      if(mediaMatch){
        const m=this.store.get<PublishMedia>('media',mediaMatch[1]);if(!m){send(res,404,{ok:false,error:'视频不存在'});return true;}
        if(req.method==='POST'&&mediaMatch[2]){const p=await body(req);if(p.sha256!==m.sha256||!['USB_ALBUM_VISUALLY_VERIFIED','PHONE_ALBUM_VISUALLY_VERIFIED'].includes(p.confirmation)||typeof p.album!=='string'||!p.album.trim()||p.album.length>120)throw Error('需要完成实际手机相册校验');if(typeof p.deviceId!=="string"||!/^[-\w]{1,120}$/.test(p.deviceId))throw Error("需要确认导入的手机");m.prepared=true;m.preparedDeviceId=p.deviceId;m.album=p.album;this.store.put('media',m);send(res,200,{ok:true});return true;}
        if(req.method==='GET'&&!mediaMatch[2]){await this.file(req,res,m.path,'video/mp4');return true;}
      }
      if(req.method==='POST'&&(route==='/queue'||route==='/queue/preview')){
        const input=await body(req);
        if(!Array.isArray(input.mediaIds)||!input.mediaIds.length||input.mediaIds.length>200||new Set(input.mediaIds).size!==input.mediaIds.length)throw Error('请选择 1–200 个不同的视频');
        const clean=validatePlan({...input,mediaId:input.mediaIds[0],time:input.times?.[0],enabled:true});
        const allPlans=this.store.all<PublishPlan>('plans');
        const selected=input.mediaIds.map((id:string)=>{const m=this.store.get<PublishMedia>('media',id);if(!m)throw Error('视频不存在');return m;});
        if(new Set(selected.map((m:PublishMedia)=>m.sha256)).size!==selected.length)throw Error('选中视频含有相同内容，请移除重复视频');
        const reserved=allPlans.filter(p=>p.mode==='once'&&!p.claimedAt&&p.deviceId===clean.deviceId).map(p=>p.nextRun);
        const dates=allocateSlots(selected.length,input.times,clean.timezone,Date.now(),reserved);
        const batchId=randomUUID();
        const plans:PublishPlan[]=selected.map((m:PublishMedia,i:number)=>({...clean,id:randomUUID(),mode:'once',batchId,mediaId:m.id,nextRun:dates[i],createdAt:Date.now()}));
        if(route==='/queue'){
          for(const m of selected){
            const duplicate=allPlans.some(p=>p.mode==='once'&&p.deviceId===clean.deviceId&&p.platforms.some(x=>clean.platforms.includes(x))&&this.store.get<PublishMedia>('media',p.mediaId)?.sha256===m.sha256);
            const submitted=this.store.all<PublishRun>('runs').some(r=>r.submitted&&r.deviceId===clean.deviceId&&clean.platforms.includes(r.platform)&&this.store.get<PublishMedia>('media',r.snapshot.mediaId)?.sha256===m.sha256);
            if(duplicate||submitted)throw Error(`${m.name} 已在队列或已有发布提交记录，请选择新视频`);
          }
          this.store.db.exec('BEGIN IMMEDIATE');
          try{for(const p of plans)this.store.put('plans',p);this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
        }
        send(res,route==='/queue'?201:200,{ok:true,plans:plans.map(p=>({...p,readiness:this.readiness(p)}))});return true;
      }
      const planMatch=route.match(/^\/plans(?:\/([\w-]+))?$/);
      if(planMatch&&['POST','PATCH'].includes(req.method??'')){
        const data=await body(req);const old=planMatch[1]?this.store.get<PublishPlan>('plans',planMatch[1]):undefined;
        if(planMatch[1]&&!old){send(res,404,{ok:false,error:'计划不存在'});return true;}
        if(old&&data.enabled===false)this.cancelled.add(old.id);
        if(old&&this.locks.has(old.deviceId)&&data.enabled!==false)throw Error('手机正在执行，请先暂停并等待当前动作结束');
        if(old?.mode==='once'&&(Object.keys(data).some(k=>k!=='enabled')||old.claimedAt))throw Error('已分配任务仅可暂停或恢复；执行过的任务不会重复发送');
        const clean=validatePlan({...old,...data});if(!this.store.get('media',clean.mediaId))throw Error('视频不存在');
        const changed=!old||old.time!==clean.time||old.timezone!==clean.timezone||(!old.enabled&&clean.enabled);
        const p:PublishPlan={...old,...clean,id:old?.id??randomUUID(),createdAt:old?.createdAt??Date.now(),nextRun:old?.mode==='once'?old.nextRun:changed?nextDaily(clean.time,clean.timezone,Date.now()):old!.nextRun};
        this.store.put('plans',p);send(res,old?200:201,{ok:true,plan:{...p,readiness:this.readiness(p)}});return true;
      }
      const trialMatch=route.match(/^\/plans\/([\w-]+)\/trial$/);
      if(req.method==='POST'&&trialMatch){
        const p=this.store.get<PublishPlan>('plans',trialMatch[1]);
        if(!p)throw Error('计划不存在');
        if(p.mode==='once')throw Error('请使用未加入队列的新视频进行验收');
        if(p.deviceId!=='black-arm-01'||p.platforms.length!==1||p.platforms[0]!=='instagram')throw Error('本次验收仅支持 Phonebase 1 的 Instagram');
        if(p.enabled)throw Error('测试计划必须暂停每日发送');
        const media=this.store.get<PublishMedia>('media',p.mediaId)!;
        if(this.store.all<PublishRun>('runs').some(r=>r.deviceId===p.deviceId&&r.platform==='instagram'&&r.submitted&&this.store.get<PublishMedia>('media',r.snapshot.mediaId)?.sha256===media.sha256))throw Error('此视频已有提交记录，请选择未发送过的视频，避免重复发布');
        if(this.locks.has(p.deviceId)||this.locks.size)throw Error('手机正在执行其他任务，请等待完成');
        this.locks.add(p.deviceId);
        try{
          const issues=await this.operationalReadiness(p,true);if(issues.length)throw Error(issues.join('；'));
          const w=instagramCandidate(media);const issue=workflowIssue(w);if(issue)throw Error(issue);
          const run=this.store.claimManual(p,'instagram',w.version);
          this.cancelled.delete(p.id);
          void this.executeTrial(run,media,w).finally(()=>this.locks.delete(p.deviceId));
          send(res,202,{ok:true,runs:[run]});return true;
        }catch(error){this.locks.delete(p.deviceId);throw error;}
      }
      const runMatch=route.match(/^\/plans\/([\w-]+)\/run$/);
      if(req.method==='POST'&&runMatch){
        const p=this.store.get<PublishPlan>('plans',runMatch[1]);if(!p){send(res,404,{ok:false,error:'计划不存在'});return true;}
        if(p.mode==='once')throw Error('队列视频按已分配时间执行，不能另外重复发送');
        if(this.locks.has(p.deviceId))throw Error('手机正在执行其他任务，请等待完成');
        const issues=await this.operationalReadiness(p);if(issues.length)throw Error(issues.join('；'));
        const runs=p.platforms.map(platform=>this.store.claimManual(p,platform,this.store.get<PublishWorkflow>('workflows',`${p.deviceId}-${platform}`)!.version));
        this.cancelled.delete(p.id);this.locks.add(p.deviceId);
        void this.executeRuns(p,runs,false).finally(()=>this.locks.delete(p.deviceId));
        send(res,202,{ok:true,runs});return true;
      }
      const preflightMatch=route.match(/^\/plans\/([\w-]+)\/preflight$/);
      if(req.method==='GET'&&preflightMatch){
        const p=this.store.get<PublishPlan>('plans',preflightMatch[1]);if(!p){send(res,404,{ok:false,error:'计划不存在'});return true;}
        const issues=await this.operationalReadiness(p);send(res,200,{ok:true,ready:issues.length===0,issues});return true;
      }
      if(req.method==='POST'&&route==='/workflows'){
        const p=await body(req) as PublishWorkflow&{confirmation?:string};if(!PLATFORMS.includes(p.platform)||!/^[-\w]{1,120}$/.test(p.deviceId)||p.confirmation!=='RECORDED_ON_REAL_DEVICE')throw Error('工作流需要真机录制确认');
        const w:PublishWorkflow={mediaId:p.mediaId,id:`${p.deviceId}-${p.platform}`,platform:p.platform,deviceId:p.deviceId,account:p.account,name:p.name,version:(this.store.get<PublishWorkflow>('workflows',`${p.deviceId}-${p.platform}`)?.version??0)+1,steps:p.steps,trained:p.trained===true,updatedAt:Date.now()};
        if(w.trained&&!this.store.get<PublishMedia>("media",w.mediaId??""))throw Error("请绑定已实操验证的视频");const issue=workflowIssue(w);if(w.trained&&issue)throw Error(issue);if(this.locks.has(w.deviceId))throw Error('手机执行中，不能替换流程');this.store.put('workflows',w);send(res,200,{ok:true,workflow:w});return true;
      }
      const evidence=route.match(/^\/evidence\/([\w-]+)\/([\w.-]+\.jpg)$/);
      if(req.method==='GET'&&evidence){const run=this.store.get<PublishRun>('runs',evidence[1]);const relative=`${evidence[1]}/${evidence[2]}`;if(!run?.evidence.includes(relative))throw Error('证据不存在');await this.file(req,res,join(this.root,'evidence',relative),'image/jpeg');return true;}
      send(res,404,{ok:false,error:'接口不存在'});
    }catch(error){if(!res.headersSent&&!res.destroyed)send(res,400,{ok:false,error:error instanceof Error?error.message:String(error)});}
    return true;
  }
  private async file(req:IncomingMessage,res:ServerResponse,path:string,type:string){
    const size=(await stat(path)).size;const range=req.headers.range;
    if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match){res.writeHead(416,{'content-range':`bytes */${size}`});res.end();return;}const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),size-1):size-1;if(start>=size||end<start){res.writeHead(416,{'content-range':`bytes */${size}`});res.end();return;}res.writeHead(206,{'content-type':type,'content-range':`bytes ${start}-${end}/${size}`,'content-length':end-start+1,'accept-ranges':'bytes'});createReadStream(path,{start,end}).pipe(res);}
    else{res.writeHead(200,{'content-type':type,'content-length':size,'accept-ranges':'bytes'});createReadStream(path).pipe(res);}
  }
}
