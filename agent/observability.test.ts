import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservabilityStore, safeDetails, actionDetails, requestIdentity } from './observability';

test('diagnostics redact secrets and typed text but preserve coordinate evidence',()=>{
 const details=JSON.stringify(safeDetails({token:'secret',nested:{password:'pass',accessCode:'pb-key',authorization:'Bearer hidden'},result:{machinePoint:{x:12,y:34}},text:'private',imageBase64:'pixels'}));
 for(const secret of ['secret','pass"','pb-key','Bearer hidden','private','pixels'])assert.equal(details.includes(secret),false);
 assert.ok(details.includes('machinePoint'));
 assert.deepEqual(actionDetails({type:'input_text',text:'secret input',password:'ignored'}),{type:'input_text',textLength:12});
 assert.deepEqual(actionDetails({type:'tap',point:{x:12,y:34},viewport:{width:720,height:1560},frameSequence:23}),{type:'tap',point:{x:12,y:34},viewport:{width:720,height:1560},frameSequence:23});
 assert.notEqual(requestIdentity('bad\r\nid'),'bad\r\nid');
});

test('persistent activity has exact filters, safe queries, stable cursor, and incident lifecycle',()=>{
 const dir=mkdtempSync(join(tmpdir(),'phonebase-observability-')); const path=join(dir,'events.sqlite');
 let store=new ObservabilityStore(path);
 try{
  store.record({kind:'action.accepted',actor:'rental:a',source:'mcp',deviceId:'arm-a',requestId:'trace-a',receiptId:'receipt-a'});
  store.record({kind:'action.completed',actor:'rental:a',source:'mcp',deviceId:'arm-a',requestId:'trace-a',receiptId:'receipt-a',durationMs:120});
  store.record({kind:'http.request',actor:'rental:b',source:'dashboard',deviceId:'arm-b',requestId:'trace-b',status:'403'});
  assert.equal(store.query(new URLSearchParams({requestId:'trace-a'})).events.length,2);
  assert.equal(store.query(new URLSearchParams({actor:"' OR 1=1 --"})).events.length,0);
  const first=store.query(new URLSearchParams({limit:'2'}));assert.equal(first.events.length,2);
  const next=store.query(new URLSearchParams({limit:'2',before:String(first.nextCursor)}));assert.equal(next.events.length,1);
  assert.ok(next.events.every(r=>Number(r.id)<Number(first.nextCursor)));
  store.flag('camera:arm-a',true,'Camera lost','arm-a');store.flag('camera:arm-a',true,'Camera lost','arm-a');
  assert.equal(store.summary().incidents.length,1);assert.equal(store.summary().incidents[0].occurrences,2);
  store.flag('camera:arm-a',false,'Camera restored','arm-a');assert.notEqual(store.summary().incidents[0].resolvedAt,null);
  store.close();store=new ObservabilityStore(path);
  assert.equal(store.query(new URLSearchParams({requestId:'trace-a'})).events.length,2);
  store.flag('camera:arm-a',true,'Camera lost','arm-a');assert.equal(store.summary().incidents[0].resolvedAt,null);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
