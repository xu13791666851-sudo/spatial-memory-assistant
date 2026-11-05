// Fixed-project Auth + immutable private snapshots. No admin/service-role key.
const root='https://awkzcvvzrsfjvqlloqqi.supabase.co/';
const publicKey='sb_publishable_fWXqw7l-psI5pqwbY3zQlA_-Z7D74Yp';
const bucket='iseeyou-memory-backups',prefix='/api/android/backup/',max=40*1024*1024;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const objectPath=new RegExp(`^storage/v1/object/(?:authenticated/|public/)?${bucket}/${uuid}/[0-9]{13}-${uuid}\\.zip$`);
const json=(value,status)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function bounded(request,limit){
 const reader=request.body?.getReader();if(!reader)return '';
 const chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new RangeError('body_limit');chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function userToken(value){
 if(!value?.startsWith('Bearer ')||value.length>16020)return null;
 const token=value.slice(7),parts=token.split('.');if(parts.length!==3||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))return null;
 try{const body=JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));if(body.role!=='authenticated'||!new RegExp(`^${uuid}$`).test(body.sub))return null;}catch{return null;}
 // Supabase verifies signature/expiry and applies RLS. Claims here only restrict
 // this relay's supported request shapes and exclude elevated role credentials.
 return value;
}
export async function backupRelay(request,env,fetcher){
 const url=new URL(request.url),path=url.pathname.slice(prefix.length),method=request.method;
 const settings=path==='auth/v1/settings'&&method==='GET';
 const auth=['auth/v1/otp','auth/v1/verify','auth/v1/token'].includes(path)&&method==='POST';
 const list=path===`storage/v1/object/list/${bucket}`&&method==='POST';
 const object=objectPath.test(path),upload=object&&method==='POST'&&!path.includes('/authenticated/')&&!path.includes('/public/');
 const download=object&&method==='GET'&&(path.includes('/authenticated/')||path.includes('/public/'));
 if(!settings&&!auth&&!list&&!upload&&!download)return json({detail:'不支持的备份操作'},404);
 if(url.search&&!(path==='auth/v1/token'&&url.searchParams.size===1&&url.searchParams.get('grant_type')==='refresh_token'))return json({detail:'备份参数无效'},400);
 if(path==='auth/v1/token'&&url.searchParams.get('grant_type')!=='refresh_token')return json({detail:'备份参数无效'},400);
 const authorization=userToken(request.headers.get('Authorization'));
 if((list||upload||(download&&!path.includes('/public/')))&&!authorization)return json({detail:'请先登录备份'},401);
 if(!env.IMAGE_LIMITER||!(await env.IMAGE_LIMITER.limit({key:'backup:'+(request.headers.get('CF-Connecting-IP')||'unknown')})).success)return json({detail:'备份请求较频繁'},429);
 const headers=new Headers({'apikey':publicKey,'Accept':'application/json'});
 if(authorization)headers.set('Authorization',authorization);
 let body;
 try{
  if(upload){
   const length=Number(request.headers.get('Content-Length')||0);
   if(!request.body||length>max||request.headers.get('Content-Type')!=='application/zip')return json({detail:'备份文件大小或格式无效'},413);
   headers.set('Content-Type','application/zip');headers.set('x-upsert','false');let bytes=0;
   body=request.body.pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>max)throw new RangeError('body_limit');controller.enqueue(chunk);}}));
  }else if(method==='POST'){
   const value=JSON.parse(await bounded(request,32*1024));
   if(list){
    if(typeof value.prefix!=='string'||!new RegExp(`^${uuid}/$`).test(value.prefix))return json({detail:'备份目录无效'},400);
    body=JSON.stringify({prefix:value.prefix,limit:10,offset:0,sortBy:{column:'name',order:'desc'}});
   }else if(path.endsWith('/otp')){
    if(typeof value.email!=='string'||value.email.length>254||!/^\S+@\S+\.\S+$/.test(value.email))return json({detail:'邮箱格式无效'},400);
    body=JSON.stringify({email:value.email,create_user:true});
   }else if(path.endsWith('/verify')){
    if(!['email','signup','magiclink'].includes(value.type))return json({detail:'登录方式无效'},400);
    if(typeof value.token_hash==='string'&&/^[A-Za-z0-9_-]{20,256}$/.test(value.token_hash))body=JSON.stringify({token_hash:value.token_hash,type:value.type});
    else if(typeof value.email==='string'&&value.email.length<=254&&typeof value.token==='string'&&/^[0-9]{6,10}$/.test(value.token))body=JSON.stringify({email:value.email,token:value.token,type:value.type});
    else return json({detail:'登录信息无效'},400);
   }else{
    if(typeof value.refresh_token!=='string'||value.refresh_token.length<10||value.refresh_token.length>16000)return json({detail:'登录信息无效'},400);
    body=JSON.stringify({refresh_token:value.refresh_token});
   }
   headers.set('Content-Type','application/json');
  }
  const upstream=await fetcher(new URL(path+url.search,root).href,{method,headers,body,redirect:'manual',signal:AbortSignal.timeout(60000)});
  if(upstream.status>=300&&upstream.status<400){await upstream.body?.cancel();return json({detail:'备份地址发生跳转，本次已停止'},502);}
  return new Response(upstream.body,{status:upstream.status,headers:{'Content-Type':upstream.headers.get('Content-Type')||'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }catch(error){return json({detail:'备份服务暂未完成，本地记忆仍保留'},error instanceof RangeError?413:503);}
}
