import {instagramPublishSteps} from './instagram-publish-steps';
import {PublishingStore,type PublishPlan,type PublishMedia,type PublishWorkflow,type PublishStep} from '../../agent/publishing-store';
import {PublishingRunner} from '../../agent/publishing-runner';
import {openPublishingTransfer} from '../../agent/publishing-transfer';
import {writeFile} from 'node:fs/promises';
const store=new PublishingStore('.runtime/publishing/publishing.sqlite');
const planId=process.env.PHONEBASE_TRIAL_PLAN_ID??'6cbcaf8e-2fea-4f48-8f9c-ed07efabad9f';
const template=store.get<PublishPlan>('plans',planId);
if(!template)throw Error('发送计划不存在');
const media=store.get<PublishMedia>('media',process.env.PHONEBASE_TRIAL_PLAN_ID?template.mediaId:'4a239fb7-957b-44d9-9aa6-39cdab33c9c7')!;
if(!media)throw Error('视频不存在');
const baseline=Number(process.env.PHONEBASE_TRIAL_BASELINE??28);
if(!Number.isSafeInteger(baseline)||baseline<0)throw Error('作品数基线无效');
const plan={...template,mediaId:media.id,enabled:false};
const run=store.claimManual(plan,'instagram',2);run.status='running';run.step='新视频全自动导入测试';store.run(run);
const runner=new PublishingRunner('http://127.0.0.1:3013','.runtime/publishing/evidence');
const tap=(id:string,label:string,expect:string[],x:number,y:number,optional=false):PublishStep=>({id,label,expect,action:{type:'tap',point:{x:x/720,y:y/1280},durationMs:40},...(optional?{optional:true,timeoutMs:700}:{})});
const text=(id:string,label:string,expect:string[],targetText:string):PublishStep=>({id,label,expect,targetText});
const steps:PublishStep[]=[
{id:'home',label:'返回手机桌面',expect:[],action:{type:'phone_key',key:'home'}},
{id:'retry-start-home',label:'若尚未回到桌面则重试 Home',expect:[],absent:['Files','FaceTime','Weather','Calendar'],optional:true,timeoutMs:700,action:{type:'phone_key',key:'home'}},
{...tap('safari','打开 Safari',[],276,1190),absent:['Posts','View insights','New reel']},
tap('close-old-download-prompt','关闭前次未完成的下载询问',['Do you want to download'],625,481,true),
{...tap('close-preview','关闭上次的视频预览',['PB-'],645,83,true),absent:['Downloads','Phonebase Transfer']},
tap('close-downloads','关闭下载列表',['Downloads','Clear'],80,680,true),
tap('dismiss-address-menu','关闭 Safari 地址菜单',['Switch Tab Groups'],660,280,true),
tap('close-touch-test','从触摸诊断页恢复传输',['Touch duration test'],505,1167,true),
tap('reload','刷新传输页面',['Phonebase Transfer'],505,1167),
tap('retry-reload','若仍是旧会话则再刷新一次',['Phonebase Transfer','Caption copied'],505,1167,true),
text('copy-caption','复制本次计划文案',['Phonebase Transfer','PB-4a239fb7.mp4'],'Copy caption'),
text('download','下载本次新视频',['Caption copied'],'Download video'),
tap('confirm-download','确认下载本次视频',['Do you want to download','PB-4a239fb7.mp4','View Download'],567,649),
{id:'home-for-files',label:'返回桌面打开本地文件',expect:['Phonebase Transfer'],action:{type:'phone_key',key:'home'}},
{id:'retry-home-for-files',label:'若仍在传输页则重试 Home',expect:['Phonebase Transfer'],optional:true,timeoutMs:700,action:{type:'phone_key',key:'home'}},
{id:'files-home-page',label:'切换到 Files 所在桌面',expect:['FaceTime','Calendar'],optional:true,timeoutMs:700,action:{type:'swipe',start:{x:600/720,y:700/1280},end:{x:160/720,y:700/1280},durationMs:400}},
tap('files','打开 Files',['Files'],276,441),
{...tap('close-files-preview','关闭 Files 上次预览',['PB-'],645,80,true),absent:['Recents','Search']},
tap('files-recents','选择 Files 最近项目',['Recents','Shared','Browse'],190,1170),
{id:'file-menu',label:'长按本次下载的新视频',expect:['Recents','PB-4a239fb7'],action:{type:'long_press',point:{x:125/720,y:460/1280},durationMs:700}},
text('share-file','从文件菜单共享本次视频',['Quick Look','Get Info','Share'],'Share'),
text('save-video','保存到手机相册',['Save Video'],'Save Video'),
{id:'home-after-import',label:'返回桌面准备 Instagram',expect:[],action:{type:'phone_key',key:'home'}},
{id:'retry-home-after-import',label:'若仍在文件预览则重试返回桌面',expect:['PB-4a239fb7'],optional:true,timeoutMs:700,action:{type:'phone_key',key:'home'}},
{id:'retry-home-from-files',label:'若仍在 Files 则重试返回桌面',expect:['Recents','Shared','Browse'],optional:true,timeoutMs:700,action:{type:'phone_key',key:'home'}},
{id:'first-home-page',label:'从第一屏切换应用页',expect:['FaceTime','Calendar'],optional:true,timeoutMs:700,action:{type:'swipe',start:{x:600/720,y:700/1280},end:{x:160/720,y:700/1280},durationMs:400}},
tap('instagram','打开 Instagram',['Instagram'],611,940),
tap('retry-instagram','若仍在桌面则重试打开 Instagram',['Files','Weather','Instagram'],611,940,true),
tap('close-existing-post','关闭上次作品详情',['Posts','View insights','{{account}}'],65,80,true),
{...tap('profile','打开目标账号主页',[],645,1210),absent:['Files','Weather']},
{id:'baseline',label:'核对测试前 28 条作品',expect:['{{account}}','28','posts'],verify:true},
tap('create','创建新 Reel',['{{account}}'],65,86),
text('reel','选择 Reel',['Create'],'Reel'),
{id:'verify-import',label:'验证新视频已进入 Instagram 相册',expect:['New reel','Recents','1:19'],verify:true}
];
let transfer:Awaited<ReturnType<typeof openPublishingTransfer>>|undefined;
try{transfer=await openPublishingTransfer(media,plan.caption,'192.168.2.17','192.168.2.25');
const activeSteps=process.argv.includes('--publish')?[...steps,...instagramPublishSteps]:process.argv.includes('--gallery-only')?steps.slice(steps.findIndex(s=>s.id==='home-after-import')):steps;
const durationSeconds=Math.ceil(media.duration);const durationLabel=Math.floor(durationSeconds/60)+':'+String(durationSeconds%60).padStart(2,'0');
for(const s of activeSteps){
  s.expect=s.expect.map(x=>x.replaceAll('PB-4a239fb7','PB-'+media.id.slice(0,8)).replaceAll('1:19',durationLabel));
  if(s.id==='baseline'){s.expect=['{{account}}',String(baseline),'posts'];s.label='核对测试前 '+baseline+' 条作品';}
  if(s.id==='verify-count'){s.expect=['{{account}}',String(baseline+1),'posts'];s.label='验证作品数增加到 '+(baseline+1);}
if(s.targetText&&!s.action)s.action={type:'tap',point:{x:.5,y:.5}};if(s.action&&['tap','long_press','swipe'].includes(s.action.type)){s.action.touchZ=9.5;if(['profile','submit','picker-next','editor-next','profile-after-post','reload','retry-reload','safari','files-recents'].includes(s.id)){s.action.touchZ=9.8;s.action.durationMs=80;}}}
const w={id:'instagram-import-trial',deviceId:plan.deviceId,platform:'instagram',account:'florence_nanny',trained:false,steps:activeSteps,version:2,updatedAt:Date.now(),name:'新视频导入无人值守验收'} as PublishWorkflow;
await writeFile('.runtime/instagram-trial-active.json',JSON.stringify({runId:run.id,planId:plan.id,mediaId:media.id,caption:plan.caption,baseline,steps:activeSteps},null,2));
await runner[process.argv.includes('--publish')?'trial':'rehearse'](run,media,w,r=>{store.run(r);console.log(r.step)},()=>false);
if(!process.argv.includes('--gallery-only')&&(!transfer.status().downloaded||!transfer.status().copied))throw Error('手机未确认完成完整下载和文案复制');run.status=run.submitted?'succeeded':'staged';run.step=run.submitted?'新视频无人值守发布验证通过':'新视频导入预演通过，尚未发布';
}catch(e){run.status=run.submitted?'needs_review':'failed';run.error=e instanceof Error?e.message:String(e);console.log('STOP:',run.error);}finally{run.endedAt=Date.now();store.run(run);transfer?.close();store.close();console.log(JSON.stringify({runId:run.id,status:run.status,submitted:run.submitted,elapsedMs:run.endedAt-run.startedAt,error:run.error,evidence:run.evidence}));}
