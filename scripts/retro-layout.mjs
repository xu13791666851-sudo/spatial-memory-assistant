import {icon} from '../web/retro-design.mjs';
export function applyRetroLayout(js,template){
 template=template.replace('</head>','<link rel="stylesheet" href="/static/retro-pixel.css"></head>').replace('content="#f6f7f2"','content="#fffbed"');
 template=template.replace('<main class="unified-app">','<main class="unified-app pixel-frame">').replace('<span aria-hidden="true" class="brand-mark">忆</span>',`<span aria-hidden="true" class="brand-mark">${icon('logo')}</span>`);
 template=template.replace('>记录</button></div></header>',`>${icon('records')}<span>记录</span></button></div></header>`);
 const scene=template.match(/<label class="scene-picker">[\s\S]*?<\/label>/)?.[0];
 if(!scene)throw Error('Missing current place selector');
 template=template.replace(scene,'');
 template=template.replace('<div class="unified-status"><span id="input-source">手机摄像头 · 按需识别</span>',`<div id="unified-status" class="unified-status">${icon('mic')}<span id="input-source"><span id="source-label">手机摄像头 · 尚未开始</span></span>${icon('wave','voice-wave')}`);
 template=template.replace('<h2>周围的画面</h2>','<h2 class="sr-only">周围的画面</h2>');
 template=template.replace('aria-pressed="false">放大画面</button>',`aria-pressed="false">${icon('zoom')}<span>放大画面</span></button>`);
 template=template.replace('<h2 id="answer-title">小忆</h2>',`<h2 id="answer-title">${icon('logo')}<span>小忆</span></h2>`);
 template=template.replace('>展开全文</button>',`><span>展开全文</span>${icon('chevron')}</button>`);
 template=template.replace('>用文字交流</summary>',`>${icon('text')}<span>用文字交流</span></summary>`);
 template=template.replace('<div id="camera-empty">','<div id="camera-empty"><button id="camera-start-target" type="button" aria-label="开启摄像头和语音对话"></button>');
 // Advanced controls remain available in Aa; leave the primary header uncluttered.
 const start=template.indexOf('<details id="more-tools"'),end=template.indexOf('</main>',start);
 if(start<0||end<0)throw Error('Missing advanced controls');
 const more=template.slice(start,end).trim().replace('<summary>更多</summary>','<summary>更多选项</summary>');
 template=template.slice(0,start)+template.slice(end);
 template=template.replace('<div class="preferences">',`<section class="place-settings"><h3>当前场景</h3>${scene}</section>`+more+'<div class="preferences">');
 template=template.replace('<div class="sheet-handle" aria-hidden="true"></div>','');
 template=template.replace('<div class="records-task">','<div class="records-task sr-only">');
 template=template.replace('<div class="chat-heading">','<details class="record-history"><summary>历史对话与管理</summary><div class="chat-heading">');
 template=template.replace('<div id="chat-empty">','</details><div id="chat-empty">');
 template=template.replace('<footer class="records-footer"><span>关闭后继续当前任务</span>',`<footer class="records-footer"><button id="pixel-records-home" type="button">${icon('home')}<span>回到首页</span></button>`);
 js="import {installRetroSkin} from './retro-design.mjs';\n"+js;
 js=js.replace('function cameraUI(){',"function cameraUI(){\n $('camera-start-target').hidden=!!cameraStream||videoOpening;$('camera-start-target').disabled=videoOpening;");
 const marker='new MutationObserver(()=>$(\'dialogue-state\')';
 if(!js.includes(marker))throw Error('Missing installed homepage marker');
 js=js.replace(marker,"installRetroSkin({document,state:()=>({active:sessionActive(),ready,paused})});$('pixel-records-home').onclick=()=>unifiedHome.close();\n$('camera-start-target').onclick=async()=>{if(cameraStream||videoOpening)return;try{if(paused){await $('pause').onclick();if(paused||!ready)return;}await startVideo();}catch(err){notify(err.message);}};\n"+marker);
 return {js,template};
}
