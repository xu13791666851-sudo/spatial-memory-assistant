import WebSocket from 'ws';
import {understand} from '../lib/vision-handler.mjs';
export {understand};
export function connectNode(url,{headers,onMessage,onError,onClose}){
 const ws=new WebSocket(url,{headers,followRedirects:false,handshakeTimeout:10000,maxPayload:100000});
 ws.on('message',data=>onMessage(data.toString()));ws.on('error',onError);ws.on('close',onClose);
 return {send:raw=>ws.send(raw),close:()=>{if(ws.readyState===WebSocket.OPEN)ws.close();else if(ws.readyState!==WebSocket.CLOSED)ws.terminate();}};
}
export default request=>understand(request,connectNode);
export const config={path:'/api/vision',method:'POST',rateLimit:{windowLimit:10,windowSize:60,aggregateBy:['ip','domain']}};
