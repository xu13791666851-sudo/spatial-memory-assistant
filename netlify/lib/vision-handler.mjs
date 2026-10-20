import {appearanceText} from '../../web/memory.mjs';
import {serverReady} from './access.mjs';
import {observeFrame} from './realtime-vision.mjs';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function understand(request,connect,env=process.env){
 if(request.method!=='POST')return reply({detail:'请求方式不支持。'},405);
 if(request.headers.get('origin')!==new URL(request.url).origin)return reply({detail:'请从本网站观察。'},403);
 if(!serverReady(env))return reply({detail:'管理员尚未完成连接配置。'},503);
 let body;
 try{const raw=await request.text();if(raw.length>260000)return reply({detail:'当前画面过大，请重新观察。'},413);body=JSON.parse(raw);}catch{return reply({detail:'画面格式不正确。'},400);}
 const {image,goal='',task=null,request_id}=body||{};
 if(typeof image!=='string'||image.length>250000||image.length<8||!/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image)||typeof goal!=='string'||goal.length>400||typeof request_id!=='string'||! /^[A-Za-z0-9_-]{8,80}$/.test(request_id))return reply({detail:'这次没有获取到有效画面，请重新观察。'},400);
 if(task!==null&&(!task||typeof task!=='object'||typeof task.target!=='string'||!task.target.trim()||task.target.length>60||typeof task.remember!=='boolean'))return reply({detail:'找物或记录请求格式不正确。'},400);
 if(task?.reference_appearance!==undefined&&(typeof task.reference_appearance!=='string'||task.reference_appearance.length>150||/[\x00-\x1f]/.test(task.reference_appearance)))return reply({detail:'物品外观描述格式不正确。'},400);
 const safeTask=task?{target:task.target,remember:task.remember,reference_appearance:task.remember?'':appearanceText(task.reference_appearance)}:null;
 const workspace=env.DASHSCOPE_WORKSPACE_ID,region=env.DASHSCOPE_REGION||'beijing';
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(workspace)||!['beijing','singapore'].includes(region)||!/^sk-[\x21-\x7e]{17,509}$/.test(env.DASHSCOPE_API_KEY))return reply({detail:'请检查后台连接配置。'},400);
 try{
  const result=await observeFrame({image,goal,task:safeTask,env,signal:request.signal},connect);
  return reply({...result,request_id,observedAt:new Date().toISOString()});
 }catch(err){
  const code=typeof err.message==='string'&&/^observation_[a-z_]+$/.test(err.message)?err.message:'observation_invalid_result';
  const detail=code==='observation_no_image'?'这次没有确认模型收到画面，暂时不能描述。请重新观察。':code==='observation_timeout'?'这次画面理解等待超时，尚未确认物品位置。请重新观察。':'这次画面理解没有完成，暂时无法确认物品和位置。请重新观察。';
  return reply({detail,code},502);
 }
}
