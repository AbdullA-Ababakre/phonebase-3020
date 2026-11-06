import assert from 'node:assert/strict';
import test from 'node:test';
import { registerLiveActions, tryLiveAction } from '../app/live-action-channel';

test('live actions preserve the exact retry envelope and isolate endpoint, credential, and device',async()=>{
 const endpoint={baseUrl:'https://station.example',accessToken:'customer-a',remote:true};
 const body=JSON.stringify({idempotencyKey:'step-1',action:{type:'tap',point:{x:4,y:5}}});
 assert.equal(await tryLiveAction(endpoint,'arm-a',body,'request-1'),null);
 const remove=registerLiveActions(endpoint,'arm-a',async(sent,id)=>{assert.equal(sent,body);assert.equal(id,'request-1');return new Response('{"ok":true}',{status:202})});
 try{
  assert.equal((await tryLiveAction(endpoint,'arm-a',body,'request-1'))?.status,202);
  assert.equal(await tryLiveAction({...endpoint,accessToken:'customer-b'},'arm-a',body,'request-1'),null);
  assert.equal(await tryLiveAction(endpoint,'arm-b',body,'request-1'),null);
  const newer=registerLiveActions(endpoint,'arm-a',async()=>new Response('{}',{status:200}));
  remove();assert.equal((await tryLiveAction(endpoint,'arm-a',body,'request-1'))?.status,200);newer();
 }finally{remove()}
 assert.equal(await tryLiveAction(endpoint,'arm-a',body,'request-1'),null);
});
