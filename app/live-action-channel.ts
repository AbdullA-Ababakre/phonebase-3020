import type { ControlPlaneEndpoint } from './control-plane-endpoint';
type Sender = (body: string, requestId: string) => Promise<Response | null>;
const senders = new Map<string, Sender>();
const key = (endpoint:ControlPlaneEndpoint,deviceId:string)=>JSON.stringify([endpoint.baseUrl,endpoint.accessToken,deviceId]);
export function registerLiveActions(endpoint:ControlPlaneEndpoint,deviceId:string,sender:Sender) {
  const id=key(endpoint,deviceId);senders.set(id,sender);
  return ()=>{if(senders.get(id)===sender)senders.delete(id)};
}
export function tryLiveAction(endpoint:ControlPlaneEndpoint,deviceId:string,body:string,requestId:string) {
  return senders.get(key(endpoint,deviceId))?.(body,requestId)??Promise.resolve(null);
}
