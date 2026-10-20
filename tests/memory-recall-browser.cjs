// Rendered-page regression: persisted visual memory, natural recall, reload and
// voice transcript routing. No model or camera is needed to read a saved record.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],apiRequests=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.hostname!=='ui.test')return route.abort();
  if(url.pathname.startsWith('/api/')){apiRequests.push(url.pathname);assert.equal(url.pathname,'/api/access');return route.fulfill({json:{configured:false,authenticated:false}});}
  let body=await fs.readFile(path.join(process.cwd(),'dist',url.pathname==='/'?'index.html':url.pathname),'utf8');
  if(url.pathname==='/static/app.js')body+='\nwindow.recallTest={runtime,speak:text=>{const b=new runtime.Bridge();b.mode="assistant";b.onmessage=e=>handleCloud(JSON.parse(e.data));b.event({type:"conversation.item.input_audio_transcription.completed",transcript:text});b.close();}};';
  return route.fulfill({body,contentType:url.pathname.endsWith('.svg')?'image/svg+xml':url.pathname.endsWith('.css')?'text/css':/\.(mjs|js)$/.test(url.pathname)?'text/javascript':'text/html'});
 });
 await page.goto('https://ui.test/');await page.waitForFunction(()=>!!window.recallTest);await page.selectOption('#place-mode','home');
 await page.evaluate(()=>window.recallTest.runtime.memory.saveVisual('纸杯',{unique:true,location_supported:true,anchor:'电脑',location:'书桌上，电脑左侧'}));
 const stored=await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1'));
 const send=async text=>{await page.locator('#text-tools summary').click();await page.fill('#message',text);await page.click('#text-send');await page.locator('#text-composer').waitFor({state:'hidden'});};
 for(const phrase of ['我不记得放哪里了，你帮我看看之前我放在哪里了','白色纸杯上次放在哪里','帮我找纸杯']){
  await send(phrase);assert.match(await page.locator('#chat').innerText(),/纸杯在书桌上，电脑左侧/);
 }
 await page.reload();await page.waitForFunction(()=>!!window.recallTest);
 await send('你帮我看看之前我把纸杯放在哪里了');assert.match(await page.locator('#chat').innerText(),/纸杯在书桌上，电脑左侧/);
 await page.evaluate(()=>window.recallTest.speak('我不记得放哪里了，你帮我看看之前我放在哪里了'));
 const answer=await page.locator('#chat .chat-turn').last().innerText();assert.match(answer,/纸杯在书桌上，电脑左侧/);assert.match(answer,/还没有确认现在的位置/);
 assert.equal(await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1')),stored);
 assert.ok(apiRequests.every(url=>url==='/api/access'));assert.deepEqual(errors,[]);
 console.log('PASS: visual record recalled by natural typed and voice questions, with camera/model unavailable, survives reload, preserves saved data');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
