import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const source=process.argv[2];
if(!source)throw Error('Usage: node scripts/import-yolo-model.mjs <handoff models directory>');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=await fs.readFile(path.join(source,'exp.tflite'));
const expected='9db0427fb26b590b6293b28da6071f3f62bdaa188a2c08cfe9e09af5032ee6b4';
if(hash(bytes)!==expected)throw Error('Model differs from the supplied handoff checksum');
await fs.mkdir('models/yolo',{recursive:true});
const parts=[];
for(let offset=0;offset<bytes.length;offset+=8*1024*1024){
 const chunk=bytes.subarray(offset,offset+8*1024*1024),sha256=hash(chunk);
 const file=`model-${parts.length}-${sha256.slice(0,16)}.bin`;
 await fs.writeFile('models/yolo/'+file,chunk);parts.push({file,bytes:chunk.length,sha256});
}
for(const [from,to] of [['yolo_labels.json','labels.json'],['target_aliases.json','aliases.json']])await fs.copyFile(path.join(source,from),'models/yolo/'+to);
await fs.writeFile('models/yolo/manifest.json',JSON.stringify({format:'tflite',sha256:expected,bytes:bytes.length,parts},null,2)+'\n');
console.log(`Imported the verified model (${bytes.length} bytes) in ${parts.length} hosting-safe parts; no app credentials copied.`);
