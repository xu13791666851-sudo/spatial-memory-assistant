import test from 'node:test';
import assert from 'node:assert/strict';
import {containedBox,rememberedTarget,overlayCurrent,motionChanged} from '../web/target-overlay.mjs';

const record={object_id:'cup-1',name:'绿色水杯',recorded_at:'2026-10-20T01:00:00Z',appearance:'绿色杯身，有把手'};
const task={target:'绿色水杯',allowHistory:true,reference_appearance:record.appearance};
const signature={whole:[100,120,100],target:[80,150,90]};
test('boxes match contain letterboxing for landscape and portrait cameras',()=>{
 assert.deepEqual(containedBox([0.25,0.25,0.75,0.75],400,400,1600,800),{left:100,top:150,width:200,height:100});
 assert.deepEqual(containedBox([0,0,1,1],400,200,800,1600),{left:150,top:0,width:100,height:200});
 assert.equal(containedBox([0,0,1,1],0,400,800,600),null);
 assert.equal(containedBox([0.8,0,0.2,1],400,400,800,600),null);
});
test('only a unique saved record actually loaded for this finding task can be boxed',()=>{
 assert.equal(rememberedTarget([record],task).id,'cup-1');
 for(const records of [[],[record,record]])assert.equal(rememberedTarget(records,task),null);
 for(const patch of [{allowHistory:false},{saveToken:'save'},{identify:true},{reference_appearance:'蓝色杯身'}])assert.equal(rememberedTarget([record],{...task,...patch}),null);
 const manual={...record,appearance:''};assert.ok(rememberedTarget([manual],{...task,reference_appearance:''}));
});
test('stopped, stale, switched, renamed, edited or deleted memories invalidate the old box',()=>{
 const snapshot={target:task.target,record:rememberedTarget([record],task),capturedAt:1000,fingerprint:signature};
 const options={target:task.target,record,now:2000};assert.equal(overlayCurrent(snapshot,options),true);
 for(const patch of [{active:false},{now:9001},{now:999},{target:'钥匙'},{record:null},{record:{...record,object_id:'other'}},{record:{...record,appearance:'蓝色'}},{record:{...record,recorded_at:'later'}}])assert.equal(overlayCurrent(snapshot,{...options,...patch}),false);
});
test('camera movement or target movement hides the box while small compression noise is tolerated',()=>{
 assert.equal(motionChanged(signature,{whole:[103,122,97],target:[81,153,89]}),false);
 assert.equal(motionChanged(signature,{whole:[200,20,200],target:signature.target}),true);
 assert.equal(motionChanged(signature,{whole:signature.whole,target:[200,10,200]}),true);
 assert.equal(motionChanged(signature,null),true);
});
