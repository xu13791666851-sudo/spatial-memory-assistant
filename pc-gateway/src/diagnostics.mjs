import {appendFileSync,existsSync,statSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
export function diagnosticLog(root) {
 const file=resolve(root,'diagnostics.jsonl');
 return event=>{
  if(event.type!=='diagnostic')return;
  const row={at:new Date().toISOString()};
  for(const k of ['operation','code'])if(/^[A-Za-z0-9_]{1,80}$/.test(event[k]??''))row[k]=event[k];
  for(const k of ['serial','frameId','durationMs'])if(Number.isSafeInteger(event[k])&&event[k]>=0)row[k]=event[k];
  try{
   if(existsSync(file)&&statSync(file).size>512*1024)renameSync(file,file+'.previous');
   appendFileSync(file,JSON.stringify(row)+'\n',{mode:0o600});
  }catch{/* Diagnostics must not interrupt capture or memory persistence. */}
 };
}
