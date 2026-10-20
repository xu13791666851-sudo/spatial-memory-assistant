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
let deny=false,vision=0;
await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='ui.test')return r.abort();
 if(u.pathname==='/api/access')return r.fulfill({json:{configured:true,authenticated:true}});
 if(u.pathname==='/api/realtime/sdp')return deny?r.fulfill({status:403,json:{detail:'测试连接被拒绝'}}):r.fulfill({body:'v=0\r\n'});
 if(u.pathname==='/api/vision'){vision++;return r.fulfill({status:502,json:{detail:'测试画面超时'}});}
 const file=path.join(process.cwd(),'dist',u.pathname==='/'?'index.html':u.pathname);return r.fulfill({body:await fs.readFile(file),contentType:u.pathname.endsWith('.svg')?'image/svg+xml':u.pathname.endsWith('.css')?'text/css':/\.(js|mjs)$/.test(u.pathname)?'text/javascript':'text/html'});
});
await page.goto('https://ui.test/');await page.waitForFunction(()=>document.querySelector('#main-toggle').textContent==='开始');
await page.evaluate(()=>{const drawer=document.createElement('div');drawer.dataset.netlifyDeployId='fixture';drawer.style.cssText='position:fixed;inset:0;z-index:999999';document.body.append(drawer);});
await page.getByRole('button',{name:'开始',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('你好，我是小忆。现在可以和我说话了。'));
assert.equal(await page.evaluate(()=>window.mediaRequests.filter(c=>c.video).length),1);assert.equal(await page.evaluate(()=>!!document.getElementById('preview').srcObject),true);
await page.screenshot({path:'/tmp/camera-active.png'});const mediaCount=await page.evaluate(()=>window.mediaRequests.length);await page.click('#open-records');await page.click('#close-records');assert.equal(await page.evaluate(()=>window.mediaRequests.length),mediaCount);
await page.waitForTimeout(800);assert.equal(vision,0);assert.equal(await page.locator('#chat .chat-turn').count(),1);
await page.click('#open-records');await page.locator('#text-tools').evaluate(e=>e.open=true);await page.fill('#message','眼前有什么');await page.locator('#chat-form button').click();
await page.click('#close-records');await page.getByRole('button',{name:'重新观察',exact:true}).waitFor();assert.equal(vision,1);await page.click('#main-toggle');await page.waitForFunction(()=>!!document.getElementById('preview').srcObject);assert.equal(vision,1);
await page.evaluate(()=>document.getElementById('end-conversation').click());if(await page.locator('#records-dialog').isVisible())await page.click('#close-records');await page.click('#open-records');await page.locator('#text-tools').evaluate(e=>e.open=true);await page.fill('#message','你好');await page.locator('#chat-form button').click();await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('可以，我在听。'));
assert.equal(await page.locator('#chat').getByText('你好，我是小忆。现在可以和我说话了。',{exact:true}).count(),0);assert.equal(vision,1);
await page.evaluate(()=>document.getElementById('end-conversation').click());if(await page.locator('#records-dialog').isVisible())await page.click('#close-records');deny=true;await page.click('#main-toggle');await page.waitForFunction(()=>document.querySelector('#notice').textContent==='测试连接被拒绝');assert.equal(await page.locator('#chat').getByText('你好，我是小忆。现在可以和我说话了。',{exact:true}).count(),0);
await page.click('#open-records');await page.locator('#text-tools').evaluate(e=>e.open=true);await page.fill('#message','你好');await page.click('#text-send');await page.waitForFunction(()=>document.getElementById('composer-status').textContent.includes('文字已保留'));assert.equal(await page.locator('#message').inputValue(),'你好');assert.equal(await page.locator('#text-composer').isVisible(),true);await page.click('#text-composer-close');
// Primary control also supports keyboard start/end; voice pause can resume here.
if(await page.locator('#records-dialog').isVisible())await page.click('#close-records');deny=false;await page.locator('#main-toggle').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#main-toggle').textContent==='结束'&&!!document.getElementById('preview').srcObject&&!document.getElementById('pause').disabled);
await page.evaluate(()=>document.getElementById('pause').onclick());await page.getByRole('button',{name:'继续',exact:true}).waitFor();await page.click('#main-toggle');await page.getByRole('button',{name:'结束',exact:true}).waitFor();await page.click('#main-toggle');await page.getByRole('button',{name:'开始',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.getElementById('preview').srcObject),null);
assert.deepEqual(errors,[]);console.log('PASS: unobstructed start, RTC handshake, microphone readiness, greeting without automatic vision, requested vision, visual failure/retry, text auto-connect, rejected connection without false greeting');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
