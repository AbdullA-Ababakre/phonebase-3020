"use client";
import { useCallback, useEffect, useState } from 'react';
import { controlPlaneFetch, type ControlPlaneEndpoint } from './control-plane-endpoint';

type Activity = {id:number;at:number;kind:string;level:string;actor:string;source:string;deviceId:string;requestId:string;receiptId:string;actionType:string;status:string;durationMs:number|null;details:Record<string,unknown>};
type Incident = {key:string;title:string;level:string;deviceId:string;openedAt:number;updatedAt:number;resolvedAt:number|null;occurrences:number;details:Record<string,unknown>};
type Snapshot = {events:Activity[];total:number;nextCursor:number|null;metrics:{events:number;errors:number;completedActions:number;failedActions:number};gatewayP95Ms:number|null;incidents:Incident[];storage:{retentionDays:number;maxEvents:number;writeFailures:number};customers?:Array<{id:string;customer:string}>;updatedAt:number};
const time=(at:number)=>new Date(at).toLocaleString();
const ms=(value:number|null|undefined)=>value==null?'—':`${Math.round(value)} ms`;

export function ActivityWorkspace({endpoint}:{endpoint:ControlPlaneEndpoint}) {
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [error,setError]=useState(''); const [loading,setLoading]=useState(false);
  const [source,setSource]=useState(''); const [level,setLevel]=useState('');
  const [device,setDevice]=useState(''); const [actor,setActor]=useState(''); const [query,setQuery]=useState('');
  const [hours,setHours]=useState('24'); const [cursor,setCursor]=useState<number|null>(null);
  const [selected,setSelected]=useState<Activity|null>(null); const [live,setLive]=useState(true);
  const [trace,setTrace]=useState<Activity[]>([]);
  const refresh=useCallback(async()=>{
    setLoading(true);
    try {
      const params=new URLSearchParams({source,level,deviceId:device,actor,q:query,since:String(Date.now()-Number(hours)*3600000),limit:'100',...(cursor?{before:String(cursor)}:{})});
      const response=await controlPlaneFetch(endpoint,`/api/v1/admin/observability?${params}`,{cache:'no-store'});
      if(!response.ok)throw Error(`Activity unavailable (${response.status})`);
      setSnapshot(await response.json());setError('');
    } catch(e){setError(e instanceof Error?e.message:'Unable to load activity');}
    finally{setLoading(false);}
  },[endpoint,source,level,device,actor,query,hours,cursor]);
  useEffect(()=>{void refresh();if(!live)return;const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer)},[refresh,live]);
  useEffect(()=>{if(!selected?.requestId){setTrace([]);return}let cancelled=false;
    void controlPlaneFetch(endpoint,`/api/v1/admin/observability?${new URLSearchParams({requestId:selected.requestId,since:'1',limit:'500'})}`)
      .then(r=>{if(!r.ok)throw Error('Trace unavailable');return r.json()}).then(data=>{if(!cancelled)setTrace(data.events??[])}).catch(()=>{if(!cancelled)setTrace([])});
    return()=>{cancelled=true};
  },[endpoint,selected]);
  const customerName=(value:string)=>snapshot?.customers?.find(c=>`rental:${c.id}`===value)?.customer??value;
  const open=snapshot?.incidents.filter(i=>!i.resolvedAt)??[];
  const updateFilter=(setter:(value:string)=>void,value:string)=>{setter(value);setCursor(null)};
  const exportRows=()=>{
    if(!snapshot)return;const url=URL.createObjectURL(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),...snapshot},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='phonebase-activity-page.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const review=async(incident:Incident)=>{
    try{const response=await controlPlaneFetch(endpoint,'/api/v1/admin/observability/incidents/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:incident.key})});if(!response.ok)throw Error('Could not mark incident reviewed');await refresh();}catch(e){setError(String(e))}
  };
  return <div className="platform-view activity-view">
    <section className="platform-hero"><div><span className="platform-eyebrow">STATION OPERATIONS</span><h1>Activity & incidents</h1><p>Trace customer actions and spot device problems before a support request arrives.</p></div><div className="activity-toolbar"><label><input type="checkbox" checked={live} onChange={e=>setLive(e.target.checked)}/> Live updates</label><button type="button" onClick={()=>void refresh()} disabled={loading}>Refresh</button><button type="button" onClick={exportRows} disabled={!snapshot}>Export this page</button></div></section>
    {error&&<p role="alert" className="activity-error">{error} · Last successful data remains below.</p>}
    {!!snapshot?.storage.writeFailures&&<p role="alert" className="activity-error">Log storage reported {snapshot.storage.writeFailures} write failures. Some events may be missing.</p>}
    <div className="activity-metrics"><article><span>Open incidents</span><strong>{snapshot?open.length:'—'}</strong></article><article><span>Completed actions · 24h</span><strong>{snapshot?.metrics.completedActions??'—'}</strong></article><article><span>Failed actions · 24h</span><strong>{snapshot?.metrics.failedActions??'—'}</strong></article><article><span>Station processing · p95 / 24h</span><strong>{ms(snapshot?.gatewayP95Ms)}</strong></article></div>
    <section className="activity-section"><div className="activity-section-heading"><h2>Needs attention</h2><span>Checked automatically, even when this page is closed</span></div>
      {open.length?open.map(incident=><article className="activity-incident" key={incident.key}><div><span className="activity-severity" data-level={incident.level}>{incident.level}</span><strong>{incident.title}</strong><p>{incident.deviceId||'Station'} · First seen {time(incident.openedAt)} · Last observed {time(incident.updatedAt)}</p><details><summary>Diagnostic evidence</summary><pre>{JSON.stringify(incident.details,null,2)}</pre></details></div><button type="button" onClick={()=>void review(incident)}>Mark reviewed</button></article>):<p className="activity-empty">{snapshot?'No active incidents detected.':'Loading device health…'}</p>}
      <small>Controller completion confirms motion. Touch accuracy on an arbitrary app still needs visual evidence; alignment alerts are advisory. Persistent problems reopen after review.</small>
    </section>
    <section className="activity-section"><div className="activity-section-heading"><h2>Activity timeline</h2><span>{snapshot?.total??0} matching events · {snapshot?`Updated ${time(snapshot.updatedAt)}`:'Loading…'}</span></div>
      <div className="activity-filters">
        <label>Time range<select value={hours} onChange={e=>updateFilter(setHours,e.target.value)}><option value="1">Last hour</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option></select></label>
        <label>Source<select value={source} onChange={e=>updateFilter(setSource,e.target.value)}><option value="">All sources</option><option value="dashboard">Dashboard</option><option value="api">API</option><option value="mcp">MCP</option><option value="system">System</option></select></label>
        <label>Severity<select value={level} onChange={e=>updateFilter(setLevel,e.target.value)}><option value="">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select></label>
        <label>Customer<select value={actor} onChange={e=>updateFilter(setActor,e.target.value)}><option value="">All customers</option>{snapshot?.customers?.map(c=><option key={c.id} value={`rental:${c.id}`}>{c.customer||c.id}</option>)}</select></label>
        <label>Device<input placeholder="Device ID" value={device} onChange={e=>updateFilter(setDevice,e.target.value)}/></label>
        <label>Find an operation<input placeholder="Request ID, receipt, action, status" value={query} onChange={e=>updateFilter(setQuery,e.target.value)}/></label>
      </div>
      <div className="activity-table-scroll"><table className="activity-table"><thead><tr><th>Time</th><th>Customer / source</th><th>Device</th><th>Event</th><th>Result</th><th>Duration</th><th>Trace</th></tr></thead><tbody>{snapshot?.events.map(event=><tr key={event.id}><td>{time(event.at)}</td><td><strong>{customerName(event.actor)}</strong><small>{event.source}</small></td><td>{event.deviceId||'—'}</td><td>{event.kind}<small>{event.actionType}</small></td><td><span className="activity-severity" data-level={event.level}>{event.status||event.level}</span></td><td>{ms(event.durationMs)}</td><td><button type="button" onClick={()=>setSelected(event)} aria-label={`Inspect ${event.kind} event ${event.id}`}>Inspect</button></td></tr>)}</tbody></table></div>
      {snapshot&&!snapshot.events.length&&<p className="activity-empty">No events match these filters.</p>}
      <div className="activity-pagination"><button type="button" disabled={!cursor} onClick={()=>setCursor(null)}>Newest</button><button type="button" disabled={!snapshot?.nextCursor} onClick={()=>{setCursor(snapshot?.nextCursor??null);setLive(false)}}>Older events</button><small>Up to 100 per page. Retained for {snapshot?.storage.retentionDays??30} days, capped at {snapshot?.storage.maxEvents.toLocaleString()??'250,000'} events. Credentials, typed text and screen images are excluded.</small></div>
    </section>
    {selected&&<section className="activity-section activity-trace" aria-label="Operation trace"><div className="activity-section-heading"><h2>Operation trace</h2><button type="button" onClick={()=>setSelected(null)}>Close trace</button></div><p>Request <code>{selected.requestId||'—'}</code> · Receipt <code>{selected.receiptId||'—'}</code></p><ol>{[...trace].reverse().map(event=><li key={event.id}><strong>{event.kind}</strong> · {time(event.at)} · {ms(event.durationMs)}<details open={event.id===selected.id}><summary>Parameters and evidence</summary><pre>{JSON.stringify(event.details,null,2)}</pre></details></li>)}</ol>{!trace.length&&<pre>{JSON.stringify(selected.details,null,2)}</pre>}</section>}
  </div>;
}
