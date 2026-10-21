// Real server, real handoff model and live Qwen; only camera/microphone inputs
// are controlled fixtures. Run after generating the documented media fixtures.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
(async()=>{
 const base=process.env.DEMO_TEST_URL||'http://127.0.0.1:8898';
 const browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-video-capture='+path.resolve('output/demo-camera.y4m'),'--use-file-for-fake-audio-capture='+path.resolve('output/demo-asr.wav')]});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[],events=[];page.on('pageerror',e=>errors.push(e.message));
  async function waitState(predicate,timeout=45000){const until=Date.now()+timeout;let data;while(Date.now()<until){data=await(await page.request.get(base+'/api/demo/state')).json();if(predicate(data))return data;await new Promise(r=>setTimeout(r,300));}throw Error('State wait expired: '+JSON.stringify(data));}
  page.on('websocket',socket=>socket.on('framereceived',({payload})=>{try{const event=JSON.parse(payload);events.push(event.type);}catch{}}));
  await page.goto(base);await page.getByRole('button',{name:'开始',exact:true}).click();await page.waitForFunction(()=>document.getElementById('voice-state').textContent.includes('千问已连接'),{},{timeout:30000});
  await page.getByRole('button',{name:'对话记录',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.chat-turn.user')).some(e=>e.textContent.includes('蓝色水杯')),{},{timeout:40000});
  const savedState=await waitState(data=>data.memories.some(r=>r.name==='蓝色水杯'&&r.sample_count===3));
  const saved=savedState.memories.find(r=>r.name==='蓝色水杯');
  assert.ok(saved.appearance,'appearance must come from actual image check');assert.equal(saved.sample_count,3);
  await page.getByRole('tab',{name:'物品记忆',exact:true}).click();await page.getByRole('button',{name:'找这件，蓝色水杯',exact:true}).waitFor({state:'visible',timeout:15000});assert.match(await page.locator('#memories').innerText(),/蓝色水杯/);await page.locator('#pixel-records-home').click();
  await page.getByRole('button',{name:'结束',exact:true}).click();assert.equal(await page.locator('#preview').evaluate(v=>v.srcObject),null);await page.reload();
  await page.getByRole('button',{name:'对话记录',exact:true}).click();await page.getByRole('tab',{name:'物品记忆',exact:true}).click();await page.getByRole('button',{name:'找这件，蓝色水杯',exact:true}).waitFor({state:'visible',timeout:15000});assert.match(await page.locator('#memories').innerText(),/蓝色水杯/);
  await page.getByRole('button',{name:'找这件，蓝色水杯',exact:true}).click();await page.waitForFunction(()=>document.getElementById('preview').srcObject);await page.locator('#preview').evaluate(v=>v.srcObject.getAudioTracks().forEach(t=>t.enabled=false));
  await waitState(data=>data.state.searchState==='GUIDING');
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.memory-target-overlay:not([hidden])')).some(e=>e.dataset.status==='confirmed'),{},{timeout:10000});
  await fs.mkdir('output/playwright',{recursive:true});await page.screenshot({path:'output/playwright/demo-found.png'});
  await page.getByRole('button',{name:'对话记录',exact:true}).click();await page.getByRole('tab',{name:'物品记忆',exact:true}).click();await page.getByRole('button',{name:'编辑，蓝色水杯',exact:true}).click();await page.getByRole('textbox',{name:'位置和参照关系',exact:true}).fill('书桌上，电脑左侧');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.locator('#memory-editor').waitFor({state:'hidden'});assert.match(await page.locator('#memories').innerText(),/电脑左侧/);
  const other=await browser.newContext();const otherPage=await other.newPage();await otherPage.goto(base);const isolated=await otherPage.evaluate(async()=> (await(await fetch('/api/demo/state')).json()).memories);assert.deepEqual(isolated,[]);await other.close();
  await page.getByRole('button',{name:'编辑，蓝色水杯',exact:true}).click();await page.getByRole('button',{name:'删除这条记忆',exact:true}).click();await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.locator('#memory-delete-dialog').waitFor({state:'hidden'});assert.equal((await page.evaluate(async()=> (await(await fetch('/api/demo/state')).json()).memories)).length,0);
  await page.locator('#pixel-records-home').click();
  for(const size of [{width:320,height:568},{width:390,height:844},{width:844,height:390}]){await page.setViewportSize(size);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.getByRole('button',{name:'结束',exact:true}).click();assert.equal(await page.locator('#preview').evaluate(v=>v.srcObject),null);
  assert.ok(events.includes('ready'));assert.ok(events.includes('transcript'));assert.ok(events.includes('audio'));assert.deepEqual(errors,[]);
  const report={passed:true,savedAppearance:saved.appearance,samples:saved.sample_count,voiceConnected:true,actualMicrophoneTranscription:true,actualAudio:true,actualModel:true,reloadPersistence:true,searchConfirmed:true,editDelete:true,browserIsolation:true,mediaReleased:true,errors};await fs.writeFile('output/demo-browser-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
