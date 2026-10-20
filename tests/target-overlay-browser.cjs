// Real video/canvas geometry with isolated records; no camera permissions or API calls.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.hostname!=='overlay.test')return route.abort();
  if(u.pathname==='/api/access')return route.fulfill({json:{configured:true,authenticated:true}});
  const file=u.pathname==='/'?'index.html':u.pathname;
  let body=await fs.readFile(path.join(process.cwd(),'dist',file),'utf8');
  if(u.pathname==='/static/app.js')body+='\nwindow.testUI={runtime,unifiedHome};';
  return route.fulfill({body,contentType:u.pathname.endsWith('.svg')?'image/svg+xml':u.pathname.endsWith('.css')?'text/css':/\.(mjs|js)$/.test(u.pathname)?'text/javascript':'text/html'});
 });
 await page.goto('https://overlay.test/');await page.waitForFunction(()=>!!window.testUI);
 await page.evaluate(async()=>{
  const {fingerprint}=await import('/static/target-overlay.mjs'),canvas=document.createElement('canvas');canvas.width=800;canvas.height=400;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#e0e7ec';ctx.fillRect(0,0,800,400);ctx.fillStyle='#469d6b';ctx.fillRect(300,80,160,240);ctx.strokeStyle='#469d6b';ctx.lineWidth=20;ctx.strokeRect(460,110,60,120);
  const video=document.getElementById('preview');document.getElementById('camera-preview').hidden=false;document.getElementById('camera-empty').hidden=true;
  video.style.display='block';video.srcObject=canvas.captureStream(10);await video.play();
  const record={name:'绿色水杯',appearance:'绿色杯身，有把手'};
  window.box={token:'first',target:'绿色水杯',record,box:[0.35,0.18,0.67,0.82],capturedAt:Date.now(),fingerprint:fingerprint(video,[0.35,0.18,0.67,0.82]),status:'pending'};
  window.testUI.runtime.targetOverlayState=()=>window.box;window.testUI.unifiedHome.syncState();window.fixture={canvas,ctx,video,fingerprint};
 });
 const layer=page.locator('.memory-target-overlay');await layer.waitFor({state:'visible'});
 assert.equal(await layer.count(),1);assert.match(await layer.innerText(),/绿色水杯.*待核对/);
 assert.equal(await layer.evaluate(e=>getComputedStyle(e).borderTopStyle),'dashed');assert.equal(await layer.evaluate(e=>getComputedStyle(e).pointerEvents),'none');
 for(const viewport of [{width:390,height:844},{width:1024,height:768},{width:320,height:568}]){
  await page.setViewportSize(viewport);await page.evaluate(()=>{window.box.capturedAt=Date.now();window.testUI.unifiedHome.targetOverlay.sync();});
  const measured=await page.evaluate(()=>{
   const video=document.getElementById('preview'),area=document.getElementById('camera-preview').getBoundingClientRect(),box=document.querySelector('.memory-target-overlay').getBoundingClientRect();
   const scale=Math.min(area.width/video.videoWidth,area.height/video.videoHeight),w=video.videoWidth*scale,h=video.videoHeight*scale;
   return {actual:[box.x,box.y,box.width,box.height],expected:[area.x+(area.width-w)/2+w*.35,area.y+(area.height-h)/2+h*.18,w*.32,h*.64],overflow:document.documentElement.scrollWidth>innerWidth};
  });assert.ok(measured.actual.every((v,i)=>Math.abs(v-measured.expected[i])<1),JSON.stringify(measured));assert.equal(measured.overflow,false);
 }
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{window.box.status='confirmed';window.box.capturedAt=Date.now();window.testUI.unifiedHome.syncState();});
 assert.equal(await layer.evaluate(e=>getComputedStyle(e).borderTopStyle),'solid');assert.match(await layer.innerText(),/外观已核对/);
 await fs.mkdir('output/playwright',{recursive:true});await page.screenshot({path:'output/playwright/remembered-target-confirmed.png'});
 await page.getByRole('button',{name:'放大画面',exact:true}).click();assert.equal(await page.locator('body').getAttribute('data-layout'),'video');
 await page.getByRole('button',{name:'恢复首页',exact:true}).click();await page.getByRole('button',{name:'收起画面',exact:true}).click();assert.equal(await layer.isVisible(),false);
 await page.getByRole('button',{name:'展开画面',exact:true}).click();await layer.waitFor({state:'visible'});
 // A small moving object may not change most of the frame: compare the target crop too.
 await page.evaluate(()=>{const {ctx,canvas}=window.fixture;ctx.fillStyle='#151b27';ctx.fillRect(0,0,canvas.width,canvas.height);});
 await layer.waitFor({state:'hidden'});
 await page.evaluate(()=>{const {ctx,canvas}=window.fixture;ctx.fillStyle='#e0e7ec';ctx.fillRect(0,0,800,400);ctx.fillStyle='#469d6b';ctx.fillRect(300,80,160,240);ctx.strokeStyle='#469d6b';ctx.lineWidth=20;ctx.strokeRect(460,110,60,120);window.testUI.unifiedHome.targetOverlay.sync();});
 assert.equal(await layer.isVisible(),false); // Returning to the old view cannot revive stale evidence.
 await page.evaluate(()=>{window.box={...window.box,token:'new',capturedAt:Date.now()};window.testUI.unifiedHome.syncState();});await layer.waitFor({state:'visible'});
 await page.evaluate(()=>{window.box.capturedAt=Date.now()-8001;window.testUI.unifiedHome.syncState();});assert.equal(await layer.isVisible(),false);
 await page.evaluate(()=>{window.box=null;window.testUI.unifiedHome.syncState();window.fixture.video.srcObject.getTracks().forEach(t=>t.stop());});assert.equal(await layer.isVisible(),false);
 assert.deepEqual(errors,[]);console.log('PASS: memory target box, pending/confirmed, 3 viewports, contain letterboxing, zoom/collapse, click-through, movement, no resurrection, expiry and removal');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
