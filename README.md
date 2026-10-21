# I SEE YOU · 空间记忆助手

**看见日常，也看见你。**

I SEE YOU 面向视障用户，把摄像头画面、语音对话和物品记忆连接起来。用户可以询问眼前有什么、记住物品，再用过去的记录作为寻找线索。它会区分“上次记录的位置”和“这次画面确认的位置”。[了解产品故事与无障碍方案](docs/unified-accessibility-plan.md)。

看和听是不同的感官，却可以一起回答“它在哪里”。声音引导观察，画面回应询问，记忆连接起一次次对话。“I SEE YOU”也意味着看见每个人具体的需要：有人想听一句提示，有人想放大画面，有人想回看昨天的记录。我们希望把选择权留给用户。

## 从哪里开始

| 你想做什么 | 入口 | 当前状态 |
| --- | --- | --- |
| 直接打开已上线的基础网页 | [I SEE YOU 网页](https://i-see-you-spatial-memory.pages.dev/video/) | 手机或电脑浏览器可访问；使用浏览器保存记录 |
| 查看完整手机摄像头演示 | [演示说明](docs/hackathon-web-demo.md) | 源码和打包流程已在 `main`；需要支持 Python 的服务单独部署，**上方网址不是这个完整演示** |
| 获取安卓测试包 | [安卓说明](android/README.md) · [最近的构建记录](https://github.com/xu13791666851-sudo/spatial-memory-assistant/actions/workflows/android-test.yml) | 构建记录提供有期限的安装包；安卓真机麦克风和实体 ESP32 尚待验证 |
| 查看设计与部署资料 | [文档目录](docs/README.md) | 图稿、测试说明、平台配置和历史记录集中在这里 |

完整网页演示用手机摄像头、后台 YOLO、三次外观样本和千问核对完成记忆与找物；安卓测试包则在手机本机运行 YOLO，并保留 ESP32 配网与画面来源切换。两者界面接近，但运行方式和数据存储不同，记录不会自动同步。网页演示的硬件部分独立展示。

## 仓库里的内容

| 目录 | 用途 |
| --- | --- |
| `web/`、`cloudflare/`、`netlify/` | 基础网页及其线上服务；Cloudflare 为当前正式入口，Netlify 为旧部署 |
| `demo/` | 完整手机摄像头网页演示的后台 |
| `android/` | 安卓原生应用、测试和 ESP32 固件 |
| `models/yolo/` | 网页演示和安卓构建使用的原始模型与标签 |
| `src/` | 早期本地 Python 原型，仍可独立运行 |
| `designs/`、`docs/` | 界面图稿、产品方案、部署说明与历史记录 |
| `scripts/`、`tests/` | 构建、打包和检查 |

主分支是当前整合版本。旧测试分支留作历史快照；新改动应从 `main` 开始，经过检查后再合回 `main`。详见[维护说明](docs/README.md#版本与分支)。

## 本地运行完整网页演示

需要 Node.js 22 和 Python 3.11。千问长期密钥仅放在服务器环境变量 `QWEN_API_KEY`，不要写入网页、安装包或仓库。

```sh
npm ci
npm run build:demo
python -m pip install -r demo/requirements.txt
python -m uvicorn demo.server:app --host 0.0.0.0 --port 7860
```

电脑打开 `http://127.0.0.1:7860/`。手机摄像头和麦克风需要可访问的 HTTPS 地址；部署步骤见[完整演示说明](docs/hackathon-web-demo.md)。安卓构建与硬件步骤见[安卓说明](android/README.md)。基础网页的发布方式见[Cloudflare 部署说明](docs/cloudflare-deployment.md)。

## 验证范围

网页和安卓均有自动构建与检查：[完整网页演示](https://github.com/xu13791666851-sudo/spatial-memory-assistant/actions/workflows/web-demo.yml) · [安卓测试包](https://github.com/xu13791666851-sudo/spatial-memory-assistant/actions/workflows/android-test.yml)。自动检查不能代替 iPhone、安卓真机、真实物品识别和 ESP32 实物验收。

此前各测试版的详细记录保存在[历史首页说明](docs/history/README-2026-10-21.md)，仅供追溯；当前入口和状态以本页及对应专项文档为准。
