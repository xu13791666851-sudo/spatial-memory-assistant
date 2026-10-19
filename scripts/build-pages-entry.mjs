import fs from 'node:fs/promises';

await fs.mkdir('.pages-entry',{recursive:true});
await fs.copyFile('cloudflare/pages/worker.mjs','.pages-entry/_worker.js');
await fs.writeFile('.pages-entry/_routes.json',JSON.stringify({version:1,include:['/*'],exclude:[]}));
console.log('Pages entry ready; requests use the private service binding.');
