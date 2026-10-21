import fs from 'node:fs/promises';
// Build the normal UI first. Keep its HTML, styles and accessibility controls.
await import('./build-netlify.mjs');
const site='.demo-site';
await fs.mkdir(site+'/static',{recursive:true});
const names=(await fs.readdir('dist/static')).filter(name=>/\.(css|mjs|svg)$/.test(name));
for(const name of names)await fs.copyFile('dist/static/'+name,site+'/static/'+name);
await fs.copyFile('web/android-home.mjs',site+'/static/android-home.mjs');
await fs.writeFile(site+'/static/native-labels.mjs','export const labels='+await fs.readFile('models/yolo/labels.json','utf8')+';\nexport const aliases='+await fs.readFile('models/yolo/aliases.json','utf8')+';\n');
await fs.writeFile(site+'/static/android-home.css',`#native-preview{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}#native-preview[hidden]{display:none!important}#native-hardware-status{overflow-wrap:anywhere}#wake-toggle{display:none}#camera-preview>.memory-target-overlay{z-index:2}.native-record-tools{display:flex;align-items:center;gap:10px;padding:0 4px 8px;flex-wrap:wrap}.native-record-tools #open-accessibility,.native-record-tools #text-tools summary{min-height:44px;font-size:15px;padding:8px 12px;margin:0;display:flex;align-items:center;justify-content:center;gap:6px}.native-record-tools #text-tools{margin:0}.native-record-tools .pixel-icon{width:18px;height:18px}`);
let html=await fs.readFile('dist/video/index.html','utf8');
html=html.replace('<script src="/static/video-stream.js"></script><script type="module" src="/static/app.js"></script>','<script type="module" src="/static/android-home.mjs"></script>');
html=html.replace('</head>','<link rel="stylesheet" href="/static/android-home.css"></head>');
// Keep the exact camera-first homepage. Native hardware/audio and text entry
// remain reachable inside Records rather than the now-hidden legacy header.
const move=pattern=>{const markup=html.match(pattern)?.[0];if(!markup)throw Error('Missing native records control: '+pattern);html=html.replace(markup,'');return markup;};
const settings=move(/<button id="open-accessibility"[^>]*>[\s\S]*?<\/button>/).replace('>Aa</button>','>声音与硬件</button>');
const text=move(/<details id="text-tools"[\s\S]*?<\/details>/);
html=html.replace('<div class="record-tabs"',`<div class="native-record-tools">${settings}${text}</div><div class="record-tabs"`);
html=html.replace('千问密钥由管理员保存在 Netlify 后台，不会发送到网页。','千问通过独立测试后台连接，安装包不含长期密钥。');
html=html.replace('公网版使用浏览器实时通话。实际千问连接、摄像头及 iPhone 体验仍需真机验证；NFC 和房间定位尚未接入。','安卓测试版使用本机 YOLO、三次外观样本记忆、千问语音与图片复核；硬件需要同一局域网。');
html=html.replace('<summary>语音唤醒入口</summary>','<summary>语音交互说明</summary>').replace('先启用，再说“小忆”开始观察。','开始后可以直接说“帮我找水杯”“记住水杯”“拿到了”。').replace(/仅在网页保持打开时工作。[\s\S]*?不支持时可直接点击“开始对话”。/,'开始后由安卓麦克风持续接收语音，离开应用会停止识别和录音。');
const hardware=`<details class="disclosure"><summary>摄像头与硬件</summary><label for="native-source">画面来源</label><select id="native-source"><option value="phone">手机摄像头</option><option value="esp32">ESP32 摄像头</option></select><button id="native-scan" type="button">扫描硬件</button><label for="native-devices">选择硬件</label><select id="native-devices"></select><label for="native-ssid">Wi-Fi 名称</label><input id="native-ssid" autocomplete="off"><label for="native-password">Wi-Fi 密码</label><input id="native-password" type="password" autocomplete="off"><button id="native-provision" type="button">给硬件配网</button><details><summary>手动连接</summary><label for="native-device-url">设备地址</label><input id="native-device-url" placeholder="http://192.168.1.50"><label for="native-stream-url">视频地址（可留空）</label><input id="native-stream-url" placeholder="http://192.168.1.50/stream"><label for="native-device-token">设备口令</label><input id="native-device-token" type="password"><label class="checkbox"><input id="native-legacy" type="checkbox">兼容 Arduino CameraWebServer</label><button id="native-connect" type="button">连接硬件</button></details><p id="native-hardware-status" role="status">尚未连接硬件，可先使用手机摄像头。</p></details>`;
html=html.replace('<div class="more-content">','<div class="more-content">'+hardware);
await fs.writeFile(site+'/index.html',html);
console.log('Web demo UI ready; Android native APK assets stay separate.');
