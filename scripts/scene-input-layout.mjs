import {icon} from '../web/retro-design.mjs';
export function applySceneInputLayout(js,template){
 const section=template.match(/<section class="place-settings">[\s\S]*?<\/section>/)?.[0];
 const picker=section?.match(/<label class="scene-picker">[\s\S]*?<\/label>/)?.[0];
 if(!picker)throw Error('Scene selector missing');
 const homePicker=picker.replace('id="place-mode"','id="place-mode" aria-describedby="scene-voice-help"').replace('>家</option>','>家中场景</option>');
 template=template.replace(section,'').replace(icon('wave','voice-wave')+'</div>',icon('wave','voice-wave')+homePicker+'<span id="scene-voice-help" class="sr-only">开启语音后，也可以说我在家或我出门了切换场景。</span></div>');
 const textTools=template.match(/<details id="text-tools"[\s\S]*?<\/details>/)?.[0];
 if(!textTools)throw Error('Text entry missing');
 template=template.replace(textTools,`<details id="text-tools" class="disclosure"><summary aria-haspopup="dialog" aria-controls="text-composer">${icon('text')}<span>文字输入</span></summary></details>`);
 const composer=`<dialog id="text-composer" aria-labelledby="text-composer-title"><header class="composer-heading"><h2 id="text-composer-title">文字输入</h2><button id="text-composer-close" type="button" aria-label="收起文字输入">收起</button></header><p id="composer-hint">输入问题或记忆指令，和语音共用当前对话。</p><form id="chat-form"><label class="sr-only" for="message">输入你想说的话</label><textarea id="message" autocomplete="off" rows="2" maxlength="400" enterkeyhint="send" placeholder="例如：找水杯，或记住钥匙的位置" aria-describedby="composer-hint composer-status"></textarea><div class="composer-send-row"><span id="composer-status" role="status" aria-live="polite"></span><button id="text-send" type="submit" class="primary" disabled>发送</button></div></form></dialog>`;
 template=template.replace('<dialog id="records-dialog"',composer+'<dialog id="records-dialog"');
 js="import {installTextComposer} from './text-composer.mjs';\nimport {placeIntent} from './context.mjs';\n"+js;
 const oldSend=js.match(/async function sendText\(text\)\{[^\n]*/)?.[0];
 if(!oldSend)throw Error('Text sender missing');
 js=js.replace(oldSend,`async function sendText(text){
 text=String(text).trim();if(!text)return false;
 const command=interfaceCommand(text);if(command&&(!['confirm','cancel-confirmation'].includes(command.type)||pending)){bubble(text,true);unifiedHome.command(command);return true;}
 const requestedPlace=placeIntent(text);if(requestedPlace){bubble(text,true);const result=runtime.setPlace(requestedPlace);syncPlace(result.place);renderPending(null);if(!socket)localAnswer(result.answer);return true;}
 await runtime.loaded;if(paused){notify('对话已暂停，请先恢复。');return false;}
 if(!ready&&configured&&!await startVoice({greet:false}))return false;
 bubble(text,true);if(ready)wsSend({type:'text',text});else applyResult(await api('/api/command',{sid,text}));return true;
}`);
 const oldSubmit=js.match(/\$\('chat-form'\)\.addEventListener\('submit',async e=>\{[^\n]*/)?.[0];
 if(!oldSubmit)throw Error('Previous text submission missing');
 js=js.replace(oldSubmit,'');
 const oldViewport=js.match(/const viewport=window.visualViewport;[^\n]*/)?.[0];
 if(!oldViewport)throw Error('Previous viewport binding missing');
 js=js.replace(oldViewport,"const textComposer=installTextComposer({document,window,send:sendText,state:()=>({paused})});");
 return {js,template};
}
