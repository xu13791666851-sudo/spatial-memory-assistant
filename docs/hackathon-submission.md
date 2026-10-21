# 黑客松 ZIP 提交材料

选择 ZIP 提交时，可以把源码、安装包、封面、界面图与实践材料放入一个中文目录的作品包。不需要同时拥有魔搭创空间。截图列出的实物照片、演示视频/GIF 等属于“可包含”的材料，不能仅据截图认定全部必交；登录后的其他必填项和文件大小限制仍以实际表单为准。

## 生成材料包

先运行 `npm run build:demo`，再运行：

```sh
python scripts/package-submission.py --materials-root /path/to/verified-output --output /path/to/submission
```

`materials-root` 指向已核对的外部材料目录，需要以下文件：

- `hackathon-submission/作品封面-1920x1080.png` 和 `build_cover.py`
- `android-native-test/I-SEE-YOU-Android-0.5.1.apk`、`verification-0.5.1.json` 及两张已有安卓截图
- `hackathon-web-demo/找物验证画面.png`、`demo-browser-report.json`
- `iseeyou-film/references/hardware.png`（仅作为佩戴概念参考）

仓库输出目录还需要 `output/playwright/demo-yolo-boxes.png`，来自当前网页识别框检查。截图缺少时应先实际运行并获取，不用设计图替代实测截图。

脚本核对安卓包及模型摘要、执行网页检查，并生成下列中文目录：

1. 作品介绍
2. 作品封面
3. 产品界面与设计源文件
4. 安卓安装包
5. 项目源码
6. 硬件方案与固件
7. AI 实践与验证
8. 演示与操作说明
9. 版本与文件清单

根目录提供中文阅读说明及可离线打开的 HTML 导览。源码内部文件名和相对路径保持不变；中文目录及说明便于评审阅读，不是截图中规定的固定命名模板。

## 当前材料边界

- 包含网页及安卓源码、YOLO 原模型、安卓 0.5.1 APK、ESP32 固件、封面、SVG 设计源文件、运行截图、提示词、工具定义和检查记录。
- 运行截图明确区分受控样本图片、模拟器和早期设计稿；概念封面及佩戴参考不冒充实物照片。
- 尚缺最新版完整操作录像与实体硬件实拍。提供录制提纲，不能将其当成已完成的视频。
- 完整三样本网页流程尚无独立托管网址；现有基础网页与浏览器 YOLO 测试页的范围见 [README](../README.md)。
- 团队信息及其他报名必填项需要在实际报名表填写，包中不虚构成员资料。

完整网页运行要求与验证范围见 [演示说明](hackathon-web-demo.md)，安卓及硬件说明见 [安卓文档](../android/README.md)。
