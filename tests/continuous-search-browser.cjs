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

let vision=0,inflight=0,maxInflight=0;const images=[];
await page.route('**/*',async route=>{
 const u=new URL(route.request().url());if(u.hostname!=='ui.test')return route.abort();
 if(u.pathname==='/static/vision-stream-config.mjs')return route.fulfill({body:"export const VISION_STREAM_URL='';",contentType:'text/javascript'});
 if(u.pathname==='/api/access')return route.fulfill({json:{configured:true,authenticated:true}});
 if(u.pathname==='/api/realtime/sdp')return route.fulfill({body:'v=0\r\n'});
 if(u.pathname==='/api/vision'){
  const request=route.request().postDataJSON();vision++;images.push(request.image);inflight++;maxInflight=Math.max(maxInflight,inflight);
  assert.equal(request.task.target,'绿色水杯');assert.equal(request.task.remember,false);assert.equal(request.task.reference_appearance,'绿色杯身，有白色杯盖');
  await new Promise(resolve=>setTimeout(resolve,300));inflight--;
  return route.fulfill({json:{request_id:request.request_id,frame_received:true,frame_status:'clear',answer:vision===1?'画面中没有看到绿色水杯。':'绿色水杯在木桌上，电脑左侧。',objects:[{name:'木桌',position:'画面下方'}],target_visible:vision>1,appearance_match:vision>1?{status:'match',unique:true,reason:'绿色杯身和白色杯盖与记录一致'}:null}});
 }
 let body=await fs.readFile(path.join(process.cwd(),'dist',u.pathname==='/'?'index.html':u.pathname),'utf8');
 if(u.pathname==='/static/app.js')body+='\nwindow.searchTest={runtime,sendText,bridge:()=>socket};';
 return route.fulfill({body,contentType:u.pathname.endsWith('.svg')?'image/svg+xml':u.pathname.endsWith('.css')?'text/css':/\.(js|mjs)$/.test(u.pathname)?'text/javascript':'text/html'});
});
await page.goto('https://ui.test/');await page.waitForFunction(()=>window.searchTest);
await page.evaluate(()=>{document.getElementById('screen-reader-mode').checked=true;const r=window.searchTest.runtime;r.setPlace('home');r.memory.saveVisual('绿色水杯',{unique:true,location_supported:true,anchor:'木桌',location:'木桌上，电脑左侧',appearance:'绿色杯身，有白色杯盖'},new Date().toISOString());});
await page.getByRole('button',{name:'开启摄像头和语音对话',exact:true}).click();await page.waitForFunction(()=>window.searchTest.bridge()?.configured);
await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('你好，我是小忆'));
const before=await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1'));
await page.evaluate(()=>window.searchTest.sendText('绿色水杯上次放在哪里'));assert.equal(vision,0);assert.match(await page.locator('#latest-answer').innerText(),/木桌上/);
await page.evaluate(()=>window.searchTest.sendText('帮我找绿色水杯'));
await page.getByRole('button',{name:'暂停寻找',exact:true}).waitFor({state:'visible',timeout:5000});
await page.waitForFunction(()=>window.searchTest.runtime.taskState().search.state==='confirming',{},{timeout:30000});
assert.equal(vision,2);assert.match(await page.locator('#search-status').innerText(),/保持镜头稳定/);
await page.waitForFunction(()=>window.searchTest.runtime.taskState().search.state==='found',{},{timeout:20000});
assert.equal(vision,3);assert.equal(maxInflight,1);assert.equal(new Set(images).size,3);assert.match(await page.locator('#latest-answer').innerText(),/找到了绿色水杯/);assert.equal(await page.locator('#search-controls').isVisible(),false);
assert.equal(await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1')),before);
await page.evaluate(()=>window.searchTest.sendText('帮我找绿色水杯'));await page.getByRole('button',{name:'暂停寻找',exact:true}).click();
assert.equal(await page.evaluate(()=>window.searchTest.runtime.taskState().search.state),'paused');assert.equal(vision,3);
await page.getByRole('button',{name:'继续寻找',exact:true}).click();assert.equal(await page.evaluate(()=>window.searchTest.runtime.taskState().search.state),'searching');
for(const size of [{width:320,height:568},{width:390,height:844}]){await page.setViewportSize(size);const b=await page.locator('#search-cancel').boundingBox();assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=size.width&&b.y+b.height<=size.height,JSON.stringify(b));}
await page.getByRole('button',{name:'取消寻找',exact:true}).click();assert.equal(await page.evaluate(()=>window.searchTest.runtime.taskState().search.state),'idle');assert.equal(await page.locator('#search-controls').isVisible(),false);
assert.equal(await page.evaluate(()=>window.searchTest.bridge().videoTrack.readyState==='live'),true);
await page.click('#end-conversation');assert.deepEqual(errors,[]);
console.log('PASS: generated mobile page, one find command, fresh missing/seen/confirmed frames, single flight, one found result, unchanged memory, pause/resume/cancel controls');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
