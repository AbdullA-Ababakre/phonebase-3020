import type {PublishStep} from '../../agent/publishing-store';
const tap=(id:string,label:string,expect:string[],x:number,y:number):PublishStep=>({id,label,expect,action:{type:'tap',point:{x:x/720,y:y/1280},durationMs:40}});
const swipe=(id:string,label:string,expect:string[],x:number,y:number,xx:number,yy:number):PublishStep=>({id,label,expect,action:{type:'swipe',start:{x:x/720,y:y/1280},end:{x:xx/720,y:yy/1280},durationMs:500}});
export const instagramPublishSteps:PublishStep[]=[
// The import stage has already opened and checked the target account and new gallery item.
tap('choose-new-video','选择刚导入的第一条新视频',['New reel','Recents','1:19'],360,550),
{...tap('select-preview','确认预览中的视频',['Select','Cancel'],350,1160),optional:true,timeoutMs:1000,absent:['First draft']},
tap('picker-next','进入视频编辑器',['Next'],630,1209),
tap('editor-next','进入发布设置',['Edit video','Next'],621,1237),
tap('caption-open','填写本次文案',['New reel','Add a caption'],230,765),
{id:'paste-menu',label:'打开粘贴菜单',expect:['Caption'],action:{type:'long_press',point:{x:140/720,y:195/1280},durationMs:700}},
{id:'paste',label:'粘贴本次文案',expect:['Caption'],targetText:'Paste'},
{id:'caption-ok',label:'核对完整文案',expect:['{{caption}}'],targetText:'OK'},
{id:'submit',label:'核对文案并提交一次',expect:['New reel','{{caption}}'],targetText:'Share',submit:true},
// Wait for the posted video to replace the upload progress in the feed.
{id:'await-post',label:'等待上传结束和本人作品出现',expect:['Instagram','{{account}}','Original audio'],timeoutMs:180000},
tap('profile-after-post','打开账号主页',['Instagram','{{account}}'],645,1210),
swipe('refresh-profile','刷新账号作品列表',['{{account}}','posts'],360,480,360,980),
{id:'verify-count',label:'验证作品数增加到 29',expect:['{{account}}','29','posts'],timeoutMs:20000,verify:true},
// Open the newest item after making the grid visible; collection layout is checked by this trial.
swipe('show-grid','显示最新作品',['{{account}}'],355,1050,355,420),
{id:'posts-grid',label:'按可见锚点切换作品网格',expect:['Follow'],absent:['New reel','Reels drafts'],targetText:'Follow',targetMatch:'leftmost',targetOffset:{x:0,y:125/1280}},
{id:'open-new-post',label:'按可见锚点打开最新作品',expect:['{{account}}'],absent:['Follow','New reel','Reels drafts'],targetText:'{{account}}',targetMatch:'label',targetOffset:{x:-240/720,y:300/1280}},
swipe('show-caption','查看发布后的文案',['Posts','{{account}}'],350,1000,350,560),
{id:'verify-caption',label:'核对发布后的账号和文案',expect:['Posts','{{account}}','{{caption}}'],timeoutMs:15000,verify:true}
];
