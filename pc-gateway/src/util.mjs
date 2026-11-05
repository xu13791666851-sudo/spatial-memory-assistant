import {createHash,randomUUID} from 'node:crypto';
import {openSync,writeFileSync,fsyncSync,closeSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
export const MAX_ARCHIVE=40*1024*1024, MAX_IMAGE=2_000_000;
export const uuid=()=>randomUUID();
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function check(value,reason='invalid_input'){if(!value)throw Error(reason);return value;}
export function id(value){return check(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value),'invalid_id')&&value;}
export function text(value,max=600,empty=true){check(typeof value==='string'&&value.length<=max&&(empty||value.trim()),'invalid_text');return value.trim();}
export function time(value){check(Number.isSafeInteger(value)&&value>=0,'invalid_time');return value;}
export function jpeg(bytes){check(Buffer.isBuffer(bytes)&&bytes.length>=4&&bytes.length<=MAX_IMAGE&&bytes.readUInt16BE(0)===0xffd8&&bytes.readUInt16BE(bytes.length-2)===0xffd9,'invalid_jpeg');return bytes;}
export function writeNew(path,bytes){mkdirSync(dirname(path),{recursive:true});const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
// Android org.json quotes forward slashes. The v1/v2 digest is of that exact JSON.
export function compact(value){return JSON.stringify(value).replace(/\//g,'\\/');}
export function safeError(error){if(error?.name==='TimeoutError')return 'provider_timeout';if(error?.name==='AbortError')return 'operation_cancelled';return /^[A-Z_a-z0-9]{1,80}$/.test(error?.message||'')?error.message:'operation_failed';}
