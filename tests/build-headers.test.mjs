import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Netlify build replaces cached Cloudflare headers with the current preview policy',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'spatial-headers-'));
  try{
    for(const dir of ['src','web','designs','netlify','models','node_modules'])await fs.symlink(path.join(root,dir),path.join(temp,dir),process.platform==='win32'?'junction':'dir');
    await fs.copyFile(path.join(root,'netlify.toml'),path.join(temp,'netlify.toml'));
    await fs.mkdir(path.join(temp,'dist'));await fs.writeFile(path.join(temp,'dist/_headers'),"/*\n  Content-Security-Policy: connect-src 'self'\n");
    execFileSync(process.execPath,[path.join(root,'scripts/build-netlify.mjs')],{cwd:temp});
    const headers=await fs.readFile(path.join(temp,'dist/_headers'),'utf8');
    assert.match(headers,/connect-src 'self' wss:\/\/spatial-memory-vision-preview\.xu13791666851\.workers\.dev;/);
    assert.equal((headers.match(/Content-Security-Policy:/g)||[]).length,1);
    assert.match(headers,/Permissions-Policy: camera=\(self\), microphone=\(self\), geolocation=\(\)/);
    assert.match(headers,/Cache-Control: no-store/);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('preview document middleware updates only the stream connection directive and only on the preview host',async()=>{
  const {default:handle}=await import('../netlify/edge-functions/vision-preview-headers.js');
  const csp="default-src 'self'; connect-src 'self'; frame-ancestors 'none'; script-src 'self'";
  const next=async()=>new Response('<html>test</html>',{headers:{'Content-Type':'text/html','Content-Security-Policy':csp,'Cache-Control':'no-store'}});
  const preview=await handle(new Request('https://deploy-preview-8--spatial-memory-xuziyi.netlify.app/video/'),{next});
  assert.equal(preview.headers.get('Content-Security-Policy'),csp.replace("connect-src 'self'","connect-src 'self' wss://spatial-memory-vision-preview.xu13791666851.workers.dev"));
  assert.equal(await preview.text(),'<html>test</html>');assert.equal(preview.headers.get('Cache-Control'),'no-store');
  const production=await handle(new Request('https://spatial-memory-xuziyi.netlify.app/video/'),{next});assert.equal(production.headers.get('Content-Security-Policy'),csp);
});

test('only the authorized preview uses the isolated stream gateway; production starts with HTTP observation',async()=>{
 const {visionStreamUrlFor,PREVIEW_VISION_STREAM_URL}=await import('../web/vision-stream-config.mjs');
 assert.equal(visionStreamUrlFor('https://deploy-preview-8--spatial-memory-xuziyi.netlify.app'),PREVIEW_VISION_STREAM_URL);
 for(const origin of ['https://i-see-you-spatial-memory.pages.dev','https://spatial-memory-xuziyi.netlify.app','https://i-see-you-spatial-memory.xu13791666851.workers.dev','https://deploy-preview-8--spatial-memory-xuziyi.netlify.app.evil.test',undefined])assert.equal(visionStreamUrlFor(origin),'');
});
