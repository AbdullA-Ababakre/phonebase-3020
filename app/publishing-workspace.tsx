"use client";
import { useEffect, useRef, useState } from 'react';
import { UploadSimple, Clock, ArrowUp, ArrowDown, Play, X, Plus, VideoCamera, CheckCircle } from '@phosphor-icons/react';
import { controlPlaneFetch, controlPlaneUrl, type ControlPlaneEndpoint } from './control-plane-endpoint';

type Media={id:string;name:string;bytes:number;duration:number;width:number;height:number;sha256:string};
type Plan={id:string;mediaId:string;deviceId:string;caption:string;timezone:string;platforms:string[];enabled:boolean;nextRun:number;readiness:string[];mode?:'once';claimedAt?:number};
type Run={id:string;planId:string;platform:string;status:string;step:string;error:string;startedAt:number;evidence:string[]};
type Snapshot={media:Media[];plans:Plan[];runs:Run[];busyDevices:string[];workflows:{platform:string;deviceId:string;trained:boolean;account:string}[]};
const empty:Snapshot={media:[],plans:[],runs:[],workflows:[],busyDevices:[]};
const names:Record<string,string>={instagram:'Instagram',facebook:'Facebook'};
const statuses:Record<string,string>={queued:'Queued',running:'Publishing',succeeded:'Verified',failed:'Failed',needs_review:'Needs review',interrupted:'Interrupted',skipped:'Missed'};
const date=(p:Plan)=>new Date(p.nextRun).toLocaleString('en-US',{timeZone:p.timezone,month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});

const duration=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
function VideoThumbnail({media,endpoint,onClick}:{media:Media;endpoint:ControlPlaneEndpoint;onClick:()=>void}){
  const [failed,setFailed]=useState(false);
  return <button type="button" className="publish-thumb" onClick={onClick} aria-label={`Preview ${media.name}`} title="Preview video">
    {/* Remote media is served by the local control plane, so Next/Image cannot optimize it. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {!failed?<img src={controlPlaneUrl(endpoint,`/api/v1/publishing/media/${media.id}/thumbnail`)} alt="" loading="lazy" onError={()=>setFailed(true)}/>:<VideoCamera size={24}/>}<span className="publish-thumb-play"><Play size={18} weight="fill"/></span><small>{duration(media.duration)}</small>
  </button>;
}
function VideoPreview({media,endpoint,onClose}:{media:Media;endpoint:ControlPlaneEndpoint;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);const [failed,setFailed]=useState(false);
  useEffect(()=>{const el=dialog.current;const previous=document.activeElement as HTMLElement|null;el?.showModal();return()=>{el?.close();previous?.focus();};},[]);
  return <dialog ref={dialog} className="publish-video-dialog" aria-labelledby="publish-preview-title" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="publish-video-shell"><header><div><span>Video preview</span><h2 id="publish-preview-title">{media.name}</h2></div><button type="button" autoFocus onClick={onClose} aria-label="Close video preview"><X size={22}/></button></header>
    <video controls playsInline preload="metadata" poster={controlPlaneUrl(endpoint,`/api/v1/publishing/media/${media.id}/thumbnail`)} src={controlPlaneUrl(endpoint,`/api/v1/publishing/media/${media.id}`)} onError={()=>setFailed(true)}/>
    {failed&&<p role="alert">Your browser could not play this video. <a href={controlPlaneUrl(endpoint,`/api/v1/publishing/media/${media.id}`)} target="_blank" rel="noreferrer">Open source video</a></p>}
    <footer><span>{duration(media.duration)} · {media.width} × {media.height} · {(media.bytes/1048576).toFixed(1)} MB</span><span>Seek, volume, and full-screen controls are available</span></footer></div>
  </dialog>;
}

export function PublishingWorkspace({endpoint,devices}:{endpoint:ControlPlaneEndpoint;devices:{id:string;connected:boolean}[]}){
  const [data,setData]=useState<Snapshot>(empty),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [selected,setSelected]=useState<string[]>([]),[deviceId,setDeviceId]=useState('black-arm-01'),[caption,setCaption]=useState('');
  const [times,setTimes]=useState(['09:00']),[timezone,setTimezone]=useState('Asia/Shanghai'),[platforms,setPlatforms]=useState(['instagram']);
  const [busy,setBusy]=useState(false),[uploading,setUploading]=useState(false),[progress,setProgress]=useState(''),[loaded,setLoaded]=useState(false);
  const [watching,setWatching]=useState<Media|null>(null),[dragging,setDragging]=useState(false),[queueFilter,setQueueFilter]=useState('all');
  const [preview,setPreview]=useState<Plan[]>([]),[previewError,setPreviewError]=useState('');
  const [now,setNow]=useState(()=>Date.now());
  const input=useRef<HTMLInputElement>(null),uploadRef=useRef<XMLHttpRequest|null>(null),uploadLock=useRef(false),mounted=useRef(true),actionLock=useRef(false);
  async function refresh(){try{const r=await controlPlaneFetch(endpoint,'/api/v1/publishing');const p=await r.json();if(!r.ok)throw Error(p.error);if(mounted.current){setData(p);setNow(Date.now());setLoaded(true);}}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Could not connect to the publishing service');}}
  useEffect(()=>{mounted.current=true;const initial=window.setTimeout(()=>void refresh(),0);const timer=setInterval(()=>void refresh(),3000);return()=>{mounted.current=false;clearTimeout(initial);clearInterval(timer);uploadRef.current?.abort();};},[endpoint.baseUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  const payload={mediaIds:selected,deviceId,caption,times,timezone,platforms};
  const previewKey=JSON.stringify({...payload,caption:''});
  useEffect(()=>{
    let cancelled=false;
    const timer=setTimeout(async()=>{
      setPreview([]);setPreviewError('');
      if(!selected.length||!platforms.length)return;
      try{const r=await controlPlaneFetch(endpoint,'/api/v1/publishing/queue/preview',{method:'POST',headers:{'content-type':'application/json'},body:previewKey});const p=await r.json();if(!r.ok)throw Error(p.error);if(!cancelled)setPreview(p.plans);}catch(e){if(!cancelled)setPreviewError(e instanceof Error?e.message:'Could not calculate the schedule');}
    },250);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[previewKey,endpoint.baseUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  async function request(path:string,body?:unknown,method='POST'){const r=await controlPlaneFetch(endpoint,'/api/v1/publishing'+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const p=await r.json();if(!r.ok)throw Error(p.error);return p;}
  async function act(fn:()=>Promise<void>){if(actionLock.current)return;actionLock.current=true;setBusy(true);setError('');setNotice('');try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:'Operation failed');}finally{actionLock.current=false;setBusy(false);}}
  async function upload(files:FileList|File[]|null){
    if(!files?.length||uploadLock.current)return;
    const list=Array.from(files);if(list.length+selected.length>200){setError('Up to 200 videos per batch');return;}
    uploadLock.current=true;setUploading(true);setError('');setNotice('');const failures:string[]=[];let successes=0;
    for(let i=0;i<list.length&&mounted.current;i++){
      const file=list[i];
      try{
        if(file.size>500*1024*1024)throw Error('File exceeds 500 MB');
        if(!/\.(mp4|mov|m4v)$/i.test(file.name))throw Error('Unsupported format');
        setProgress(`${i+1}/${list.length} · ${file.name}`);
        const result=await new Promise<{media:Media}>((resolve,reject)=>{
          const xhr=new XMLHttpRequest();uploadRef.current=xhr;xhr.open('POST',controlPlaneUrl(endpoint,`/api/v1/publishing/media?name=${encodeURIComponent(file.name)}`));xhr.setRequestHeader('Content-Type','application/octet-stream');if(endpoint.accessToken)xhr.setRequestHeader('Authorization',`Bearer ${endpoint.accessToken}`);
          xhr.upload.onprogress=e=>{if(e.lengthComputable)setProgress(`${i+1}/${list.length} · ${file.name} · ${Math.round(e.loaded/e.total*100)}%`);};xhr.timeout=10*60000;
          xhr.onload=()=>{try{const p=JSON.parse(xhr.responseText);if(xhr.status>=200&&xhr.status<300)resolve(p);else reject(Error(p.error||'Upload failed'));}catch{reject(Error('Unexpected upload response'));}};
          xhr.onerror=()=>reject(Error('Connection interrupted'));xhr.ontimeout=()=>reject(Error('Upload timed out'));xhr.onabort=()=>reject(Error('Upload cancelled'));xhr.send(file);
        });
        if(mounted.current){setData(d=>({...d,media:[result.media,...d.media.filter(m=>m.id!==result.media.id)]}));setSelected(ids=>[...ids,result.media.id]);}successes++;
      }catch(e){failures.push(`${file.name}: ${e instanceof Error?e.message:'Upload failed'}`);}
    }
    uploadLock.current=false;uploadRef.current=null;
    if(mounted.current){setUploading(false);setProgress('');if(input.current)input.current.value='';await refresh();setNotice(`Uploaded ${successes} video${successes === 1 ? "" : "s"}. Scheduling follows the selected order.`);setError(failures.join('; '));}
  }
  const queue=data.plans.filter(p=>p.mode==='once').sort((a,b)=>a.nextRun-b.nextRun);
  const legacy=data.plans.filter(p=>p.mode!=='once');
  const blocked=platforms.filter(p=>!data.workflows.some(w=>w.platform===p&&w.deviceId===deviceId&&w.trained));
  function move(index:number,delta:number){setSelected(ids=>{const next=[...ids];const target=index+delta;if(target<0||target>=next.length)return ids;[next[index],next[target]]=[next[target],next[index]];return next;});}
  function choose(id:string){setSelected(ids=>ids.includes(id)?ids.filter(x=>x!==id):ids.length<200?[...ids,id]:ids);}
  async function save(){await act(async()=>{const result=await request('/queue',payload);setSelected([]);setNotice(`Scheduled ${result.plans.length} video${result.plans.length === 1 ? "" : "s"}. Each will publish once to every selected platform. ${result.plans.some((p:Plan)=>p.readiness.length)?'Publishing is waiting for workflow validation and will not run automatically yet.':'Publishing will begin at the scheduled time.'}`);});}
  async function toggle(p:Plan){await act(async()=>{await request('/plans/'+p.id,{enabled:!p.enabled},'PATCH');});}
  return <div className="publishing-workspace publish-simple">
    <div className="workspace-heading"><div><h1>Publishing</h1><p>Upload multiple videos and place them into a clear, daily publishing queue.</p></div><span className="publish-local-badge"><Clock size={16}/> Runs on this station</span></div>
    {error&&<div className="publish-message error" role="alert">{error}<button type="button" onClick={()=>setError('')} aria-label="Dismiss error">×</button></div>}
    {notice&&<div className="publish-message" role="status">{notice}</div>}
    <nav className="publish-flow" aria-label="Publishing steps"><span className={selected.length?'complete':'current'}><CheckCircle/> Select and preview</span><span><Clock/> Set daily times</span><span><CheckCircle/> Review schedule</span></nav>
    <div className="publish-compose">
      <section className="publish-card"><h2><b className="publish-step">1</b> Add videos <small>{selected.length?`${selected.length} selected`:''}</small></h2>
        <label className={`publish-dropzone ${dragging?'is-dragging':''}`} onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);if(!busy)void upload(e.dataTransfer.files);}}>
          <UploadSimple size={28}/><strong>{uploading?'Uploading videos…':'Drop videos here or click to browse'}</strong><span>{uploading?progress:'Multiple files · MP4 / MOV / M4V · 500 MB each'}</span>
          <input ref={input} type="file" multiple accept="video/mp4,video/quicktime,.m4v" disabled={uploading||busy} onChange={e=>void upload(e.target.files)}/>
        </label>
        {selected.length>0&&<><div className="publish-selection-heading"><span>{selected.length} videos · select a cover to preview</span><button type="button" className="publish-text-button" disabled={busy||uploading} onClick={()=>setSelected([])}>Clear selection</button></div><ol className="publish-selected">{selected.map((id,i)=>{const m=data.media.find(x=>x.id===id);return <li key={id}><span className="publish-order">{i+1}</span>{m&&<VideoThumbnail media={m} endpoint={endpoint} onClick={()=>setWatching(m)}/>}<div className="publish-selected-info"><button type="button" className="publish-video-name" onClick={()=>m&&setWatching(m)}>{m?.name??'Video'}</button><small>{m?`${m.width} × ${m.height} · ${(m.bytes/1048576).toFixed(1)} MB`:''}</small><small className="publish-assigned">{preview[i]?date(preview[i]):'Waiting for a time slot'}</small></div><div className="publish-item-actions"><button type="button" disabled={busy||uploading||i===0} aria-label={`Move up ${m?.name}`} title="Publish earlier" onClick={()=>move(i,-1)}><ArrowUp/></button><button type="button" disabled={busy||uploading||i===selected.length-1} aria-label={`Move down ${m?.name}`} title="Publish later" onClick={()=>move(i,1)}><ArrowDown/></button><button type="button" disabled={busy||uploading} aria-label={`Remove ${m?.name}`} title="Remove from this batch" onClick={()=>choose(id)}><X/></button></div></li>;})}</ol></>}
        <details className="publish-details publish-library-details"><summary>Media library <span>{data.media.length} uploaded</span></summary><div className="publish-library">{data.media.map(m=><div className={`publish-library-item ${selected.includes(m.id)?'is-selected':''}`} key={m.id}><VideoThumbnail media={m} endpoint={endpoint} onClick={()=>setWatching(m)}/><label><input type="checkbox" checked={selected.includes(m.id)} disabled={busy||uploading} onChange={()=>choose(m.id)}/><span>{m.name}<small>{duration(m.duration)} · {(m.bytes/1048576).toFixed(1)} MB</small></span></label></div>)}{!data.media.length&&<p>Uploaded videos stay here for reuse and preview.</p>}</div></details>
      </section>
      <section className="publish-card publish-form"><h2><b className="publish-step">2</b> Configure publishing</h2>
        <fieldset className="publish-platforms" disabled={busy}><legend>Publish to</legend>{['instagram','facebook'].map(p=><label key={p} className={platforms.includes(p)?'selected':''}><input type="checkbox" checked={platforms.includes(p)} onChange={e=>setPlatforms(v=>e.target.checked?[...v,p]:v.filter(x=>x!==p))}/><span>{names[p]}</span></label>)}</fieldset>
        <label className="publish-field">Shared caption<textarea rows={3} maxLength={2200} value={caption} disabled={busy} onChange={e=>setCaption(e.target.value)} placeholder="Caption and hashtags for this batch"/><small>{caption.length} / 2200 · Applied to every video in this batch</small></label>
        <div className="publish-field">Daily publishing times<div className="publish-slots">{times.map((t,i)=><div key={i}><input aria-label={`Publishing time ${i+1}`} type="time" value={t} disabled={busy} onChange={e=>setTimes(v=>v.map((x,j)=>j===i?e.target.value:x))}/>{times.length>1&&<button type="button" disabled={busy} aria-label={`Remove time slot ${i+1}`} onClick={()=>setTimes(v=>v.filter((_,j)=>j!==i))}><X/></button>}</div>)}<button type="button" className="publish-link" disabled={busy||times.length>=24} onClick={()=>setTimes(v=>[...v,['18:00',...Array.from({length:24},(_,i)=>String(i).padStart(2,'0')+':00')].find(t=>!v.includes(t))??'18:00'])}><Plus/> Add time</button></div><small>One video per slot, in order, with no repeats.</small></div>
        <details className="publish-details"><summary>{deviceId==='black-arm-01'?'PhoneUse 1':deviceId==='black-arm-02'?'PhoneUse 2':deviceId} · {timezone==='Asia/Shanghai'?'China Standard Time':timezone} · Edit</summary><div className="publish-time"><label className="publish-field">Device<select value={deviceId} disabled={busy} onChange={e=>setDeviceId(e.target.value)}>{[...new Set([deviceId,...devices.map(d=>d.id)])].map(id=><option key={id} value={id}>{id} · {devices.find(d=>d.id===id)?.connected?'Online':'Offline'}</option>)}</select></label><label className="publish-field">Time zone<select value={timezone} disabled={busy} onChange={e=>setTimezone(e.target.value)}>{['Asia/Shanghai','America/New_York','America/Los_Angeles','Europe/London','UTC'].map(t=><option key={t}>{t}</option>)}</select></label></div></details>
        {loaded&&blocked.length>0&&<p className="publish-gate">{blocked.map(p=>names[p]).join(', ')} publishing workflow needs validation. You can save the schedule now; execution starts only after validation.</p>}
        <p className="publish-note">Keep this computer awake and the phone connected and unlocked. Tasks delayed by more than 15 minutes are marked as missed.</p>
      </section>
    </div>
    <section className="publish-card publish-schedule"><div className="publish-card-heading"><h2><b className="publish-step">3</b> Review schedule</h2><button type="button" className="publish-primary" onClick={()=>void save()} disabled={!loaded||busy||uploading||!selected.length||!platforms.length||preview.length!==selected.length||!!previewError}>{busy?'Saving…':`Add to publishing queue${selected.length?` · ${selected.length} videos`:''}`}</button></div>
      {previewError?<p role="alert" className="publish-gate">{previewError}</p>:!selected.length?<p className="publish-note">Add videos to preview their assigned dates and times.</p>:!platforms.length?<p className="publish-note">Select at least one publishing platform.</p>:!preview.length?<p className="publish-note">Assigning time slots…</p>:<div className="publish-preview">{preview.map((p,i)=><div key={p.id}><span>{i+1}</span><strong>{date(p)}</strong><button type="button" className="publish-video-name" onClick={()=>setWatching(data.media.find(m=>m.id===p.mediaId)??null)}><Play size={14}/> {data.media.find(m=>m.id===p.mediaId)?.name}</button><small>{p.platforms.map(x=>names[x]).join(' + ')}</small></div>)}</div>}
    </section>
    <section className="publish-card"><div className="publish-card-heading"><h2>Publishing queue</h2><span>{queue.length} videos</span></div><div className="publish-queue-filters" role="group" aria-label="Filter publishing queue">{[['all','All'],['pending','Scheduled'],['done','Completed']].map(([value,label])=><button type="button" key={value} aria-pressed={queueFilter===value} onClick={()=>setQueueFilter(value)}>{label} · {queue.filter(p=>value==='all'||(value==='done'?!!p.claimedAt:!p.claimedAt)).length}</button>)}</div>{!loaded?<p className="publish-note">Loading…</p>:!queue.length?<p className="publish-note">No scheduled videos yet. Upload videos and add them to the queue.</p>:<div className="publish-queue">{queue.filter(p=>queueFilter==='all'||(queueFilter==='done'?!!p.claimedAt:!p.claimedAt)).map(p=>{const runs=data.runs.filter(r=>r.planId===p.id);const label=p.claimedAt?(runs.length?runs.map(r=>`${names[r.platform]} · ${statuses[r.status]??r.status}`).join(' / '):'Completed — review the run history'):!p.enabled?'Paused':p.nextRun<now?'Expired — needs attention':p.readiness.length?'Waiting for workflow validation':'Scheduled';return <article key={p.id}><div><strong>{date(p)}</strong><small>{p.timezone}</small></div><div><button type="button" className="publish-video-name" onClick={()=>setWatching(data.media.find(m=>m.id===p.mediaId)??null)}><Play size={16}/> {data.media.find(m=>m.id===p.mediaId)?.name}</button><small>{p.platforms.map(x=>names[x]).join(' + ')} · {p.deviceId==='black-arm-01'?'PhoneUse 1':p.deviceId}</small><details><summary>{label}</summary><p>{p.caption||'No caption'}</p>{!p.claimedAt&&p.readiness.map(x=><p key={x}>{x}</p>)}{runs.map(r=><p key={r.id}>{r.error||r.step}</p>)}</details></div>{!p.claimedAt&&<button type="button" className="publish-link" disabled={busy} onClick={()=>void toggle(p)}>{p.enabled?'Pause':'Resume'}</button>}</article>;})}</div>}</section>
    <details className="publish-card publish-details"><summary>Run history and advanced actions</summary>
      <div className="publish-history">{data.runs.slice(0,20).map(r=><details key={r.id}><summary>{names[r.platform]} · {statuses[r.status]??r.status} · {new Date(r.startedAt).toLocaleString('en-US')}</summary><p>{r.error||r.step}</p>{r.evidence.map((e,i)=><a key={e} href={controlPlaneUrl(endpoint,`/api/v1/publishing/evidence/${e}`)} target="_blank" rel="noreferrer">Evidence {i+1} </a>)}</details>)}</div>
      <button type="button" className="publish-link" disabled={busy||uploading||selected.length!==1||platforms.length!==1||platforms[0]!=='instagram'||deviceId!=='black-arm-01'||data.busyDevices.includes(deviceId)} onClick={()=>void act(async()=>{const p=await request('/plans',{mediaId:selected[0],deviceId,caption,time:times[0],timezone,platforms,enabled:false});await request('/plans/'+p.plan.id+'/trial');setNotice('Started a live-device validation. It will publish the selected video and verify the result.');})}>Validate Instagram with the selected video (live publish)</button>
      {legacy.length>0&&<details className="publish-details"><summary>Legacy schedules and tests · {legacy.length}</summary>{legacy.map(p=><div className="publish-legacy" key={p.id}><span>{data.media.find(m=>m.id===p.mediaId)?.name} · {p.enabled?'Legacy daily schedule':'Paused'}</span>{p.enabled&&<button type="button" className="publish-link" disabled={busy} onClick={()=>void toggle(p)}>Pause</button>}</div>)}</details>}
    </details>
    {watching&&<VideoPreview key={watching.id} media={watching} endpoint={endpoint} onClose={()=>setWatching(null)}/>}
  </div>;
}
