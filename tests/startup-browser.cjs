// Full generated-page startup with fake media/RTC and local API fixtures.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});try{
const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
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
let deny=false,vision=0;
await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='ui.test')return r.abort();
 if(u.pathname==='/api/access')return r.fulfill({json:{configured:true,authenticated:true}});
 if(u.pathname==='/api/realtime/sdp')return deny?r.fulfill({status:403,json:{detail:'测试连接被拒绝'}}):r.fulfill({body:'v=0\r\n'});
 if(u.pathname==='/api/vision'){vision++;return r.fulfill({status:502,json:{detail:'测试画面超时'}});}
 const file=path.join(process.cwd(),'dist',u.pathname==='/'?'index.html':u.pathname);return r.fulfill({body:await fs.readFile(file),contentType:u.pathname.endsWith('.svg')?'image/svg+xml':u.pathname.endsWith('.css')?'text/css':/\.(js|mjs)$/.test(u.pathname)?'text/javascript':'text/html'});
});
await page.goto('https://ui.test/');await page.waitForFunction(()=>document.querySelector('#main-toggle').textContent==='开始');
await page.evaluate(()=>{const drawer=document.createElement('div');drawer.dataset.netlifyDeployId='fixture';drawer.style.cssText='position:fixed;inset:0;z-index:999999';document.body.append(drawer);});
await page.click('#main-toggle');await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('你好，我是小忆。现在可以和我说话了。'));
await page.waitForTimeout(800);assert.equal(vision,0);assert.equal(await page.locator('#chat .chat-turn').count(),1);
await page.locator('#text-tools').evaluate(e=>e.open=true);await page.fill('#message','眼前有什么');await page.locator('#chat-form button').click();
await page.locator('#video-again').waitFor({state:'visible'});assert.equal(vision,1);await page.click('#video-again');await page.waitForFunction(()=>document.querySelector('#video-again').hidden);await page.locator('#video-again').waitFor({state:'visible'});assert.equal(vision,2);
await page.click('#end-conversation');await page.locator('#text-tools').evaluate(e=>e.open=true);await page.fill('#message','你好');await page.locator('#chat-form button').click();await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('可以，我在听。'));
assert.equal(await page.locator('#chat').getByText('你好，我是小忆。现在可以和我说话了。',{exact:true}).count(),0);assert.equal(vision,2);
await page.click('#end-conversation');deny=true;await page.click('#main-toggle');await page.waitForFunction(()=>document.querySelector('#notice').textContent==='测试连接被拒绝');assert.equal(await page.locator('#chat').getByText('你好，我是小忆。现在可以和我说话了。',{exact:true}).count(),0);
assert.deepEqual(errors,[]);console.log('PASS: unobstructed start, RTC handshake, microphone readiness, greeting without automatic vision, requested vision, visual failure/retry, text auto-connect, rejected connection without false greeting');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
