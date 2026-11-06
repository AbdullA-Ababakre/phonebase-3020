import type {PublishMedia,PublishWorkflow,PublishStep} from './publishing-store';
import {instagramPublishSteps} from '../scripts/publishing/instagram-publish-steps';
const tap=(id:string,label:string,expect:string[],x:number,y:number,optional=false):PublishStep=>({id,label,expect,action:{type:'tap',point:{x:x/720,y:y/1280},durationMs:40},...(optional?{optional:true,timeoutMs:700}:{})});
const text=(id:string,label:string,expect:string[],targetText:string):PublishStep=>({id,label,expect,targetText});
const importSteps:PublishStep[]=[
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
tap('dismiss-reload-menu','关闭刷新时偶发的地址菜单',['Switch Tab Groups'],660,280,true),
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
{id:'restore-ended-post-header',label:'恢复播放结束作品的返回栏',expect:['Watch more reels','{{account}}'],absent:['Posts','Edit profile','Share profile','New reel'],optional:true,timeoutMs:1500,action:{type:'swipe',start:{x:350/720,y:500/1280},end:{x:350/720,y:850/1280},durationMs:900}},
{id:'restore-post-header',label:'恢复已滚动作品的返回栏',expect:['View insights','{{account}}'],absent:['Posts','Edit profile','Share profile','New reel'],optional:true,timeoutMs:1500,action:{type:'swipe',start:{x:350/720,y:500/1280},end:{x:350/720,y:850/1280},durationMs:900}},
{...tap('close-existing-post','关闭上次作品详情',['Posts','{{account}}'],65,80,true),timeoutMs:3000,absent:['Edit profile','Share profile','New reel']},
{...tap('retry-close-existing-post','若仍在作品详情则再次返回',['Posts','{{account}}'],65,80,true),timeoutMs:1000,absent:['Edit profile','Share profile','New reel']},
{...tap('profile','打开目标账号主页',[],645,1210),absent:['Files','Weather']},
{id:'baseline',label:'核对测试前 28 条作品',expect:['{{account}}','28','posts'],verify:true},
tap('create','创建新 Reel',['{{account}}'],65,86),
text('reel','选择 Reel',['Create'],'Reel'),
{id:'verify-import',label:'验证新视频已进入 Instagram 相册',expect:['New reel','Recents','1:19'],verify:true}
];

export function instagramCandidate(media:PublishMedia):PublishWorkflow {
  const steps=structuredClone([...importSteps,...instagramPublishSteps]);
  const seconds=Math.ceil(media.duration),duration=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  for(const s of steps){
    s.expect=s.expect.map(x=>x.replaceAll('PB-4a239fb7','PB-'+media.id.slice(0,8)).replaceAll('1:19',duration));
    if(s.id==='show-caption'){s.action={type:'swipe',start:{x:350/720,y:1050/1280},end:{x:350/720,y:850/1280},durationMs:900};}
    if(s.id==='verify-caption'){s.expect=['{{account}}','{{caption}}'];s.freshPost=true;s.label='核对新作品账号、文案与刚刚发布的时间';}
    if(s.id==='baseline'){s.expect=['{{account}}','posts'];s.label='读取发布前作品数';s.postCount='capture';}
    if(s.id==='verify-count'){s.expect=['{{account}}','posts'];s.label='核对作品数增加一条';s.postCount='increment';}
    if(s.targetText&&!s.action)s.action={type:'tap',point:{x:.5,y:.5}};
    if(s.action&&['tap','long_press','swipe'].includes(s.action.type)){
      s.action.touchZ=s.id==='share-file'?9.8:9.5;
      if(['profile','submit','picker-next','editor-next','profile-after-post','reload','retry-reload','safari','files-recents'].includes(s.id)){s.action.touchZ=9.8;s.action.durationMs=['reload','retry-reload'].includes(s.id)?40:80;}
    }
  }
  return {id:'black-arm-01-instagram-candidate',deviceId:'black-arm-01',platform:'instagram',account:'florence_nanny',trained:false,steps,version:10,updatedAt:Date.now(),name:'Instagram 全流程自动验收'};
}
