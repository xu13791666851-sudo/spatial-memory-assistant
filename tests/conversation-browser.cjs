// Offline generated-page checks; install Playwright or set PLAYWRIGHT_MODULE.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.CHROME_CHANNEL||'chrome'});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR:',e.message);});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.hostname!=='ui.test')return route.abort();
  if(url.pathname==='/api/access')return route.fulfill({json:{configured:true,authenticated:true}});
  if(url.pathname.startsWith('/api/'))throw Error('Unexpected model/network call: '+url.pathname);
  const file=path.join(process.cwd(),'dist',url.pathname==='/'?'index.html':url.pathname);
  let body=await fs.readFile(file,'utf8');
  if(url.pathname==='/static/app.js')body+='\nwindow.testUI={handleCloud,conversation,stop,ready:()=>ready,setReady:(value,p=false)=>{ready=value;paused=p;actionUI();}};';
  await route.fulfill({body,contentType:url.pathname.endsWith('.svg')?'image/svg+xml':url.pathname.endsWith('.css')?'text/css':/\.(mjs|js)$/.test(url.pathname)?'text/javascript':'text/html'});
 });
 await page.goto('https://ui.test/');await page.waitForFunction(()=>!!window.testUI);
 await page.evaluate(()=>document.getElementById('screen-reader-mode').checked=true);
 await page.selectOption('#place-mode','home');
 await page.evaluate(async()=>{
  const ui=window.testUI;await ui.handleCloud({type:'conversation.item.input_audio_transcription.completed',transcript:'帮我记住蓝色玻璃杯的位置'});
  await ui.handleCloud({type:'app.memory_result',answer:'已记住：蓝色玻璃杯在木桌上、纸巾盒旁边。',saved:true,items:[],pending:null});
  await ui.handleCloud({type:'response.audio_transcript.delta',item_id:'cloud1',delta:'可以把镜头'});
  await ui.handleCloud({type:'response.audio_transcript.delta',item_id:'cloud1',delta:'对准桌子吗？'});
  await ui.handleCloud({type:'response.audio_transcript.done',item_id:'cloud1',transcript:'可以把镜头对准桌子吗？'});
  await ui.handleCloud({type:'response.text.done',item_id:'cloud1',text:'可以把镜头对准桌子吗？'});
  await ui.handleCloud({type:'response.audio_transcript.done',item_id:'replay',transcript:'重复朗读',replay:true});
 });
 assert.equal(await page.locator('#chat').getByText('可以把镜头对准桌子吗？',{exact:true}).count(),1);
 assert.equal(await page.locator('#chat').getByText('重复朗读',{exact:true}).count(),0);
 assert.equal(await page.locator('.chat-tag').filter({hasText:'已存入物品记忆'}).count(),1);
 await page.click('#open-records');
 await page.evaluate(()=>window.testUI.setReady(true));assert.equal(await page.locator('#main-toggle').textContent(),'暂停');assert.ok(await page.locator('#end-conversation').isVisible());
 await page.evaluate(()=>window.testUI.setReady(true,true));assert.equal(await page.locator('#main-toggle').textContent(),'继续');await page.evaluate(()=>window.testUI.setReady(false));
 const camera=await page.locator('#camera-preview').boundingBox();
 await page.evaluate(()=>{for(let i=0;i<20;i++)window.testUI.conversation.add('历史消息 '+i+'，这是一条可以回顾的对话记录。',i%2===0);});
 await page.locator('#chat').evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
 await page.evaluate(()=>window.testUI.conversation.add('刚刚到达的新回答'));
 assert.equal(await page.locator('#chat').evaluate(e=>e.scrollTop),0);
 await page.locator('#chat-jump').waitFor({state:'visible'});await page.click('#chat-jump');
 assert.ok(await page.locator('#chat').evaluate(e=>e.scrollTop>0));
 assert.deepEqual(await page.locator('#camera-preview').boundingBox(),camera);
 await page.click('#close-records');await page.click('#expand-video');assert.equal(await page.locator('body').getAttribute('data-layout'),'video');assert.equal(await page.locator('#chat').isVisible(),false);
 await page.click('#expand-video');await page.click('#open-records');await page.locator('.record-history').evaluate(e=>e.open=true);await page.click('#expand-chat');assert.equal(await page.locator('body').getAttribute('data-layout'),'home');assert.deepEqual(await page.locator('#camera-preview').boundingBox(),camera);
 await page.click('#expand-chat');
 await page.screenshot({path:process.env.UI_SCREENSHOT||'/tmp/spatial-conversation-ui.png'});
 await page.reload();await page.waitForFunction(()=>!!window.testUI);await page.click('#open-records');assert.ok(await page.locator('#chat').getByText('刚刚到达的新回答',{exact:true}).isVisible());
 await page.evaluate(()=>{document.getElementById('screen-reader-mode').checked=true;localStorage.setItem('spatial-memory.records.v1','[]');window.testUI.conversation.begin();window.testUI.conversation.add('新的对话');});
 await page.locator('.record-history').evaluate(e=>e.open=true);const old=await page.locator('#chat-session option').last().getAttribute('value');await page.selectOption('#chat-session',old);
 await page.evaluate(()=>window.testUI.conversation.add('当前对话又有新消息'));
 assert.equal(await page.locator('#chat-session').inputValue(),old);assert.equal(await page.locator('#chat').getByText('当前对话又有新消息',{exact:true}).count(),0);assert.ok(await page.locator('#chat-jump').isVisible());
 await page.click('#chat-jump');assert.ok(await page.locator('#chat').getByText('当前对话又有新消息',{exact:true}).isVisible());
 await page.click('#delete-chat');await page.click('#delete-chat-confirm');assert.equal(await page.locator('#chat-session option').count(),1);assert.equal(await page.evaluate(()=>localStorage.getItem('spatial-memory.records.v1')),'[]');
 for(const size of [{width:320,height:568},{width:320,height:380},{width:1024,height:768}]){
  await page.setViewportSize(size);await page.locator('#text-tools').evaluate((e,small)=>e.open=small,size.height===380);await page.evaluate(()=>document.documentElement.style.setProperty('--answer-size','28px'));
  await page.waitForTimeout(50);
  const dimensions=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,button:document.getElementById('main-toggle').getBoundingClientRect().bottom,height:innerHeight,chat:document.getElementById('chat').getBoundingClientRect().height}));
  assert.ok(dimensions.width<=dimensions.viewport,JSON.stringify(dimensions));assert.ok(dimensions.button<=dimensions.height,JSON.stringify(dimensions));assert.ok(dimensions.chat>0,JSON.stringify(dimensions));
 }
 assert.deepEqual(errors,[]);console.log('PASS: generated page, streamed/replayed deduplication, source tags, fixed preview, scroll anchoring, view toggles, refresh, session selection, deletion, mobile/keyboard/desktop layouts');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
