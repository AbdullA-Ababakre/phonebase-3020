import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublishingStore,allocateSlots,nextDaily,validatePlan,type PublishPlan,type PublishWorkflow,type PublishRun} from './publishing-store';
import {workflowIssue} from './publishing-runner';

const plan:PublishPlan={id:'plan-1',mediaId:'video-1',deviceId:'black-arm-01',caption:'Hello',time:'09:00',timezone:'Asia/Shanghai',platforms:['instagram','facebook'],enabled:true,nextRun:0,createdAt:0};
test('daily scheduling respects timezone, exact time and DST gaps',()=>{
  assert.equal(new Date(nextDaily('09:00','Asia/Shanghai',Date.parse('2026-09-15T00:59:00Z'))).toISOString(),'2026-09-15T01:00:00.000Z');
  assert.equal(new Date(nextDaily('09:00','Asia/Shanghai',Date.parse('2026-09-15T01:00:00Z'))).toISOString(),'2026-09-16T01:00:00.000Z');
  assert.equal(new Date(nextDaily('02:30','America/New_York',Date.parse('2026-03-08T05:00:00Z'))).toISOString(),'2026-03-09T06:30:00.000Z');
});
test('reject invalid schedules and preserve Unicode captions',()=>{
  assert.throws(()=>validatePlan({...plan,time:'24:00'}));
  assert.throws(()=>validatePlan({...plan,timezone:'not/a/timezone'}));
  assert.throws(()=>validatePlan({...plan,platforms:['tiktok']}));
  assert.equal(validatePlan({...plan,caption:'你好 🌍\n#video'}).caption,'你好 🌍\n#video');
});
test('independent platform claims cannot publish twice in one local day, even after restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'publishing-test-'));const file=join(root,'store.sqlite');let store=new PublishingStore(file);
  try{
    const at=Date.parse('2026-09-15T01:00:00Z');const ig=store.claim(plan,'instagram',at,1)!;const fb=store.claim(plan,'facebook',at,1)!;
    assert.ok(ig&&fb);assert.equal(store.claim(plan,'instagram',at+60000,1),null);
    ig.submitted=true;ig.status='running';store.run(ig);store.close();store=new PublishingStore(file);store.recover();
    assert.equal(store.get<PublishRun>('runs',ig.id)?.status,'needs_review');assert.equal(store.get<PublishRun>('runs',fb.id)?.status,'interrupted');
    assert.equal(store.claim(plan,'instagram',at,2),null);assert.ok(store.claim(plan,'instagram',at+86400000,2));
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('manual runs are independent from the daily scheduled claim',async()=>{
  const root=await mkdtemp(join(tmpdir(),'publishing-manual-test-'));const store=new PublishingStore(join(root,'store.sqlite'));
  try{
    const at=Date.parse('2026-09-15T01:00:00Z');
    const scheduled=store.claim(plan,'instagram',at,1)!;
    const first=store.claimManual(plan,'instagram',1);
    const second=store.claimManual(plan,'instagram',1);
    assert.equal(scheduled.trigger,'scheduled');assert.equal(first.trigger,'manual');assert.notEqual(first.id,second.id);
    assert.equal(store.all<PublishRun>('runs').length,3);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
const workflow:PublishWorkflow={id:'w',platform:'instagram',deviceId:'black-arm-01',name:'test',account:'account',trained:true,updatedAt:0,version:1,steps:[{id:'account',label:'账号',expect:['{{account}}']},{id:'caption',label:'文案',expect:['{{caption}}']},{id:'share',label:'发布',expect:['Share'],targetText:'Share',submit:true},{id:'result',label:'验证',expect:['Your reel has been shared'],verify:true}]};
test('workflow requires account/caption before Share and evidence after Share',()=>{
  assert.equal(workflowIssue(workflow),null);
  assert.ok(workflowIssue({...workflow,steps:workflow.steps.slice(0,-1)}));
  assert.ok(workflowIssue({...workflow,steps:[...workflow.steps.slice(1),workflow.steps[0]]}));
  assert.ok(workflowIssue({...workflow,steps:workflow.steps.map(s=>s.submit?{...s,optional:true}:s)}));
  assert.ok(workflowIssue({...workflow,steps:[...workflow.steps,workflow.steps[0]]}));
  assert.ok(workflowIssue({...workflow,steps:workflow.steps.map(s=>s.submit?{...s,targetMatch:'leftmost'}:s)}));
  assert.ok(workflowIssue({...workflow,steps:workflow.steps.map(s=>s.submit?{...s,targetOffset:{x:0,y:.1}}:s)}));
});

test('HTTP plans persist, invalid uploads are rejected, and learning gates sending',async()=>{
  const {createServer}=await import('node:http');const {PublishingService}=await import('./publishing');
  const root=await mkdtemp(join(tmpdir(),'publishing-api-'));const service=new PublishingService('http://127.0.0.1:1','',root);
  const server=createServer((req,res)=>void service.handle(req,res,new URL(req.url!,'http://localhost')));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1/publishing`;
  try{
    service.store.put('media',{id:plan.mediaId,prepared:true,preparedDeviceId:plan.deviceId} as {id:string});
    const result=await fetch(base+'/plans',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(plan)});assert.equal(result.status,201);
    const p=(await result.json()).plan;assert.equal(p.readiness.length,2);assert.ok(p.readiness.every((x:string)=>x.includes('首次录制')));
    const wrongDevice={...p,deviceId:'black-arm-02'};assert.ok(service.readiness(wrongDevice).some(x=>x.includes('导入手机')));
    const preflight=await fetch(base+'/plans/'+p.id+'/preflight');assert.equal(preflight.status,200);const checked=await preflight.json();assert.equal(checked.ready,false);assert.ok(checked.issues.length>=2);
    const blockedRun=await fetch(base+'/plans/'+p.id+'/run',{method:'POST'});assert.equal(blockedRun.status,400);assert.match((await blockedRun.json()).error,/首次录制/);
    const paused=await fetch(base+'/plans/'+p.id,{method:'PATCH',headers:{'content-type':'application/json'},body:'{"enabled":false}'});assert.equal(paused.status,200);assert.equal((await paused.json()).plan.enabled,false);
    const bad=await fetch(base+'/media?name=bad.txt',{method:'POST',body:'bad'});assert.equal(bad.status,400);
    const source=await fetch(base,{headers:{origin:'https://example.com'}});assert.equal(source.status,403);
    const state=await(await fetch(base)).json();assert.equal(state.plans.length,1);assert.equal(state.runs.length,0);
  }finally{await new Promise<void>(r=>server.close(()=>r()));service.close();await rm(root,{recursive:true,force:true});}
});

test('OCR target uses camera perspective even when raw and screen dimensions are equal',async()=>{
  const {publishingTargetPoint}=await import('./publishing-runner');
  const screen={width:720,height:1280,rawWidth:720,rawHeight:1280,rectified:true,imagePoints:[{x:100,y:100},{x:600,y:100},{x:600,y:1100},{x:100,y:1100}] as [{x:number;y:number},{x:number;y:number},{x:number;y:number},{x:number;y:number}]};
  const p=publishingTargetPoint({x:175,y:425},{width:360,height:640},screen);
  assert.ok(Math.abs(p.x-.5)<1e-8);assert.ok(Math.abs(p.y-.75)<1e-8);
  const hd=publishingTargetPoint({x:180,y:480},{width:360,height:640},{...screen,rectified:false});assert.deepEqual(hd,{x:.5,y:.75});
});

import {publishingPageReady} from './publishing-runner';
test('background filename cannot satisfy a video-preview guard while Downloads is still open',()=>{
  assert.equal(publishingPageReady('Downloads PB-4a239fb7.mp4',['PB-4a239fb7'],['Downloads']),false);
  assert.equal(publishingPageReady('Downloads',[],['Downloads']),false);
  assert.equal(publishingPageReady('PB-4a239fb7.mp4 Shadowrocket',['PB-4a239fb7'],['Downloads']),true);
});

test('account anchor permits only a trailing dropdown marker, not another account',async()=>{
  const {publishingTextMatches}=await import('./publishing-runner');
  assert.equal(publishingTextMatches('florence_nanny ~','florence_nanny','label'),true);
  assert.equal(publishingTextMatches('florence_nanny~','florence_nanny','label'),true);
  assert.equal(publishingTextMatches('florence_nanny-','florence_nanny','label'),true);
  assert.equal(publishingTextMatches('florence_nanny -','florence_nanny','label'),true);
  assert.equal(publishingTextMatches('florence_nanny_other','florence_nanny','label'),false);
  assert.equal(publishingTextMatches('florence_nanny official','florence_nanny','label'),false);
  assert.equal(publishingTextMatches('Share ~','Share'),false);
});

test('post count ignores followers, refuses ambiguous and abbreviated counts',async()=>{
  const {instagramPostCount}=await import('./publishing-runner');
  const item=(text:string,x:number,y:number)=>({text,centerX:x,centerY:y,left:x-20,top:y-7,width:40,height:14,confidence:1});
  const items=[item('posts',326,395),item('30',315,371),item('39',398,371),item('followers',420,395)];
  assert.equal(instagramPostCount(items),30);
  assert.equal(instagramPostCount([...items,item('31',325,374)]),undefined);
  assert.equal(instagramPostCount(items.map(x=>x.text==='30'?{...x,text:'1.2K'}:x)),undefined);
});

test('candidate binds the new media and uses a fresh count with one guarded submission',async()=>{
  const {instagramCandidate}=await import('./publishing-instagram');
  const w=instagramCandidate({id:'abcdefgh-1234',duration:21.54} as import('./publishing-store').PublishMedia);
  assert.equal(workflowIssue(w),null);
  assert.ok(w.steps.some(s=>s.expect.includes('PB-abcdefgh.mp4')));
  assert.ok(w.steps.some(s=>s.expect.includes('0:22')));
  assert.equal(w.steps.filter(s=>s.postCount==='capture').length,1);
  assert.equal(w.steps.filter(s=>s.postCount==='increment').length,1);
  assert.equal(w.trained,false);
});

test('verification rejects old posts even when account and caption match',async()=>{
  const {hasFreshInstagramTimestamp}=await import('./publishing-runner');
  const check=(text:string)=>hasFreshInstagramTimestamp([{text} as import('./vision-ocr').VisionTextItem]);
  assert.equal(check('2 minutes ago'),true);assert.equal(check('1 minute ago'),true);assert.equal(check('30 seconds ago'),true);
  assert.equal(check('4 hours ago'),false);assert.equal(check('2 days ago'),false);assert.equal(check('12 minutes ago'),false);
});


test('queue assigns each video once across daily slots, respecting reservations and DST',()=>{
  const now=Date.parse('2026-09-18T00:00:00Z');
  assert.deepEqual(allocateSlots(4,['18:00','09:00','09:00'],'Asia/Shanghai',now,[Date.parse('2026-09-18T01:00:00Z')]).map(t=>new Date(t).toISOString()),[
    '2026-09-18T10:00:00.000Z','2026-09-19T01:00:00.000Z','2026-09-19T10:00:00.000Z','2026-09-20T01:00:00.000Z']);
  assert.equal(new Date(allocateSlots(1,['02:30'],'America/New_York',Date.parse('2026-03-08T05:00:00Z'))[0]).toISOString(),'2026-03-09T06:30:00.000Z');
  assert.throws(()=>allocateSlots(0,['09:00'],'UTC',now));
  assert.throws(()=>allocateSlots(1,['25:00'],'UTC',now));
  assert.throws(()=>allocateSlots(1,[],'UTC',now));
});

test('bulk queue is atomic, appends slots, survives restart and prevents duplicates',async()=>{
  const {createServer}=await import('node:http');const {PublishingService}=await import('./publishing');
  const root=await mkdtemp(join(tmpdir(),'publishing-queue-'));const service=new PublishingService('http://127.0.0.1:1','',root);
  const server=createServer((req,res)=>void service.handle(req,res,new URL(req.url!,'http://localhost')));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1/publishing`;
  const post=(path:string,input:unknown,method='POST')=>fetch(base+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  const input={mediaIds:['a','b'],deviceId:plan.deviceId,caption:'批量文案',times:['09:00','18:00'],timezone:'Asia/Shanghai',platforms:['instagram']};
  try{
    for(const id of ['a','b','c'])service.store.put('media',{id,name:id,sha256:id} as {id:string});
    const preview=await post('/queue/preview',input);assert.equal(preview.status,200);assert.equal(service.store.all('plans').length,0);
    const created=await post('/queue',input);assert.equal(created.status,201);const first=(await created.json()).plans as PublishPlan[];
    assert.equal(first.length,2);assert.ok(first.every(p=>p.mode==='once'&&p.enabled));assert.ok(first[0].nextRun<first[1].nextRun);
    const duplicate=await post('/queue',input);assert.equal(duplicate.status,400);assert.equal(service.store.all('plans').length,2);
    const missing=await post('/queue',{...input,mediaIds:['c','missing']});assert.equal(missing.status,400);assert.equal(service.store.all('plans').length,2);
    const appended=await post('/queue',{...input,mediaIds:['c']});const last=(await appended.json()).plans[0];assert.ok(last.nextRun>first[1].nextRun);
    const paused=await post('/plans/'+first[0].id,{enabled:false},'PATCH');assert.equal(paused.status,200);assert.equal((await paused.json()).plan.nextRun,first[0].nextRun);
    const resumed=await post('/plans/'+first[0].id,{enabled:true},'PATCH');assert.equal((await resumed.json()).plan.mode,'once');
    assert.equal((await post('/plans/'+first[0].id+'/run',{})).status,400);
    const w={...workflow,id:plan.deviceId+'-instagram',deviceId:plan.deviceId,mediaId:'a'};
    service.store.put('workflows',w);service.store.put('media',{id:'a',prepared:true,preparedDeviceId:plan.deviceId} as {id:string});
    // Execute an overdue single occurrence without contacting a phone: it must skip once, never recur.
    service.store.put('plans',{...first[0],nextRun:Date.now()-3600000} as PublishPlan);
    await (service as unknown as {tick:()=>Promise<void>}).tick();
    const consumed=service.store.get<PublishPlan>('plans',first[0].id)!;assert.ok(consumed.claimedAt);
    assert.equal(service.store.all<PublishRun>('runs').filter(r=>r.planId===first[0].id).length,1);
    await (service as unknown as {tick:()=>Promise<void>}).tick();assert.equal(service.store.all('runs').length,1);
    assert.equal((await post('/plans/'+first[0].id,{enabled:true},'PATCH')).status,400);
    const reopened=new PublishingStore(join(root,'publishing.sqlite'));assert.ok(reopened.get<PublishPlan>('plans',first[0].id)?.claimedAt);reopened.close();
  }finally{await new Promise<void>(r=>server.close(()=>r()));service.close();await rm(root,{recursive:true,force:true});}
});
