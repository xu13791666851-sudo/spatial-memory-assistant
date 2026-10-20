// Full generated-page startup with fake media/RTC and local API fixtures.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});try{
const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 window.mediaRequests=[];const media=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=constraints=>{window.mediaRequests.push(constraints);return media(constraints);};
 window.sent=[];window.RTCPeerConnection=class{
  constructor(){this.connectionState='new';this.iceGatheringState='complete';}
  addTransceiver(kind){let bytes=0;return {sender:{replaceTrack:async()=>{},getStats:async()=>new Map([['audio',{type:'outbound-rtp',kind:'audio',bytesSent:bytes+=100}]]),getParameters:()=>({})}};}
  createDataChannel(){const emit=e=>setTimeout(()=>this.channel.onmessage?.({data:JSON.stringify(e)}),10);this.channel={readyState:'open',close(){},send:raw=>{const e=JSON.parse(raw);window.sent.push(e);if(e.type==='session.update')emit({type:'session.updated'});if(e.type==='response.create'){emit({type:'response.created',response:{id:'r'+window.sent.length}});emit({type:'response.text.done',item_id:'i'+window.sent.length,text:'可以，我在听。'});emit({type:'response.done',response:{output:[]}});}}};return this.channel;}
  async createOffer(){return {type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};}
  async setLocalDescription(d){this.localDescription=d;}
  async setRemoteDescription(){this.connectionState='connected';this.channel.onmessage({data:JSON.stringify({type:'session.created'})});}
  close(){this.connectionState='closed';}
 };
});

let vision=0;
await page.route('**/*',async route=>{
 const u=new URL(route.request().url());if(u.hostname!=='ui.test')return route.abort();
 if(u.pathname==='/api/access')return route.fulfill({json:{configured:true,authenticated:true}});
 if(u.pathname==='/api/realtime/sdp')return route.fulfill({body:'v=0\r\n'});
 if(u.pathname==='/api/vision'){
  const request=route.request().postDataJSON();vision++;assert.equal(request.task.remember,true);
  assert.equal(request.task.identify,vision<3?true:undefined);assert.equal(request.task.target,vision<3?'所指物品':'紫色拉链收纳袋');
  if(vision===2)assert.match(request.goal,/带拉链的那个/);
  return route.fulfill({json:{request_id:request.request_id,frame_received:true,frame_status:'clear',answer:vision===1?'画面中有多个物品，请指定一个。':'紫色拉链收纳袋在木桌上。',objects:[{name:'紫色拉链收纳袋',position:'右侧'},{name:'木桌',position:'下方'}],target_visible:vision>1,memory_candidate:{unique:vision>1,location_supported:vision>1,name:'紫色拉链收纳袋',selection_basis:vision>1?'user_description':'ambiguous',anchor:'木桌',location:vision===3?'木桌另一端，台灯旁':'木桌上，键盘右侧',appearance:'紫色长方形布袋，上方有拉链'}}});
 }
 let body=await fs.readFile(path.join(process.cwd(),'dist',u.pathname==='/'?'index.html':u.pathname),'utf8');
 if(u.pathname==='/static/app.js')body+='\nwindow.genericTest={runtime,sendText,bridge:()=>socket};';
 return route.fulfill({body,contentType:u.pathname.endsWith('.svg')?'image/svg+xml':u.pathname.endsWith('.css')?'text/css':/\.(js|mjs)$/.test(u.pathname)?'text/javascript':'text/html'});
});
await page.goto('https://ui.test/');await page.waitForFunction(()=>window.genericTest);
await page.evaluate(()=>{document.getElementById('screen-reader-mode').checked=true;const r=window.genericTest.runtime;r.setPlace('home');r.memory.remember('记住，旧物品放在柜子里');});
await page.getByRole('button',{name:'开启摄像头和语音对话',exact:true}).click();await page.waitForFunction(()=>window.genericTest.bridge()?.configured);await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('你好，我是小忆'));
await page.evaluate(()=>window.genericTest.sendText('旧物品在哪里'));
const before=await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1'));
await page.evaluate(()=>window.genericTest.sendText('帮我记住这个物品'));
await page.waitForFunction(()=>document.getElementById('latest-answer').textContent.includes('尚未唯一确定'));
assert.equal(await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1')),before);
await page.evaluate(()=>window.genericTest.sendText('带拉链的那个'));
await page.waitForFunction(()=>window.genericTest.runtime.memory.get('紫色拉链收纳袋'));
assert.equal(await page.evaluate(()=>window.genericTest.runtime.memory.all().length),2);assert.equal(await page.evaluate(()=>window.genericTest.runtime.memory.get('旧物品').location),'柜子里');
assert.match(await page.locator('#latest-answer').innerText(),/已记住：紫色拉链收纳袋/);
await page.evaluate(()=>window.genericTest.sendText('它在哪里'));assert.match(await page.locator('#latest-answer').innerText(),/紫色拉链收纳袋在木桌上，键盘右侧/);assert.equal(vision,2);
const id=await page.evaluate(()=>window.genericTest.runtime.memory.get('紫色拉链收纳袋').object_id);
await page.evaluate(()=>window.genericTest.sendText('重新记住它的位置'));
await page.waitForFunction(()=>window.genericTest.runtime.memory.get('紫色拉链收纳袋').location==='木桌另一端，台灯旁');
assert.equal(await page.evaluate(()=>window.genericTest.runtime.memory.get('紫色拉链收纳袋').object_id),id);
await page.click('#end-conversation');await page.reload();await page.waitForFunction(()=>window.genericTest);await page.selectOption('#place-mode','home');
await page.evaluate(()=>window.genericTest.sendText('紫色拉链收纳袋在哪'));assert.match(await page.locator('#chat .chat-turn').last().innerText(),/木桌另一端，台灯旁/);assert.equal(vision,3);assert.deepEqual(errors,[]);
console.log('PASS generic memory: unnamed object, ambiguity and descriptive selection, preserved previous item, identified name, location update and reload recall');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
