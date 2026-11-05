# 文档导航

先看[项目首页](../README.md)，确认要使用基础网页、完整网页演示还是安卓测试包。三种入口的运行方式不同。

| 主题 | 文档 |
| --- | --- |
| 完整手机摄像头演示、运行与打包 | [完整演示](hackathon-web-demo.md) |
| 安卓原生应用、YOLO、语音与 ESP32 | [安卓说明](../android/README.md) |
| 已上线基础网页的发布 | [Cloudflare 部署](cloudflare-deployment.md) |
| 产品故事、无障碍交互与软硬件规划 | [统一交互方案](unified-accessibility-plan.md) |
| 像素界面和 SVG 图稿 | [像素界面](retro-pixel-ui.md) · [图稿目录](../designs/) |
| 早期 YOLO 网页测试的技术记录 | [YOLO + 千问测试](yolo-qwen-preview.md) |
| 早期各版变更和实验记录 | [历史首页说明](history/README-2026-10-21.md) |

## 版本与分支

- `main` 是唯一的当前整合版本；提交作品或查看现有代码以它为准。
- 新开发从 `main` 建短期测试分支，完成检查后合回 `main`。避免把一个旧测试分支长期当作下一版的基础。
- 旧分支和早期文档用于追溯，不表示其中的页面仍在正式站运行。正式网页、完整网页演示和安卓包应分别验证。
- Android、Cloudflare 和完整网页演示使用不同发布方式。合并代码不等于各个平台已经重新部署。
