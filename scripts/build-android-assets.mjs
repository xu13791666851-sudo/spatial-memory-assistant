import fs from 'node:fs/promises';
import crypto from 'node:crypto';
// The UI is native. Restore only the original model, never old WebView assets.
const dest='android/app/src/main/assets';
await fs.mkdir(dest,{recursive:true});
const manifest=JSON.parse(await fs.readFile('models/yolo/manifest.json','utf8'));
const model=Buffer.concat(await Promise.all(manifest.parts.map(p=>fs.readFile('models/yolo/'+p.file))));
if(crypto.createHash('sha256').update(model).digest('hex')!==manifest.sha256)throw Error('Wrong model');
await fs.writeFile(dest+'/exp.tflite',model);
console.log('Original Android YOLO model verified. Native UI; no web assets or credentials bundled.');
