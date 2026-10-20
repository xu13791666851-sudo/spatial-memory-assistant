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


await page.addInitScript(()=>{
 window.streamSockets=[];window.WebSocket=class{static OPEN=1;constructor(){window.streamSockets.push(this);setTimeout(()=>this.onerror?.(),100);}close(){this.closed=true;}};
});
const images=[];let http=0;
await page.route('**/*',async route=>{
 const u=new URL(route.request().url());if(u.hostname!=='ui.test')return route.abort();
 if(u.pathname==='/api/access')return route.fulfill({json:{configured:true,authenticated:true}});
 if(u.pathname==='/api/realtime/sdp')return route.fulfill({body:'v=0\r\n'});
 if(u.pathname==='/api/vision'){
  const r=route.request().postDataJSON();images.push(r.image);http++;assert.equal(r.task.remember,false);assert.equal(r.task.target,'绿色水杯');
  return route.fulfill({json:{request_id:r.request_id,frame_received:true,frame_status:'clear',answer:'绿色水杯在电脑左侧。',objects:[{name:'电脑',position:'右侧'}],target_visible:true,appearance_match:{status:'match',unique:true,reason:'绿色杯身及白色杯盖一致'}}});
 }
 let body=await fs.readFile(path.join(process.cwd(),'dist',u.pathname==='/'?'index.html':u.pathname),'utf8');
 if(u.pathname==='/static/vision-stream-config.mjs')body="export const VISION_STREAM_URL='wss://stream.test/api/vision-stream';";
 if(u.pathname==='/static/app.js')body+='\nwindow.searchTest={runtime,sendText,bridge:()=>socket};';
 return route.fulfill({body,contentType:u.pathname.endsWith('.svg')?'image/svg+xml':u.pathname.endsWith('.css')?'text/css':/\.(js|mjs)$/.test(u.pathname)?'text/javascript':'text/html'});
});
await page.goto('https://ui.test/');await page.waitForFunction(()=>window.searchTest);
await page.evaluate(()=>{document.getElementById('screen-reader-mode').checked=true;const r=window.searchTest.runtime;r.setPlace('home');r.memory.saveVisual('绿色水杯',{unique:true,location_supported:true,anchor:'木桌',location:'木桌上，电脑左侧',appearance:'绿色杯身，有白色杯盖'},new Date().toISOString());});
await page.getByRole('button',{name:'开启摄像头和语音对话',exact:true}).click();await page.waitForFunction(()=>window.searchTest.bridge()?.configured);await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('你好，我是小忆'));
const before=await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1'));
await page.evaluate(()=>window.searchTest.sendText('帮我找绿色水杯'));
await page.waitForFunction(()=>document.getElementById('search-status').textContent.includes('自动重连'));
assert.equal(await page.evaluate(()=>document.getElementById('preview').srcObject.getVideoTracks()[0].readyState),'live');
await page.waitForFunction(()=>window.searchTest.runtime.taskState().search.fallback===true);
assert.equal(await page.evaluate(()=>window.streamSockets.length),2);
await page.waitForFunction(()=>window.searchTest.runtime.taskState().search.state==='found',null,{timeout:20000});
assert.equal(http,2);assert.equal(new Set(images).size,2);assert.equal(await page.evaluate(()=>window.streamSockets.length),2);
assert.equal(await page.evaluate(()=>document.getElementById('preview').srcObject.getVideoTracks()[0].readyState),'live');assert.equal(await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1')),before);assert.match(await page.locator('#latest-answer').innerText(),/找到了绿色水杯/);
await page.click('#end-conversation');assert.deepEqual(errors,[]);
console.log('PASS recovery: failed sockets retry once then HTTP finds target, fresh images, camera and memory retained');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
