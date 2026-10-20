const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('UI ERROR',e.message);});
 await page.addInitScript(()=>{
  window.nativeCalls=[];window.nativeState={running:false,paused:false,target:null,searchState:'IDLE',message:'安卓本机识别已就绪',learningSamples:0};
  window.nativeMemories=[{id:'cup-1',name:'绿色水杯',recorded_at:'2026-10-20T12:00:00Z',appearance:'绿色杯身',sample_count:3,location:'书桌上，台灯旁边',aliases:[],relations:[]}];
  navigator.mediaDevices.getUserMedia=()=>{throw Error('Browser camera must not run');};
  window.NativeAssistant={postMessage:raw=>{const q=JSON.parse(raw);window.nativeCalls.push(q);setTimeout(()=>{
   let result=true;if(q.method==='ready')result={state:window.nativeState,memories:window.nativeMemories};
   if(['start','resume','stop','pause'].includes(q.method)){window.nativeState={...window.nativeState,running:['start','resume'].includes(q.method),paused:q.method==='pause'};window.nativeEvent?.({type:'state',data:window.nativeState});}
   if(q.method==='text'){window.nativeState={...window.nativeState,target:'绿色水杯',searchState:'SEARCHING',rememberedObjectId:'cup-1',message:'正在结合个人外观记忆寻找绿色水杯'};window.nativeEvent?.({type:'state',data:window.nativeState});}
   if(q.method==='editMemory'){window.nativeMemories=[{...window.nativeMemories[0],...q.params}];result={items:window.nativeMemories,answer:'已保存修改。'};}
   if(q.method==='deleteMemory'){window.nativeMemories=[];result={items:[],answer:'已删除这条记忆。'};}
   if(q.method==='scan')result=[{id:'device-1',name:'视障相机',signal:-40}];
   if(q.method==='status')result={labels:80,connection:'CONNECTED'};
   window.NativeAssistant.onmessage({data:JSON.stringify({id:q.id,result})});
  },20);}};
 });
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.hostname,'appassets.androidplatform.net');
  const file=path.join(process.cwd(),'android/app/src/main/assets/site',url.pathname==='/'?'index.html':url.pathname);
  return route.fulfill({body:await fs.readFile(file),contentType:url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.svg')?'image/svg+xml':/\.(mjs|js)$/.test(url.pathname)?'text/javascript':'text/html'});
 });
 await page.goto('https://appassets.androidplatform.net/index.html');await page.waitForFunction(()=>window.nativeCalls.some(c=>c.method==='ready'));
 await page.getByRole('button',{name:'记录',exact:true}).click();await page.getByRole('tab',{name:'物品记忆',exact:true}).click();await page.getByRole('button',{name:'找这件，绿色水杯',exact:true}).click();
 await page.waitForFunction(()=>window.nativeCalls.some(c=>c.method==='text'&&c.params.text==='找绿色水杯'));await page.waitForFunction(()=>document.getElementById('current-task').textContent.includes('绿色水杯'));
 const jpg=(await fs.readFile('designs/desk-reference.jpg')).toString('base64');
 await page.evaluate(image=>window.nativeEvent({type:'frame',data:{image,width:1600,height:1000,capturedAt:Date.now(),detections:[{label:'cup',confidence:.9,box:[.2,.3,.45,.7]},{label:'laptop',confidence:.95,box:[.5,.1,.95,.8]}]}}),jpg);
 const box=page.locator('.memory-target-overlay:not([hidden])');await box.waitFor({state:'visible'});assert.match(await box.innerText(),/绿色水杯.*待核对/);assert.equal(await page.locator('#native-preview').isVisible(),true);
 await page.getByRole('button',{name:'放大画面',exact:true}).click();await page.getByRole('button',{name:'恢复首页',exact:true}).click();
 await page.getByRole('button',{name:'记录',exact:true}).click();await page.getByRole('tab',{name:'物品记忆',exact:true}).click();await page.getByRole('button',{name:'编辑，绿色水杯',exact:true}).click();await page.getByRole('textbox',{name:'位置和参照关系',exact:true}).fill('木桌右侧');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.locator('#memory-editor').waitFor({state:'hidden'});assert.match(await page.locator('#memories').innerText(),/木桌右侧/);
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('#main-toggle').click();await page.waitForFunction(()=>window.nativeState.paused&&document.getElementById('native-preview').hidden);assert.equal(await page.locator('#native-preview').isVisible(),false);
 await page.locator('#main-toggle').click();await page.waitForFunction(()=>window.nativeCalls.some(c=>c.method==='resume'));
 await page.getByRole('button',{name:'文字大小与声音设置',exact:true}).click();await page.locator('#more-tools').locator('summary').first().click();await page.getByText('摄像头与硬件',{exact:true}).click();await page.getByRole('button',{name:'扫描硬件',exact:true}).click();await page.waitForFunction(()=>document.getElementById('native-devices').options.length===1);await page.getByRole('button',{name:'关闭',exact:true}).click();
 for(const viewport of [{width:320,height:568},{width:390,height:844},{width:1024,height:768}]){await page.setViewportSize(viewport);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.setViewportSize({width:390,height:844});await fs.mkdir('output/android',{recursive:true});await page.screenshot({path:'output/android/original-ui-android.png'});
 assert.deepEqual(errors,[]);console.log('PASS: packaged original UI, native-only commands, memory search/edit, frame/target box, pause/resume, hardware entrance and three screen sizes');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
