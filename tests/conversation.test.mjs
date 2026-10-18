import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationStore} from '../web/conversation.mjs';
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),data};};
test('conversation sessions survive reload and contain only text fields',()=>{
 const s=storage(),store=new ConversationStore(s),id=store.start('home');
 store.put(id,{id:'1',role:'user',text:'帮我找杯子',at:new Date().toISOString(),complete:true});
 const restored=new ConversationStore(s);assert.equal(restored.get(id).messages[0].text,'帮我找杯子');
 assert.equal(restored.sessions.length,1);assert.equal(s.data.has('spatial-memory.records.v1'),false);
});
test('deleting a conversation never deletes object memory or other conversations',()=>{
 const s=storage();s.setItem('spatial-memory.records.v1','fixture');const store=new ConversationStore(s);
 const one=store.start('home'),two=store.start('explore');store.save();assert.equal(store.remove(one),true);
 assert.equal(new ConversationStore(s).get(two).place,'explore');assert.equal(s.getItem('spatial-memory.records.v1'),'fixture');
});
test('failed persistence is visible and failed deletion keeps the current transcript',()=>{
 let fail=false;const data=storage(),errors=[];const s={getItem:data.getItem,setItem:(...args)=>{if(fail)throw Error('quota');data.setItem(...args);}};
 const store=new ConversationStore(s,e=>errors.push(e)),id=store.start('home');store.put(id,{id:'m',role:'assistant',text:'记录',at:new Date().toISOString(),complete:true});
 fail=true;assert.equal(store.remove(id),false);assert.equal(store.get(id).messages.length,1);assert.equal(errors.length,1);
});
test('unreadable existing history is never overwritten',()=>{
 const s=storage();s.setItem('spatial-conversations.v1','broken');const errors=[],store=new ConversationStore(s,e=>errors.push(e));
 const id=store.start('home');assert.equal(store.put(id,{id:'new',text:'新消息',role:'user'}),false);
 assert.equal(s.getItem('spatial-conversations.v1'),'broken');assert.equal(errors.length,1);
});
