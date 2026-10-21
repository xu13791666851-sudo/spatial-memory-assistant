// Shared SVG artwork. The website and exported SVG use these exact components.
export const colors={paper:'#fffbed',ink:'#0c1c50',blue:'#1552e8',pale:'#dff0ff',peach:'#ffe1c7',line:'#88b0ed',muted:'#62728e'};
export const stepPath=(w,h,s=4)=>`M ${s*3} 1 H ${w-s*3} V ${s} H ${w-s*2} V ${s*2} H ${w-1} V ${h-s*2} H ${w-s*2} V ${h-s} H ${w-s*3} V ${h-1} H ${s*3} V ${h-s} H ${s*2} V ${h-s*2} H 1 V ${s*2} H ${s*2} V ${s} H ${s*3} Z`;
export function frameSvg(fill=colors.paper,stroke=colors.ink){return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M9 1H23V4H27V8H31V24H27V28H23V31H9V28H5V24H1V8H5V4H9Z" fill="${fill}" stroke="${stroke}" stroke-width="3" shape-rendering="crispEdges"/></svg>`;}
const parts={
 logo:'<path fill="#1552e8" d="M7 1h10v3h4v4h3v9h-3v4h-4v3H7v-3H3v-4H0V8h3V4h4z"/><path fill="#fffbed" d="M8 5h8v3h4v9h-4v3H8v-3H4V8h4z"/><path fill="#0c1c50" d="M8 8h9v9H8z"/><path fill="#ffbc8c" d="M17 1h3v4h-3zM0 13h3v4H0zM17 21h4v3h-4z"/>',
 mic:'<rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
 records:'<path d="M5 2h11l4 4v16H4V2h1zm10 0v5h5M8 11h8M8 15h8M8 19h5"/>',
 replay:'<path d="M5 8a8 8 0 1 1-1 8M5 3v6h6"/>',
 play:'<path d="m8 4 12 8-12 8z" fill="currentColor" stroke="none"/>',
 pause:'<rect x="5" y="3" width="5" height="18" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="3" width="5" height="18" rx="1" fill="currentColor" stroke="none"/>',
 stop:'<rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor" stroke="none"/>',
 home:'<path d="m2 11 10-9 10 9-3 1v10h-5v-7h-4v7H5V12z" fill="currentColor" stroke="none"/>',
 zoom:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M10 7v6M7 10h6"/>',
 chevron:'<path d="m5 9 7 7 7-7"/>',
 text:'<path d="M3 5h18M12 5v16M8 21h8"/>',
 wave:'<path d="M3 11v3M8 7v11M13 3v19M18 6v13M23 10v5"/>'
};
export function icon(name,extra=''){return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="pixel-icon ${extra}" aria-hidden="true" focusable="false" fill="none" stroke="${name==='logo'?'none':'currentColor'}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${parts[name]||parts.logo}</svg>`;}
// Draw the wordmark in local vector pixels so it never depends on a web font.
export function wordmark(){
 const glyphs={I:['11111','00100','00100','00100','00100','00100','11111'],S:['01111','10000','10000','01110','00001','00001','11110'],E:['11111','10000','10000','11110','10000','10000','11111'],Y:['10001','10001','01010','00100','00100','00100','00100'],O:['01110','10001','10001','10001','10001','10001','01110'],U:['10001','10001','10001','10001','10001','10001','01110']};
 let x=0,path='';
 for(const letter of 'I SEE YOU'){
  if(letter===' '){x+=4;continue;}
  glyphs[letter].forEach((row,y)=>Array.from(row).forEach((pixel,col)=>{if(pixel==='1')path+=`M${x+col} ${y}h1v1h-1z`;}));x+=6;
 }
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x-1} 7" class="pixel-wordmark-art" aria-hidden="true" focusable="false" fill="currentColor" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
}
export function installRetroSkin({document,state}){
 const $=id=>document.getElementById(id);
 const label=(el,name,text)=>{if(!el)return;const key=name+'|'+text;if(el.dataset.pixelLabel===key&&el.querySelector('.pixel-icon')&&el.textContent===text)return;el.dataset.pixelLabel=key;el.innerHTML=icon(name)+`<span>${text}</span>`;};
 label($('replay'),'replay','重听');label($('end-conversation'),'stop','结束');
 const update=()=>{const s=state(),text=s.active?(s.ready?(s.paused?'继续':'暂停'):'取消开启'):'开始';label($('main-toggle'),s.active&&s.ready&&!s.paused?'pause':'play',text);const status=s.active?(s.paused?'已暂停':s.ready?'正在聆听':'正在连接'):'尚未开始';$('source-label').textContent=(s.source||'手机摄像头')+' · '+status;$('unified-status').classList.toggle('is-listening',s.ready&&!s.paused);};
 const observer=new MutationObserver(update);for(const id of ['main-toggle','voice-state','connection'])observer.observe($(id),{childList:true,subtree:true,characterData:true});update();
 // Keep the descriptive accessible name supplied by the conversation component.
 const decorate=()=>{for(const el of document.querySelectorAll('.message-replay'))label(el,'play','重听');};
 new MutationObserver(decorate).observe($('chat'),{childList:true,subtree:true});decorate();
}
