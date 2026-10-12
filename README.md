# 空间记忆助手

面向视障用户的实验原型，包含“视频理解”和“语音记忆”两页。主要操作是“开始／结束”和“再听一遍”。视频页面支持实时画面输入与连续语音问答；记忆页面可以记录和查询用户明确提供的物品位置。

## 已有功能

- 接入千问 `qwen3.8-omni-flash-realtime`，连续语音问答与打断。
- 视频页面每秒发送一张画面，默认观察 30 秒，可选择 10 或 60 秒。结束或切换页面会关闭设备。
- 摄像头预览铺满内容区，保留完整画面。
- 物品记录保存在本机，区分历史位置与当前观察；新增、修改和删除需要确认。
- 同一 Wi-Fi 下的 iPhone HTTPS 测试入口，带访问码保护。

实际识别准确度、iPhone 读屏与不同设备上的连续语音体验仍需真机验证。NFC 真读取、房间地图、准确距离测量与自动发现目标提醒尚未实现。

## 电脑启动

需要 Python 3.11 或以上。

```bash
python -m pip install -r requirements.txt
python src/run.py
```

打开 `http://127.0.0.1:8765/video`。点击“更多 → 连接与声音设置”，填写自己的百炼业务空间 ID、对应地域和 API Key。密钥仅保存在当前程序运行的内存中，重启后需重新填写。

也可以先在语音记忆页面的文字入口试用本地记录，例如“记住，钥匙刚放在玄关桌上”“钥匙在哪”。本地指令只识别有限表达，自由语音表达需要连接千问。

## iPhone 本地测试

```bash
python -m pip install -r requirements-mobile.txt
python src/run_mobile.py --host 你的电脑WiFi的IPv4地址
```

手机与电脑须在同一 Wi-Fi。启动窗口显示手机设置入口、实际 HTTPS 网页和六位访问码；`outputs/手机访问/` 中生成二维码及说明网页。

在 iPhone Safari 打开设置入口，按说明安装并手动信任本地测试证书，然后打开 HTTPS 网页并输入访问码。证书安装与信任必须由设备所有者自己完成。测试后可移除描述文件。电脑上的原有入口仍可独立运行。

证书只覆盖指定的局域网 IP，有效期 30 天。根证书的签发私钥不会保存。手机服务只有配对后才能访问配置、记忆或语音通道。网络隔离或防火墙可能阻止局域网连接；程序不会修改系统防火墙或证书信任。

## 检查

```bash
python -m pip install -r requirements-mobile.txt
cd src
python -m unittest tests test_video test_mobile -q
node test_video_frontend.cjs
```

测试使用模拟千问连接，不产生模型费用，也不能替代真实设备和云端测试。

## Netlify 公网访问

仓库新增了适合 Netlify 的构建与连接适配。导入本仓库后，使用构建命令 `node scripts/build-netlify.mjs`、发布目录 `dist`、函数目录 `netlify/functions`。也可以直接采用 `netlify.toml` 中的配置。

公网版本沿用原来的两页界面，使用浏览器 WebRTC 与千问持续通话，Netlify 函数仅负责连接时的 SDP 转发，不承接长期 WebSocket。每位访问者自己填写密钥，密钥只在当前页面内存中保留，连接时经本站函数用于千问鉴权；程序不保存或打印密钥。刷新或关闭页面后需重新填写。视频采用低帧率媒体轨道，而不是原来本地版的 JPEG WebSocket 上传；观察时间仍受页面与连接控制限制。

物品记忆保存在当前浏览器，不与电脑 SQLite 数据库同步，也不与其他访问者共享。只有查询时才把相关记录提供给千问；保存和删除仍需确认。iPhone 使用 Safari 打开 Netlify 的 HTTPS 地址后，无须安装本地测试证书。

```bash
node scripts/build-netlify.mjs
node --test tests/web.test.mjs
```

浏览器媒体权限、网络到千问的连通性及模型准确度仍须实际设备验证。Netlify 和百炼的用量及额度以各自控制台为准。

## GitHub 与其他托管方式

GitHub 仓库用于保存和分享程序。GitHub Pages 只能托管静态网页，不能运行本项目的 Python 后端和实时语音转发服务，因此仅上传代码不会得到完整可用的在线语音视频产品。

原始 Python 后端如需部署到其他平台，需要支持 HTTPS、WebSocket 和访问保护的服务器；不能直接把本机测试服务公开到互联网。上述 Netlify 适配采用不同的连接方式，并保持访问者的密钥和记忆彼此隔离。

仓库不包含真实 API Key、个人物品记录、私人截图、访问码或本地服务器证书。

参考：[千问实时音视频接口](https://help.aliyun.com/zh/model-studio/realtime)、[Apple 本地证书信任说明](https://support.apple.com/zh-cn/102390)。
