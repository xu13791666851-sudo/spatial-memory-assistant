// Export the real generated UI into editable SVG shapes/text. No production data
// or media connections are used: the photographic camera content is a fixture.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=process.cwd(),out=path.resolve(process.env.DESIGN_OUTPUT||'../../output/retro-pixel');await fs.mkdir(out,{recursive:true});await fs.mkdir(path.join(root,'designs'),{recursive:true});
 const {icon}=await import('../web/retro-design.mjs');const logo=icon('logo');
 const photo='data:image/jpeg;base64,'+(await fs.readFile('designs/desk-reference.jpg')).toString('base64');
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,timezoneId:'Asia/Shanghai'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='design.test')return r.abort();if(u.pathname==='/api/access')return r.fulfill({json:{configured:true,authenticated:true}});assert.ok(!u.pathname.startsWith('/api/'),'Unexpected model request');let body=await fs.readFile(path.join(root,'dist',u.pathname==='/'?'index.html':u.pathname),'utf8');if(u.pathname.endsWith('/app.js'))body+='\nwindow.design={runtime,conversation,unifiedHome,setActive:()=>{ready=true;paused=false;actionUI();}};';return r.fulfill({body,contentType:u.pathname.endsWith('.svg')?'image/svg+xml':u.pathname.endsWith('.css')?'text/css':/\.(js|mjs)$/.test(u.pathname)?'text/javascript':'text/html'});});
 await page.goto('https://design.test/');await page.waitForFunction(()=>!!window.design);await page.clock.setFixedTime(new Date('2026-10-19T06:20:00Z'));
 await page.evaluate(({photo})=>{
  const d=window.design;document.getElementById('screen-reader-mode').checked=true;d.runtime.taskState=()=>({target:'蓝色水杯'});d.setActive();
  d.conversation.add('帮我找蓝色水杯。',true);d.conversation.add('上次记在电脑左侧。我再看看现在的位置。');d.conversation.add('再看一下。',true);d.conversation.add('看到蓝色水杯，在电脑左侧、台灯旁边。');
  document.getElementById('latest-answer').textContent='看到蓝色水杯，在电脑左侧、台灯旁边。';
  const image=document.createElement('img');image.id='design-camera-photo';image.src=photo;image.alt='图稿示例摄像头画面';image.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:cover';document.getElementById('camera-preview').prepend(image);document.getElementById('camera-empty').hidden=true;
 },{photo});await page.evaluate(()=>document.getElementById('design-camera-photo').decode());
 await page.waitForFunction(()=>document.getElementById('main-toggle').textContent==='暂停');
 // More generous camera size in tall mobile views is also used by the live UI.
 await page.screenshot({path:path.join(out,'home.png')});
 async function vector(target){return page.evaluate(({selector,logo})=>{
  const ns='http://www.w3.org/2000/svg',defs=[],esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');let uid=0;
  const box=e=>e.getBoundingClientRect();
  const opaque=c=>c&&c!=='transparent'&&c!=='rgba(0, 0, 0, 0)';
   const pixel=(x,y,w,h,b,fill,stroke)=>{const s=Math.max(1,b/3),d=`M${x+s*3} ${y+1}H${x+w-s*3}V${y+s}H${x+w-s*2}V${y+s*2}H${x+w-1}V${y+h-s*2}H${x+w-s*2}V${y+h-s}H${x+w-s*3}V${y+h-1}H${x+s*3}V${y+h-s}H${x+s*2}V${y+h-s*2}H${x+1}V${y+s*2}H${x+s*2}V${y+s}H${x+s*3}Z`;return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${b/4}" shape-rendering="crispEdges"/>`;};
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  function text(node,s){
   ctx.font=`${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;const m=ctx.measureText('国'),asc=m.fontBoundingBoxAscent||parseFloat(s.fontSize)*.9,des=m.fontBoundingBoxDescent||parseFloat(s.fontSize)*.2;
   const lines=[];for(let i=0;i<node.textContent.length;i++){const ch=node.textContent[i];if(ch==='\n')continue;const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();if(!r.width||!r.height)continue;let line=lines.at(-1);if(!line||Math.abs(line.top-r.top)>.5){line={top:r.top,x:r.x,y:r.top+(r.height-asc-des)/2+asc,text:''};lines.push(line);}line.text+=ch;}
   return lines.map(l=>`<text x="${l.x}" y="${l.y}" fill="${esc(s.color)}" font-family="${esc(s.fontFamily)}" font-size="${s.fontSize}" font-weight="${s.fontWeight}" xml:space="preserve">${esc(l.text)}</text>`).join('');
  }
  function draw(el){
   const s=getComputedStyle(el),r=box(el);if(s.display==='none'||s.visibility==='hidden'||el.hidden||el.classList.contains('sr-only')||el.tagName==='VIDEO'||el.tagName==='AUDIO')return '';
   if(s.display==='contents')return Array.from(el.children).map(draw).join('');
   if(!r.width||!r.height||r.right<0||r.bottom<0||r.y>844)return '';
   if(el.namespaceURI===ns){const clone=el.cloneNode(true);clone.setAttribute('x',r.x);clone.setAttribute('y',r.y);clone.setAttribute('width',r.width);clone.setAttribute('height',r.height);clone.setAttribute('color',s.color);clone.removeAttribute('class');return new XMLSerializer().serializeToString(clone);}
   let bg='';const b=parseFloat(s.borderLeftWidth)||0,rx=parseFloat(s.borderTopLeftRadius)||0;
   if(s.borderImageSource.includes('retro-')){let fill=s.borderImageSource.includes('primary')?'#1552e8':s.borderImageSource.includes('task')?'#ffe1c7':s.borderImageSource.includes('card')?'#dff0ff':'#fffbed';bg=pixel(r.x,r.y,r.width,r.height,b,fill,'#0c1c50');}
   else if(opaque(s.backgroundColor)||b>0)bg=`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${rx}" fill="${opaque(s.backgroundColor)?s.backgroundColor:'none'}" stroke="${b?s.borderLeftColor:'none'}" stroke-width="${b}"/>`;
   if(el.tagName==='IMG')bg+=`<image href="${esc(el.src)}" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" preserveAspectRatio="xMidYMid slice"/>`;
   if(el.classList.contains('chat-speaker')&&el.closest('.assistant'))bg+=logo.replace('<svg ',`<svg x="${r.x}" y="${r.y+1}" width="14" height="14" `);
   let content='';let children=Array.from(el.childNodes);
   if(el.tagName==='DETAILS'&&!el.open)children=children.filter(c=>c.nodeType===1&&c.tagName==='SUMMARY');
   children.sort((a,b)=>(a.nodeType===1?parseInt(getComputedStyle(a).zIndex)||0:0)-(b.nodeType===1?parseInt(getComputedStyle(b).zIndex)||0:0));
   for(const child of children){if(child.nodeType===3)content+=text(child,s);else if(child.nodeType===1)content+=draw(child);}
   // CSS-generated disclosure triangles are vectorised explicitly.
   if(el.tagName==='SUMMARY'&&el.parentElement.classList.contains('record-history'))content=`<path d="M${r.right-126} ${r.y+9}l4 3-4 3z" fill="${s.color}"/>`+content;
   if(['hidden','auto','scroll'].includes(s.overflowY)||s.overflow==='hidden'){const id='clip'+(++uid);defs.push(`<clipPath id="${id}"><rect x="${r.x+b}" y="${r.y+b}" width="${Math.max(0,r.width-2*b)}" height="${Math.max(0,r.height-2*b)}" rx="${rx}"/></clipPath>`);content=`<g clip-path="url(#${id})">${content}</g>`;}
   return `<g${Number(s.opacity)<1?` opacity="${s.opacity}"`:''}>${bg}${content}</g>`;
  }
  const art=draw(document.querySelector(selector));return {art,defs:defs.join('')};
 },{selector:target,logo});}
 const home=await vector('main');await page.getByRole('button',{name:'记录',exact:true}).click();await page.locator('#chat').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(out,'records.png')});const records=await vector('#records-dialog');
 const wrap=(part,title)=>`<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844" role="img" aria-label="${title}"><title>${title}</title><defs>${part.defs}</defs><rect width="390" height="844" fill="#fffdf5"/>${part.art}</svg>`;
 await fs.writeFile(path.join(root,'designs/retro-pixel-home.svg'),wrap(home,'小忆复古像素首页'));
 await fs.writeFile(path.join(root,'designs/retro-pixel-records.svg'),wrap(records,'小忆复古像素对话记录'));
 // Prefix clip IDs to keep each screen independently editable inside the board.
 const rename=(s,p)=>s.replace(/clip(\d+)/g,p+'clip$1');
 const board=`<svg xmlns="http://www.w3.org/2000/svg" width="846" height="920" viewBox="0 0 846 920" role="img" aria-label="小忆复古像素界面稿"><title>小忆复古像素界面稿 · 与测试版4共用SVG组件</title><desc>左侧首页，右侧对话记录。全部文字与界面边框是可编辑矢量；摄像头图像为嵌入的示例照片。</desc><defs>${rename(home.defs,'home')}${rename(records.defs,'records')}</defs><rect width="846" height="920" fill="#fffdf5"/><text x="423" y="29" text-anchor="middle" font-family="Microsoft YaHei,sans-serif" font-size="17" font-weight="700" fill="#0c1c50">04 / 复古像素 · SVG 界面稿</text><g transform="translate(18 52)">${rename(home.art,'home')}</g><g transform="translate(438 52)">${rename(records.art,'records')}</g></svg>`;
 await fs.writeFile(path.join(root,'designs/retro-pixel-ui.svg'),board);for(const name of ['retro-pixel-home.svg','retro-pixel-records.svg','retro-pixel-ui.svg'])await fs.copyFile(path.join(root,'designs',name),path.join(out,name));
 assert.deepEqual(errors,[]);console.log('SVG exported from actual frontend geometry: '+out);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
