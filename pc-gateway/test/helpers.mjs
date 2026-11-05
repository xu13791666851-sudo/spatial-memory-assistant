import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Memory} from '../src/memory.mjs';
import {uuid} from '../src/util.mjs';
export const here=fileURLToPath(new URL('.',import.meta.url));
export const picture=readFileSync(new URL('fixtures/generated-cup.jpg',import.meta.url));
export function directory(){const base=resolve(here,'.runtime');mkdirSync(base,{recursive:true});return mkdtempSync(resolve(base,'case-'));}
export function memory(t){const value=new Memory(directory());t.after(()=>value.close());return value;}
export function frame(){return {jpeg:picture,frameId:1,sourceGeneration:uuid(),cameraSource:'PHONE',capturedAtMs:Date.now(),receivedAtMs:Date.now()};}
export const account='a05db5a0-0862-4aef-b040-44e2496e5354';
export function credentials(){const claims=Buffer.from(JSON.stringify({sub:account,role:'authenticated'})).toString('base64url');return {userId:account,accessToken:`eyJhbGciOiJIUzI1NiJ9.${claims}.example_signature_only`,refreshToken:'fake-refresh-only-for-local-tests-12345',expiresAtMs:Date.now()+3600000};}
export function fakeCloud(){const objects=new Map();const calls=[];return {objects,calls,fetcher:async(url,options)=>{calls.push({path:new URL(url).pathname,method:options.method});const p=new URL(url).pathname;if(!options.headers.Authorization)return Response.json({error:'unauthorized'},{status:403});if(p.includes('/object/list/')){const prefix=JSON.parse(options.body).prefix;return Response.json([...objects.keys()].filter(x=>x.includes(prefix)).map(x=>({name:x.split('/').at(-1)})));}const key=p.replace('/storage/v1/object/authenticated/','/storage/v1/object/');if(options.method==='POST'){if(objects.has(key))return Response.json({error:'exists'},{status:409});objects.set(key,Buffer.from(options.body));return Response.json({ok:true});}return objects.has(key)?new Response(objects.get(key),{headers:{'Content-Type':'application/zip'}}):Response.json({error:'not_found'},{status:404});}};}
