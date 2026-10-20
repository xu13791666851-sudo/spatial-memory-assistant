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
    for(const dir of ['src','web','designs','netlify'])await fs.symlink(path.join(root,dir),path.join(temp,dir));
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
