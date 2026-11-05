import {text} from './util.mjs';
export function parseIntent(raw,focus=null){
 const s=text(raw,600,false).replace(/[。！？!?]+$/,'').trim().replace(/^(?:请问|我想问一下|我想知道|帮我看看|帮我看一下)[，,\s]*/, '');
 const target=v=>{const n=v.trim().replace(/^(?:我的|这个|那个|这只|那只|这件|那件|另一个|另一只|另一件|一个|一只)/,'').replace(/的$/,'');return ['它','他','她','这个','那个','这件','那件',''].includes(n)?focus:n;};
 // Common follow-ups stay local even when the online intent service is unavailable.
 const follow=s.replace(/^(?:(?:可以|好的|好|哦|嗯)[，,。\s]*)+/,'').replace(/^你[，,\s]*/,'');
 if(/^(?:在哪(?:里|儿)?|放哪(?:里|儿)?)(?:呀|啊|呢)?(?:[，,。？?\s]*告诉我)?$/.test(follow))return {action:'history',target:focus};
 if(/^(?:看一下|看看|看一看|再看一下|再看下|现在呢|这样呢)$/.test(follow))return {action:'find',target:focus};
 if(/^(?:现在)?(?:帮我)?找(?:一下)?$/.test(follow))return {action:'find',target:focus};
 const savedCheck=/^(?:你)?(?:有没有|是否)(?:记住|记得|保存)(.{1,40})$/.exec(follow);
 if(savedCheck)return {action:'check',target:target(savedCheck[1])};
 const present=/(?:有没有|是否有|是否还在|还在不在)/.exec(follow);
 if(present){
  const tail=follow.slice(present.index+present[0].length).replace(/^(?:之前说过的|之前记住的|上次记住的|刚才说的|我的|那个|这个)+/,'').replace(/(?:吗|呢|呀|啊)$/,'').trim();
  return {action:'find',target:target(tail)};
 }
 if(/^(?:嗯+|啊+|哦+|好的?|好吧|谢谢|我操|卧槽|唉|呃+|知道了)$/.test(s))return {action:'ignore'};
 if(/^(?:你(?:能)?|现在)?看(?:到|见)(?:了)?(?:什么|哪些|啥)|^(?:还有什么|还有呢|再详细说说|说详细一点)$/.test(s))return {action:'describe',question:s};
 if(/^(取消|不用找了|别找了|停止找物|关闭摄像头)$/.test(s))return {action:'cancel'};
 if(/^(拿到了|找到了|已经拿到|结束寻找)$/.test(s))return {action:'complete'};
 if(/^(不对|不是这个|不是它|这不是我的)$/.test(s))return {action:'reject'};
 if(/^(继续找|再看一下|再看下|现在呢|这样呢|没找到|没有看到)$/.test(s))return {action:'continue'};
 if(/^(就是它|就是这个)$/.test(s))return {action:'accept'};
 let m=/^(?:它是|特征是|颜色是)(.{1,120})$/.exec(s);if(m)return {action:'features',description:m[1]};
 if(/(?:桌子?上(?:面)?|桌面上|面前|眼前|周围|当前画面|画面里|这里|镜头里|前面).*(?:有什么|有哪些|有啥|是什么|看到了什么)/.test(s)||/^(?:描述|介绍|说说|看看).*(?:画面|场景|周围|桌面)/.test(s)||/^(?:这|那|你看见的).*(?:什么|颜色|形状|样子|几个|多少)/.test(s)||['这是什么','这是什么东西','看看周围'].includes(s))return {action:'describe',question:s};
 m=/^(?:你)?(?:还)?(?:记住|记得)(?:了)?(.{0,40}?)(?:了)?(?:吗|没有)$/.exec(s);if(m&&!/哪里|哪儿|在哪|放哪/.test(m[1]))return {action:'check',target:target(m[1])};
 m=/^(?:你知道|你记得|告诉我)?(.{1,40}?)(?:的外观是什么|的外观|的样子是什么|长什么样|是什么样子)(?:吗)?$/.exec(s);if(m)return {action:'appearance',target:target(m[1])};
 m=/^(?:查询|查看|查)?(.{1,40}?)(?:的位置历史|位置历史|的历史位置|上次放哪了|上次在哪里|上次在哪儿|上次在哪|以前放在哪里)$/.exec(s)||/^(?:我)?(?:之前|上次|以前)(?:的)?(.{1,40}?)(?:是)?(?:放在|放|在)?(?:哪里|哪儿|哪)(?:了|吗|了吗)?$/.exec(s)||/^(?:你)?(?:还)?(?:记住|记得|知道)(.{1,40}?)(?:是)?(?:放在|放|在)?(?:哪里|哪儿|哪)(?:了|吗|了吗)?$/.exec(s);if(m)return {action:'history',target:target(m[1].replace(/是$/,''))};
 m=/^第?([一二三四五六七八九十0-9]+)(?:件|个|只)?$/.exec(s);if(m)return {action:'select',index:/^\d+$/.test(m[1])?Number(m[1])-1:'一二三四五六七八九十'.indexOf(m[1])};
 const newIdentity=/另(?:一)?[件个只]|新增|新的一件|再记住一/.test(s);const clean=s.replace(/^现在/,'').replace(/^(?:(?:请|帮我|再|重新|再次))+/,'');
 m=/^(?:记住|记录)(.{1,40}?)(?:[，,]\s*(?:它|这[个件只])?|它)?(?:现在)?(?:的位置是|的位置在|放在|在)(.{1,600})$/.exec(clean);if(m&&!/可能|应该|好像|也许|大概|不确定/.test(s))return {action:'remember',target:target(m[1]),location:m[2],newIdentity};
 m=/^(?:记住|记录|保存|记一下|记下)(.{1,60}?)(?:的外观和位置|的样子和位置|外观和位置|的外观|的样子|的位置)?$/.exec(clean);if(m)return {action:'remember',target:target(m[1]),newIdentity};
 m=/^(?:把)?(.{1,40}?)(?:也)?(?:记住|保存下来|保存一下|记下来|存下来|存一下|记一下)$/.exec(clean);if(m)return {action:'remember',target:target(m[1]),newIdentity};
 m=/^(?:找(?:一下)?|寻找|看看)(.{1,40})$/.exec(clean);if(m)return {action:'find',target:target(m[1])};
 m=/^(.{1,40}?)(?:现在)?(?:在哪里|在哪儿|在哪|放哪了)(?:呀|啊|呢)?$/.exec(clean);if(m)return {action:/现在/.test(s)?'find':'history',target:target(m[1].replace(/现在$/,''))};
 return null;
}
export function validateSemantic(intent,raw,focus){
 if(!intent||!['find','remember','history','check','appearance','describe','continue','cancel','complete','select','hint','chat','clarify','ignore'].includes(intent.action))return null;
 if(['chat','clarify'].includes(intent.action)&&!(typeof intent.answer==='string'&&intent.answer.trim()&&intent.answer.length<=240&&!/已(?:经)?(?:记住|保存)|保存成功|记住了|我记得/.test(intent.answer)))return null;
 if(intent.action==='remember'&&!/记住|记录|记下|记一下|保存|存下|存一下/.test(raw))return null;
 if(['find','remember','history','check','appearance'].includes(intent.action)){if(typeof intent.target!=='string'||!intent.target.trim()||intent.target.length>40)return null;intent.target=intent.target.trim().replace(/^(?:(?:请|帮我|帮忙|麻烦你|把|这个|那个|这只|那只|这件|那件|我的))+/,'');if(['它','他','她','这个','那个',''].includes(intent.target))intent.target=focus;if(!intent.target)return null;}
 if(intent.location&&(!raw.includes(intent.location)||/可能|应该|好像|也许|大概|不确定/.test(raw)))delete intent.location;
 if(intent.newIdentity&&!/另|新增|新的一|再记住一/.test(raw))intent.newIdentity=false;
 return intent;
}
