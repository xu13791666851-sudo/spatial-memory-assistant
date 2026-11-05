import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {memory,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
import {detectionLabel} from '../src/object-names.mjs';

// These are workflow checks with simulated observations, not recognition scores.
for(const target of ['钱包','耳机','药盒','钥匙','充电线','遥控器']) {
 test(`${target}: remember, query and find are not restricted to cups or YOLO classes`,async t=>{
  const m=memory(t),events=[];let descriptions=0,comparisons=0;
  const s=new Session({memory:m,emit:e=>events.push(e),providers:{singlePassMemory:true,
   describe:async(f,name)=>{descriptions++;assert.equal(name,target);return {v:true,d:'带红色贴纸的'+target,l:'笔记本电脑右侧',b:null};},
   review:async(f,options)=>{comparisons++;assert.equal(options.target,target);assert.equal(options.crop,null);assert.ok(options.references.length>0);return {decision:'UNCERTAIN'};}
  },detector:{ready:true,busy:false,run:async()=>({detections:[],candidates:[]})}});
  const command=text=>s.command({commandId:uuid(),text});
  s.start();s.frame(picture,s.source.generation,1,Date.now());
  await command('记住这个'+target);const id=m.all()[0].id;
  assert.equal(m.get(id).name,target);assert.equal(m.get(id).captures.length,1);
  await command(target+'上次在哪');assert.match(events.filter(e=>e.type==='reply').at(-1).message,/笔记本电脑右侧/);
  assert.equal(descriptions,1);assert.equal(comparisons,0);
  await command('现在帮我找'+target);await s.tick();await new Promise(r=>setImmediate(r));
  assert.equal(comparisons,1);assert.equal(s.task.objectId,id);assert.equal(s.state,'SEARCHING');
  assert.doesNotMatch(events.filter(e=>e.type==='reply').at(-1).message,/发现.*相符/);
  if(target!=='遥控器')assert.equal(detectionLabel(target),null);
 });
}
