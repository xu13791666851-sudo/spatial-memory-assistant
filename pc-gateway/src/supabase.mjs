import {check,hash,uuid,MAX_ARCHIVE} from './util.mjs';
import {exportArchive,readArchive} from './archive.mjs';
const ROOT='https://i-see-you-android-core-test.pages.dev/api/android/backup/';
const KEY='sb_publishable_fWXqw7l-psI5pqwbY3zQlA_-Z7D74Yp',BUCKET='iseeyou-memory-backups';
export class SupabaseMemory {
 constructor(memory,{fetcher=fetch,sessionChanged=()=>{},now=Date.now,root=ROOT}={}){Object.assign(this,{memory,fetcher,sessionChanged,now,root,credentials:null,lastDigest:null,lastSuccess:0,pending:null,serial:Promise.resolve()});check(root===ROOT||new URL(root).hostname==='127.0.0.1','invalid_backup_endpoint');}
 setSession(value){check(value&&/^[a-f0-9-]{36}$/.test(value.userId)&&typeof value.accessToken==='string'&&value.accessToken.length<=16000&&typeof value.refreshToken==='string'&&value.refreshToken.length<=16000&&Number.isSafeInteger(value.expiresAtMs),'invalid_session');this.memory.bindAccount(value.userId);this.credentials={...value};}
 clear(){clearTimeout(this.pending);this.credentials=null;this.lastDigest=null;}
 async request(path,{body,token,bytes=false}={}){
  const r=await this.fetcher(this.root+path,{method:body===undefined?'GET':'POST',headers:{apikey:KEY,...(token?{Authorization:`Bearer ${token}`} :{}),...(body===undefined?{}:{'Content-Type':Buffer.isBuffer(body)?'application/zip':'application/json'}),...(Buffer.isBuffer(body)?{'x-upsert':'false'}:{})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(60000)});
  if(!r.ok){await r.body?.cancel();throw Error(`backup_http_${r.status}`);}const length=Number(r.headers.get('content-length')||0);check(length<=MAX_ARCHIVE,'backup_size');
  const chunks=[];let size=0;for await(const part of r.body){size+=part.length;check(size<=MAX_ARCHIVE,'backup_size');chunks.push(part);}const raw=Buffer.concat(chunks);return bytes?raw:raw.length?JSON.parse(raw.toString('utf8')):{};
 }
 async session(){check(this.credentials,'backup_login_required');if(this.credentials.expiresAtMs>this.now()+60000)return this.credentials;
  const old=this.credentials;const r=await this.request('auth/v1/token?grant_type=refresh_token',{body:{refresh_token:old.refreshToken}});check(r.user?.id===old.userId&&typeof r.access_token==='string'&&typeof r.refresh_token==='string'&&Number.isSafeInteger(r.expires_in)&&r.expires_in>0,'backup_refresh_invalid');
  const updated={userId:r.user.id,accessToken:r.access_token,refreshToken:r.refresh_token,expiresAtMs:this.now()+r.expires_in*1000};this.setSession(updated);await this.sessionChanged(updated);return updated;
 }
 exclusive(fn){const task=this.serial.then(fn);this.serial=task.catch(()=>{});return task;}
 backup(){return this.exclusive(async()=>{const s=await this.session();const snapshot=await exportArchive(this.memory,s.userId);if(!snapshot.objectCount)return {objectCount:0};if(snapshot.digest===this.lastDigest)return {objectCount:snapshot.objectCount,unchanged:true};const name=`${this.now()}-${uuid()}.zip`,path=`${BUCKET}/${s.userId}/${name}`;
  await this.request(`storage/v1/object/${path}`,{token:s.accessToken,body:snapshot.bytes});const downloaded=await this.request(`storage/v1/object/authenticated/${path}`,{token:s.accessToken,bytes:true});check(hash(downloaded)===hash(snapshot.bytes),'backup_integrity_failed');this.lastDigest=snapshot.digest;this.lastSuccess=this.now();return {name,objectCount:snapshot.objectCount,sha256:hash(downloaded)};});}
 restore(){return this.exclusive(async()=>{const s=await this.session();const list=await this.request(`storage/v1/object/list/${BUCKET}`,{token:s.accessToken,body:{prefix:s.userId+'/',limit:10,offset:0,sortBy:{column:'name',order:'desc'}}});check(Array.isArray(list)&&list.length<=10,'backup_list_invalid');const latest=list.filter(x=>/^[0-9]{13}-[a-f0-9-]{36}\.zip$/.test(x.name)).sort((a,b)=>b.name.localeCompare(a.name))[0];if(!latest)return {restored:0,kept:0,empty:true};const bytes=await this.request(`storage/v1/object/authenticated/${BUCKET}/${s.userId}/${latest.name}`,{token:s.accessToken,bytes:true});const archive=await readArchive(bytes,s.userId);return this.memory.importObjects(archive.objects,archive.files);});}
 schedule(){clearTimeout(this.pending);if(!this.credentials)return;this.pending=setTimeout(()=>{void this.backup().catch(()=>{});},1800);this.pending.unref();}
}
