// Exercise the supplied model and actual browser WASM runtime, without Qwen mocks.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/access'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"configured":false,"authenticated":false}');return;}
  if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const file=pathname==='/fixture.jpg'?'designs/desk-reference.jpg':'dist/'+(pathname==='/'?'index.html':pathname.slice(1));
  try{
   const body=await fs.readFile(path.resolve(file));
   const type=/\.(mjs|js)$/.test(file)?'text/javascript':file.endsWith('.wasm')?'application/wasm':file.endsWith('.json')?'application/json':file.endsWith('.jpg')?'image/jpeg':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html';
   res.writeHead(200,{'Content-Type':type,'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':pathname==='/static/yolo-worker.js'?"default-src 'none'; script-src 'self' 'unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self'":"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'"});res.end(body);
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();page.on('console',message=>{if(message.type()==='error')console.error(message.text().slice(0,500));});
  const url=process.env.YOLO_TEST_URL||'http://127.0.0.1:'+server.address().port+'/';
  if(process.env.YOLO_TEST_URL)await page.route(new URL('/fixture.jpg',url).href,route=>route.fulfill({path:path.resolve('designs/desk-reference.jpg'),contentType:'image/jpeg'}));
  await page.goto(url);
  const result=await page.evaluate(async(liveQwen)=>{
   const {LocalYolo}=await import('/static/yolo-local.mjs'),local=new LocalYolo({timeoutMs:12000});
   const start=performance.now(),ready=await local.warm();
   if(!ready)return {ready,failed:local.failed,error:local.lastError};
   const blob=await (await fetch('/fixture.jpg')).blob(),image=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});
   const runs=[];for(let i=0;i<3;i++)runs.push(await local.call('detect',{image}));
   let captures=0;const prepared=await local.prepare({target:'蓝色水杯',capture:()=>{captures++;return image;},signal:new AbortController().signal});
   const result={ready,isolated:crossOriginIsolated,loadMs:performance.now()-start-runs.reduce((n,r)=>n+r.latencyMs,0)-prepared.local.latencyMs,threads:local.info.threads,inputs:local.info.inputs,outputs:local.info.outputs,labels:local.info.labels.length,runs,prepared:{...prepared,image:undefined},captures};
   if(liveQwen){const started=performance.now(),request_id=crypto.randomUUID();const response=await fetch('/api/vision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:prepared.image,request_id,goal:'请确认蓝色水杯在画面中的位置。',task:{target:'蓝色水杯',remember:false,reference_appearance:''}})});result.qwen={status:response.status,durationMs:performance.now()-started,...await response.json()};}
   local.close();return result;
  },process.env.YOLO_LIVE_QWEN==='1');
  assert.equal(result.ready,true,JSON.stringify(result));assert.equal(result.isolated,true);assert.equal(result.labels,80);
  assert.ok(result.runs.every(run=>run.detections.some(d=>d.label==='cup')&&run.detections.some(d=>d.label==='laptop')));
  assert.equal(result.captures>=2,true);
  if(process.env.YOLO_LIVE_QWEN==='1'){assert.equal(result.qwen.status,200,JSON.stringify(result.qwen));assert.equal(result.qwen.frame_received,true);assert.equal(result.qwen.target_visible,true);}
  await fs.mkdir('output/yolo',{recursive:true});await fs.writeFile('output/yolo/'+(process.env.YOLO_TEST_URL?'live-benchmark.json':'browser-benchmark.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ready:result.ready,threads:result.threads,labels:result.labels,frameMs:result.runs.map(run=>Math.round(run.latencyMs)),prepared:result.prepared,qwen:result.qwen},null,2));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
