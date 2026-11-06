import {PublishingStore,type PublishMedia,type PublishRun,type PublishWorkflow,type PublishStep} from '../../agent/publishing-store';
import {PublishingRunner} from '../../agent/publishing-runner';
import {instagramPublishSteps} from './instagram-publish-steps';
import {writeFile} from 'node:fs/promises';
const store=new PublishingStore('.runtime/publishing/publishing.sqlite');
const run=store.get<PublishRun>('runs',process.env.PHONEBASE_VERIFY_RUN_ID??'efdc3dee-e6a0-4696-972a-5a8b98949007')!;
const media=store.get<PublishMedia>('media',run.snapshot.mediaId)!;
const steps:PublishStep[]=[
{id:'back-from-post',label:'返回已发布作品所在账号',expect:['Posts','View insights','{{account}}'],optional:true,timeoutMs:700,action:{type:'tap',point:{x:65/720,y:80/1280},touchZ:9.5,durationMs:40}},
{id:'profile-tab',label:'回到账号顶部',expect:[],absent:['View insights','New reel','Reels drafts'],action:{type:'tap',point:{x:645/720,y:1210/1280},touchZ:9.8,durationMs:80}},
{id:'top-profile',label:'刷新回到主页顶部',expect:['{{account}}'],action:{type:'swipe',start:{x:.5,y:480/1280},end:{x:.5,y:1050/1280},durationMs:500,touchZ:9.5}},
...instagramPublishSteps.slice(instagramPublishSteps.findIndex(s=>s.id==='verify-count')).map(s=>({...s,action:s.action?{...s.action,touchZ:9.5}:s.targetText?{type:'tap',point:{x:.5,y:.5},touchZ:9.5}:undefined}))];
const verifyCount=process.env.PHONEBASE_VERIFY_COUNT;if(verifyCount){const step=steps.find(s=>s.id==='verify-count')!;step.expect=['{{account}}',verifyCount,'posts'];step.label='核对已发布后的 '+verifyCount+' 条作品';}
const attempt=Date.now();for(const step of steps)step.id='verify-v4-'+attempt+'-'+step.id;
const workflow:PublishWorkflow={id:'instagram-verification-repair',deviceId:run.deviceId,platform:'instagram',account:'florence_nanny',name:'已发布作品验证路径修复',trained:false,version:3,updatedAt:Date.now(),steps};
const runner=new PublishingRunner('http://127.0.0.1:3013','.runtime/publishing/evidence');
const started=Date.now();try{await runner.rehearse(run,media,workflow,r=>{store.run(r);console.log(r.step)},()=>false);run.status='succeeded';run.error='';run.step='已发布；修复验证路径后单独回放验证通过（非整轮无干预通过）';}catch(e){run.status='needs_review';run.error=String(e);}finally{run.endedAt=Date.now();store.run(run);store.close();await writeFile('.runtime/instagram-verification-repair.json',JSON.stringify({runId:run.id,workflow,status:run.status,error:run.error,elapsedMs:Date.now()-started,evidence:run.evidence},null,2));console.log(JSON.stringify({status:run.status,error:run.error,elapsedMs:Date.now()-started}));}
