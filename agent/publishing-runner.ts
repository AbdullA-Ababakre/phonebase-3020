import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recognizeVisionText, type VisionTextItem } from './vision-ocr';
import type { PublishMedia, PublishRun, PublishWorkflow } from './publishing-store';
import { homographyFromFourPoints, projectPoint, type Point } from './homography';

export function publishingTargetPoint(point:Point,ocr:{width:number;height:number},screen:{width:number;height:number;rawWidth:number;rawHeight:number;rectified:boolean;imagePoints:[Point,Point,Point,Point]|null}):Point {
  if(!screen.rectified||!screen.imagePoints)return {x:point.x/ocr.width,y:point.y/ocr.height};
  const raw={x:point.x/ocr.width*screen.rawWidth,y:point.y/ocr.height*screen.rawHeight};
  return projectPoint(homographyFromFourPoints(screen.imagePoints,[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]),raw);
}

export function publishingTextMatches(actual:string,expected:string,mode?:'unique'|'leftmost'|'label'):boolean {
  const normalize=(s:string)=>s.trim().toLowerCase();
  const value=normalize(actual);
  return (mode==='label'?value.replace(/\s*[~\-–—⌄∨˅▼▾]+$/u,'').trim():value)===normalize(expected);
}

export function publishingPageReady(text:string,expect:string[],absent:string[]=[]):boolean {
  const normalize=(value:string)=>value.replace(/\s+/g,' ').toLowerCase();const actual=normalize(text);
  return expect.every(x=>!x||actual.includes(normalize(x)))&&!absent.some(x=>actual.includes(normalize(x)));
}

// Require the number directly above the Posts label, not a follower count or caption number.
export function instagramPostCount(items:VisionTextItem[]):number|undefined {
  const labels=items.filter(x=>/^posts$/i.test(x.text.trim()));
  if(labels.length!==1)return;
  const label=labels[0];
  const candidates=items.filter(x=>/^\d[\d,]*$/.test(x.text.trim())&&Math.abs(x.centerX-label.centerX)<Math.max(label.width*.65,10)&&x.centerY<label.centerY&&label.centerY-x.centerY<label.height*3.5);
  if(candidates.length!==1)return;
  const count=Number(candidates[0].text.replaceAll(',',''));return Number.isSafeInteger(count)?count:undefined;
}

export function hasFreshInstagramTimestamp(items:VisionTextItem[],maxMinutes=9):boolean {
  return items.some(x=>{const t=x.text.trim();if(/^(?:just now|[1-9] seconds? ago|[1-5]\d seconds? ago)$/i.test(t))return true;const m=/^(\d+) minutes? ago$/i.exec(t);return !!m&&Number(m[1])<=maxMinutes;});
}

const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export function workflowIssue(w:PublishWorkflow):string|null {
  if(!w.account?.trim())return '首次学习时需要确认目标账号';
  if(!Array.isArray(w.steps)||w.steps.length<3||w.steps.length>150)return '需要完整录制工作流';
  if(w.steps.filter(s=>s.submit).length!==1)return '工作流必须有且只有一个最终发布动作';
  const submit=w.steps.findIndex(s=>s.submit);
  if(!w.steps.slice(submit+1).some(s=>s.verify && s.expect?.length))return '需要发布后的结果验证步骤';
  if(!w.steps.slice(0,submit).some(s=>s.expect?.some(x=>x.includes('{{caption}}'))))return '需要发布前的文案校验';
  if(!w.steps.slice(0,submit).some(s=>s.expect?.some(x=>x.includes('{{account}}'))))return '需要发布前的目标账号校验';
  if(new Set(w.steps.map(s=>s.id)).size!==w.steps.length)return '步骤 ID 不能重复';
  for(const s of w.steps){
    if(!s.id||!s.label||!Array.isArray(s.expect)||s.expect.some(x=>typeof x!=='string'||x.length>2300))return '步骤格式无效';
    if(s.absent && (!Array.isArray(s.absent)||s.absent.some(x=>typeof x!=='string'||!x.trim())))return '排除页面条件无效';
    if(s.targetMatch && !['unique','leftmost','label'].includes(s.targetMatch))return '文字匹配方式无效';
    if(s.targetOffset && (!s.targetText||![s.targetOffset.x,s.targetOffset.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=.5)))return '文字锚点偏移无效';
    if(s.submit && (s.targetOffset||(s.targetMatch&&s.targetMatch!=='unique')))return '发布按钮必须唯一且不能偏移';
    if(s.submit && (s.optional||!s.expect.length||!s.targetText))return '发布动作需要明确的页面检查和按钮文字';
    if(s.verify && (!s.expect.length||s.optional||s.submit))return '结果验证不能跳过';
    if(s.action && !['tap','long_press','swipe','phone_key','input_text'].includes(s.action.type))return '不支持的录制动作';
    if(s.timeoutMs!==undefined&&(!Number.isFinite(s.timeoutMs)||s.timeoutMs<500||s.timeoutMs>180000))return '等待时间无效';
    if(s.action && ['tap','long_press'].includes(s.action.type)){const p=s.action.point as {x:number;y:number};if(!p||![p.x,p.y].every(x=>Number.isFinite(x)&&x>=0&&x<=1))return '点击坐标必须归一化';}
  }
  return null;
}

export class PublishingRunner {
  constructor(private base:string,private root:string,private token='',private workerId='publishing-worker'){}
  private async json(path:string,body?:unknown){const r=await fetch(this.base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-phonebase-actor':this.workerId,...(this.token?{authorization:`Bearer ${this.token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});const p=await r.json();if(!r.ok||p.ok===false)throw Error(p.error||`HTTP ${r.status}`);return p;}
  async execute(run:PublishRun,media:PublishMedia,w:PublishWorkflow,save:(r:PublishRun)=>void,stopped:()=>boolean){
    const issue=workflowIssue(w);if(issue||!w.trained)throw Error(issue||'首次学习未完成');
    return this.perform(run,media,w,save,stopped);
  }
  async rehearse(run:PublishRun,media:PublishMedia,w:PublishWorkflow,save:(r:PublishRun)=>void,stopped:()=>boolean){
    if(w.steps.some(s=>s.submit)||!w.steps.at(-1)?.verify)throw Error('预演不能包含发布动作，必须以页面验证结束');
    return this.perform(run,media,w,save,stopped);
  }
  async trial(run:PublishRun,media:PublishMedia,w:PublishWorkflow,save:(r:PublishRun)=>void,stopped:()=>boolean,beforeSubmit?:()=>void){
    const issue=workflowIssue(w);if(issue)throw Error(issue);
    return this.perform(run,media,w,save,stopped,beforeSubmit);
  }
  private async perform(run:PublishRun,media:PublishMedia,w:PublishWorkflow,save:(r:PublishRun)=>void,stopped:()=>boolean,beforeSubmit?:()=>void){
    const path=`/api/v1/devices/${encodeURIComponent(run.deviceId)}`;
    const vars:Record<string,string>={caption:run.snapshot.caption,album:media.album,account:w.account};
    const interpolate=(s:string)=>s.replace(/\{\{(caption|album|account)\}\}/g,(_,k)=>vars[k]);
    let verified=false,baseline:number|undefined;
    for(const step of w.steps){
      if(stopped())throw Error('用户暂停任务');
      const stepStarted=Date.now();
      run.step=step.label;save(run);
      const deadline=Date.now()+(step.timeoutMs??12000);
      let stableTarget:{x:number;y:number;at:number}|undefined;
      let found=false,items:VisionTextItem[]=[],frame:Buffer|undefined,ocrWidth=0,ocrHeight=0;
      do {
        if(stopped())throw Error('用户暂停任务');
        const r=await fetch(this.base+path+'/screenshot',{headers:this.token?{authorization:`Bearer ${this.token}`}:{},signal:AbortSignal.timeout(5000)});
        if(!r.ok)throw Error('手机画面不可用');frame=Buffer.from(await r.arrayBuffer());
        if(!step.expect.length&&!step.targetText&&!step.absent?.length){found=true;break;}
        const terms=step.expect.map(interpolate);
        for(const mode of ['fast','accurate'] as const){
          const ocr=await recognizeVisionText(`data:image/jpeg;base64,${frame.toString('base64')}`,undefined,mode);items=ocr.items;ocrWidth=ocr.imageWidth;ocrHeight=ocr.imageHeight;
          const text=items.map(x=>x.text).join(' ').replace(/\s+/g,' ').toLowerCase();
          // Retry small camera labels with accurate local OCR, not a model call.
          const targets=step.targetText?items.filter(x=>publishingTextMatches(x.text,interpolate(step.targetText!),step.targetMatch)):[];
          const targetReady=!step.targetText||(step.targetMatch==='leftmost'?targets.length>0:targets.length===1);
          found=targetReady&&publishingPageReady(text,terms,(step.absent??[]).map(interpolate));
          if(found&&step.freshPost)found=hasFreshInstagramTimestamp(items,Math.ceil((Date.now()-run.startedAt)/60000));
          if(found&&step.postCount){
            const count=instagramPostCount(items);
            found=count!==undefined&&(step.postCount==='capture'||(baseline!==undefined&&count===baseline+1));
            if(found&&step.postCount==='capture')baseline=count;
          }
          if(found)break;
        }
        if(found&&step.targetText){
          const target=items.filter(x=>publishingTextMatches(x.text,interpolate(step.targetText!),step.targetMatch)).sort((a,b)=>a.centerX-b.centerX)[0];
          const stable=stableTarget&&Math.abs(target.centerX-stableTarget.x)<8&&Math.abs(target.centerY-stableTarget.y)<8&&Date.now()-stableTarget.at>=350;
          if(!stable){stableTarget={x:target.centerX,y:target.centerY,at:stableTarget&&Math.abs(target.centerX-stableTarget.x)<8&&Math.abs(target.centerY-stableTarget.y)<8?stableTarget.at:Date.now()};found=false;}
        }else if(!found){stableTarget=undefined;}
        if(found)break;
        await wait(250);
      }while(Date.now()<deadline);
      if(!found){if(step.optional)continue;const dir=join(this.root,run.id);await mkdir(dir,{recursive:true});const name=`failed-${step.id}-${Date.now()}.jpg`;if(frame){await writeFile(join(dir,name),frame);run.evidence.push(`${run.id}/${name}`);save(run);}throw Error(`页面未就绪：${step.label}`);}
      if(step.submit||step.verify){const dir=join(this.root,run.id);await mkdir(dir,{recursive:true});const name=`${step.submit?'before-publish':'verified'}-${Date.now()}.jpg`;await writeFile(join(dir,name),frame!);run.evidence.push(`${run.id}/${name}`);save(run);}
      if(step.verify){verified=true;continue;}
      let action=step.caption?{type:'input_text',text:run.snapshot.caption}:step.action?structuredClone(step.action):undefined;
      const device=(await this.json(path)).device;
      if(step.targetText){const expected=interpolate(step.targetText).toLowerCase();const matches=items.filter(x=>publishingTextMatches(x.text,expected,step.targetMatch)).sort((a,b)=>a.centerX-b.centerX);if(!matches.length||(step.targetMatch!=='leftmost'&&matches.length!==1))throw Error(`按钮不唯一或不可见：${expected}`);const point=publishingTargetPoint({x:matches[0].centerX,y:matches[0].centerY},{width:ocrWidth,height:ocrHeight},device.screen);action={...action,type:'tap',point:{x:point.x+(step.targetOffset?.x??0),y:point.y+(step.targetOffset?.y??0)}};}
      if(!action || (step.caption&&!run.snapshot.caption))continue;
      if(!device.capabilities.actions[action.type]?.available)throw Error(device.capabilities.actions[action.type]?.reason||'手机操作未就绪');
      if(['tap','long_press','swipe'].includes(action.type)){
        if(Date.now()-device.screen.capturedAt>2500)throw Error('手机画面已过期');
        for(const key of ['point','start','end'])if(action[key]){const p=action[key] as {x:number;y:number};if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1)throw Error('坐标无效');action[key]={x:p.x*device.screen.width,y:p.y*device.screen.height};}
        action.viewport={width:device.screen.width,height:device.screen.height};action.frameSequence=device.screen.sequence;action.durationMs=action.durationMs??(action.type==='long_press'?700:40);const profile=device.state.grbl.tapProfile;const touchZ=action.touchZ??profile.maximumTouchZ;if(typeof touchZ!=='number'||!Number.isFinite(touchZ)||touchZ<profile.minimumTouchZ||touchZ>profile.maximumTouchZ)throw Error('触摸力度超出设备已验证范围');action.touchZ=touchZ;
      }
      if(step.submit){beforeSubmit?.();run.submitted=true;save(run);} // Persist before transmission: never blindly retry an ambiguous Share.
      let receipt=(await this.json(path+'/actions',{idempotencyKey:`publish-${run.id}-${step.id}`,action})).result?.receipt;
      if(!receipt?.id)throw Error('操作没有返回回执');
      const end=Date.now()+Math.max(20000,run.snapshot.caption.length*400);
      while(!['completed','failed'].includes(receipt.status)&&Date.now()<end){await wait(100);if(stopped()&&!step.submit)throw Error('用户暂停任务');receipt=(await this.json(path+'/actions/'+receipt.id)).receipt;}
      if(receipt.status!=='completed')throw Error(receipt.error||'操作回执超时');
      const dir=join(this.root,run.id);await mkdir(dir,{recursive:true});await appendFile(join(dir,'steps.jsonl'),JSON.stringify({stepId:step.id,label:step.label,elapsedMs:Date.now()-stepStarted,receiptId:receipt.id,status:receipt.status})+'\n');
      await wait(180);
    }
    if(!verified)throw Error('没有取得发布成功证据');
  }
}
