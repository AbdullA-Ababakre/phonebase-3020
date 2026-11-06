import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {randomBytes} from 'node:crypto';
import type {PublishMedia} from './publishing-store';

// A short-lived transfer session for one observed phone, closed when the trial ends.
export async function openPublishingTransfer(media:PublishMedia,caption:string,host:string,phoneIp:string,port=3036){
  const token=randomBytes(24).toString('hex');const filename=`PB-${media.id.slice(0,8)}.mp4`;let downloaded=false,copied=false;
  const page=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:24px -apple-system;padding:24px;background:white;color:black}button,a{display:block;padding:20px;margin:24px 0;background:#175ce0;color:white;border:0;border-radius:10px;font:24px -apple-system;text-decoration:none}textarea{width:95%;height:120px;font:20px -apple-system}</style><h2>Phonebase Transfer</h2><p id="file"></p><a id="download">Download video</a><textarea id="caption" readonly></textarea><button id="copy">Copy caption</button><p id="status">Preparing</p><script>fetch('/session').then(r=>r.json()).then(s=>{document.querySelector('#file').textContent=s.filename;document.querySelector('#download').href=s.url;document.querySelector('#caption').value=s.caption;document.querySelector('#status').textContent='Ready';document.querySelector('#copy').onclick=()=>{document.querySelector('#caption').select();if(document.execCommand('copy')){document.querySelector('#copy').textContent='Caption copied';document.querySelector('#status').textContent='Caption copied';fetch('/copied',{method:'POST',headers:{'x-transfer-token':s.token}})}}});</script>`;
  const server=createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(req.socket.remoteAddress!==phoneIp){res.writeHead(403);res.end();return;}const path=new URL(req.url??'/','http://localhost').pathname;
    if(req.method==='GET'&&(path==='/'||path==='/touch-calibration')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(page);return;}
    if(req.method==='GET'&&path==='/session'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({filename,caption,url:'/video/'+token,token}));return;}
    if(req.method==='POST'&&path==='/copied'&&req.headers['x-transfer-token']===token){copied=true;res.writeHead(204);res.end();return;}
    if(req.method==='GET'&&path==='/video/'+token){const range=req.headers.range;const m=range?/^bytes=(\d+)-(\d*)$/.exec(range):null;const start=m?Number(m[1]):0,end=m&&m[2]?Math.min(Number(m[2]),media.bytes-1):media.bytes-1;
      if((range&&!m)||!Number.isSafeInteger(start)||start<0||start>end){res.writeHead(416,{'Content-Range':`bytes */${media.bytes}`});res.end();return;}
      res.writeHead(m?206:200,{'Content-Type':'video/mp4','Content-Disposition':`attachment; filename="${filename}"`,'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(m?{'Content-Range':`bytes ${start}-${end}/${media.bytes}`}:{})});const stream=createReadStream(media.path,{start,end});stream.on('error',()=>res.destroy());res.on('finish',()=>{if(start===0&&end===media.bytes-1)downloaded=true;});stream.pipe(res);return;}
    res.writeHead(404);res.end();});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve());});const timeout=setTimeout(()=>server.close(),20*60*1000);timeout.unref();
  return {filename,status:()=>({downloaded,copied}),close:()=>{clearTimeout(timeout);server.close();server.closeAllConnections();}};
}
