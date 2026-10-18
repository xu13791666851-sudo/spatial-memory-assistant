import {request as httpsRequest} from 'node:https';

// Connection setup is a small, infrequent POST. Use an independent IPv4 TLS
// connection instead of a warm function's pooled socket. Do not follow redirects.
export function freshSdp(url,options={},requestImpl=httpsRequest){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);
    if(target.protocol!=='https:'||target.username||target.password){reject(new TypeError('Invalid connection target'));return;}
    let phase='dns',settled=false;
    const fail=error=>{if(settled)return;settled=true;error.connectionPhase=phase;reject(error);};
    const body=String(options.body||'');
    const req=requestImpl(target,{method:'POST',agent:false,family:4,signal:options.signal,
      headers:{...options.headers,Connection:'close','Content-Length':String(Buffer.byteLength(body))}},res=>{
      phase='body';const chunks=[];let length=0;
      res.on('data',chunk=>{
        length+=chunk.length;
        if(length>160000){const error=new Error('Connection answer too large');error.code='RESPONSE_TOO_LARGE';fail(error);res.destroy();req.destroy();return;}
        chunks.push(Buffer.from(chunk));
      });
      res.once('error',fail);
      res.once('aborted',()=>{const error=new Error('Connection answer interrupted');error.code='ECONNRESET';fail(error);});
      res.once('end',()=>{
        if(settled)return;
        settled=true;
        const status=res.statusCode||502;
        resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:{'Content-Type':String(res.headers['content-type']||'application/sdp')}}));
      });
    });
    req.once('socket',socket=>{
      socket.once('lookup',()=>{phase='tcp';});socket.once('connect',()=>{phase='tls';});socket.once('secureConnect',()=>{phase='response';});
    });
    req.once('error',fail);req.end(body);
  });
}
