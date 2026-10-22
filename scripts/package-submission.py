"""Build a Chinese-labelled submission from tracked sources and verified materials.

Keep program-relative names intact. Never include local credentials or memories.
Usage: python scripts/package-submission.py --materials-root PATH --output PATH
"""
import argparse
import hashlib
import html
import json
import re
import subprocess
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
APK_NAME = 'I-SEE-YOU-Android-0.5.1.apk'
APK_SHA = '160b4bc42431b0e940d558f478d8f501c9a81b6c323b704f076e1e26878d3d96'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build(materials, output, date):
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    source_paths = [p for p in subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0') if p]
    # Also supports checking this builder before its first commit.
    source_paths = sorted(set(source_paths + ['scripts/package-submission.py']))
    entries = {}

    def put(name, data):
        parts = PurePosixPath(name).parts
        assert name not in entries and '..' not in parts and not name.startswith('/'), name
        entries[name] = data

    def text(name, value):
        # BOM keeps Chinese text readable in older Windows text editors.
        put(name, value.strip().replace('\r\n', '\n').encode('utf-8-sig') + b'\n')

    def copy(name, source):
        put(name, source.read_bytes())

    apk = materials / 'android-native-test' / APK_NAME
    apk_bytes = apk.read_bytes()
    assert digest(apk_bytes) == APK_SHA, 'APK does not match verified 0.5.1 build'
    manifest = json.loads((ROOT / 'models/yolo/manifest.json').read_text(encoding='utf-8'))
    model = b''.join((ROOT / 'models/yolo' / p['file']).read_bytes() for p in manifest['parts'])
    assert digest(model) == manifest['sha256']
    with zipfile.ZipFile(apk) as inner:
        assert inner.testzip() is None
        assert digest(inner.read('assets/exp.tflite')) == manifest['sha256']

    for relative in source_paths:
        assert not re.search(r'(^|/)(\.git|node_modules|\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.demo-data|__pycache__|local\.properties|\.gradle)(/|$)', relative), relative
        copy('05_项目源码/' + relative, ROOT / relative)
    site = ROOT / '.demo-site'
    assert (site / 'static/demo-boxes.mjs').is_file(), 'Run npm run build:demo first'
    for p in sorted(site.rglob('*')):
        if p.is_file():
            copy('05_项目源码/.demo-site/' + p.relative_to(site).as_posix(), p)

    copy('02_作品封面/作品封面_1920x1080.png', materials / 'hackathon-submission/作品封面-1920x1080.png')
    copy('02_作品封面/封面绘制源文件.py', materials / 'hackathon-submission/build_cover.py')
    text('02_作品封面/封面说明.txt', '''
封面尺寸：1920×1080；格式：PNG。
这是一张产品概念封面，图中的杯子和识别框为说明性绘图，不是相机实测截图。
可将这张 PNG 单独上传到报名表的封面栏。
封面绘制源文件依赖 Python、Pillow 和 Windows 中文字体，默认输出到脚本所在目录。
''')
    shots = [
        ('01_网页找物核对_样本画面测试.png', materials / 'hackathon-web-demo/找物验证画面.png'),
        ('02_网页YOLO识别框_样本画面测试.png', ROOT / 'output/playwright/demo-yolo-boxes.png'),
        ('03_安卓运行画面_模拟器.png', materials / 'android-native-test/0.5.1-语音找物实测.png'),
        ('04_安卓摄像头菜单_模拟器.png', materials / 'android-native-test/0.5.0-三点菜单.png'),
    ]
    for name, p in shots:
        copy('03_产品界面与设计源文件/' + name, p)
    for name, original in [
        ('05_像素首页设计稿.svg', 'retro-pixel-home.svg'),
        ('06_像素记录页设计稿.svg', 'retro-pixel-records.svg'),
        ('07_像素界面总览设计稿.svg', 'retro-pixel-ui.svg'),
    ]:
        copy('03_产品界面与设计源文件/' + name, ROOT / 'designs' / original)
    text('03_产品界面与设计源文件/界面材料来源说明.txt', '''
01：此前完整网页流程检查截图，使用固定蓝杯图片作为摄像头测试输入，实际经过模型及千问核对。
02：当前网页识别框改动的浏览器运行截图。固定公交车图片作为测试相机输入，框与分数来自真实 YOLO 运算。
03：安卓 0.5.1 在模拟器中的运行截图，使用模拟器相机环境；不作为实体手机麦克风或 ESP32 实测证据。
04：安卓 0.5.0 摄像头菜单截图，仅用于展示硬件设置入口；0.5.1 沿用这套入口。
05—07：早期像素界面设计源文件，供查看设计过程。当前页面以运行截图和源码为准。
截图不是连续录像，也不是用户可佩戴设备的实物照片。
''')

    put('04_安卓安装包/I_SEE_YOU_安卓测试版_0.5.1.apk', apk_bytes)
    text('04_安卓安装包/安装与使用说明.txt', (ROOT / 'android/README.md').read_text(encoding='utf-8') + '\n\n本目录 APK 文件名已改为中文便于识别，文件内容与已验证的 0.5.1 原包完全相同。\niPhone 无法安装 APK。安卓 8 及以上，ARM64。\n')

    for p in sorted((ROOT / 'android/esp32-firmware').rglob('*')):
        if p.is_file():
            copy('06_硬件方案与固件/ESP32固件/' + p.relative_to(ROOT / 'android/esp32-firmware').as_posix(), p)
    copy('06_硬件方案与固件/佩戴方式概念参考_非实物照片.png', materials / 'iseeyou-film/references/hardware.png')
    text('06_硬件方案与固件/硬件说明.txt', '''
安卓应用已保留硬件连接、蓝牙配网、填写 2.4 GHz Wi-Fi 名称与密码、切换 ESP32 视频来源的代码入口。
完整固件在本目录 ESP32固件中；同一份源码也在 05_项目源码/android/esp32-firmware。
佩戴方式图片仅作工业设计概念参考，不作为已制造设备或已完成连接的证明。
当前材料没有实体 ESP32 配网、视频流与安卓真机联合运行的验收记录，也没有实物照片。
手机摄像头可独立演示；硬件需另行实测。网页演示不提供 iPhone 蓝牙配网功能。
''')

    android_check = json.loads((materials / 'android-native-test/verification-0.5.1.json').read_text(encoding='utf-8'))
    android_check['apk'] = '04_安卓安装包/I_SEE_YOU_安卓测试版_0.5.1.apk'
    put('07_AI实践与验证/安卓0.5.1历史检查记录.json', json.dumps(android_check, ensure_ascii=False, indent=2).encode())
    copy('07_AI实践与验证/网页真实流程历史检查记录.json', materials / 'hackathon-web-demo/demo-browser-report.json')
    check = subprocess.run(['python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'demo_test.py', '-v'], cwd=ROOT, capture_output=True, text=True)
    assert check.returncode == 0, 'Web checks failed'
    text('07_AI实践与验证/网页自动检查结果.txt', check.stdout + check.stderr)
    put('07_AI实践与验证/模型与安装包校验.json', json.dumps({
        '原始YOLO模型SHA256': manifest['sha256'], '安卓安装包SHA256': APK_SHA,
        '安卓包内模型与源码模型一致': True, '网页自动检查': '9项通过',
        '当前网页识别框浏览器检查': '真实模型检出并显示5个框，结束对话后相机与框清空',
        '真实iPhone验收': False, '真实安卓手机验收': False, '实体ESP32联合验收': False,
    }, ensure_ascii=False, indent=2).encode())
    text('07_AI实践与验证/AI使用与验证说明.txt', '''
产品中的 AI：
1. YOLO：从当前画面检出常见物品，输出类别、框和分数。类别框不能证明是用户记住的同一件物品。
2. 千问：处理语音、画面理解和候选外观复核。联网、服务配置和额度会影响使用。
3. 应用逻辑：收到用户明确记忆指令后采集实际样本，写入成功才给出保存回执；历史位置与当前画面分别说明。
4. 网页完整演示在后台使用原始模型，安卓在设备本机运行模型；两端记录不自动同步。

研发中的 AI：辅助梳理交互方案、编写与修改程序、整理提示词及排查问题。设计稿与封面用于表达产品方案；不代替真实功能验收。

本包附应用提示词、工具定义、源码、运行截图与检查记录，作为可核对的实践材料。
网页历史流程记录使用受控图片和音频输入，并经过真实模型与千问；不是 iPhone 真机报告。
当前网页9项自动检查使用替代云端回复检查程序行为，不能将它们当作新的在线千问验收。
安卓40项核心检查和8项模拟器检查来自已保存的0.5.1记录；语音指令使用固定合成声音经原生通道与真实云端识别。模拟器麦克风注入未通过，实体麦克风尚未验收。
''')
    copy('07_AI实践与验证/应用提示词.txt', ROOT / 'android/app/src/main/assets/assistant_prompt_zh.txt')
    copy('07_AI实践与验证/千问工具定义.json', ROOT / 'android/app/src/main/assets/qwen_tools.json')
    put('07_AI实践与验证/GitHub构建通过记录.json', json.dumps({
        '说明': '此记录对应网页识别框改动完成时的GitHub检查，不宣称是后续所有提交的最新检查。',
        'commit': '74c84f72201b79e59400a55a9f7a329ca7c41c51',
        'url': 'https://github.com/xu13791666851-sudo/spatial-memory-assistant/actions/runs/39593444547',
        '核对结果': 'completed / success',
        '包含检查': ['网页构建', '9项流程检查', '原始模型杯子识别', 'Docker构建并启动', '作品ZIP生成'],
    }, ensure_ascii=False, indent=2).encode())

    text('08_演示与操作说明/90秒演示脚本.txt', '''
建议录制真实连续操作，保留实际声音；下列是录制提纲，不是已经完成的录像。
0—10秒：展示首页，说清产品帮助用户观察、记住并寻找身边物品。
10—25秒：打开手机相机和语音，问“眼前有什么”，展示实际回答和 YOLO 框。
25—45秒：说“帮我记住蓝色水杯”，等待三个样本及保存成功回执，再打开记录。
45—70秒：结束后重新打开，改变物品位置，说“帮我找蓝色水杯”，展示候选与外观核对。
70—80秒：展示对话和物品记录，以及修改、删除入口。
80—90秒：说明可连接 ESP32；只有现场实际成功连接才展示“已连接”。没有实物时只展示连接入口。
可以从 05_项目源码/docs/hackathon-web-demo.md 按说明启动完整网页；安卓可使用本包安装文件。
正式视频应与当前软件版本一致。旧版排错视频不作为本次最终功能演示。
''')
    text('08_演示与操作说明/仍待补充的材料.txt', '''
1. 最新版完整操作录像：本包尚未包含。提交截图写的是“可包含演示视频/GIF”，不能据此认定视频是强制项；但建议补充，评委查看会更直接。
2. 实体硬件照片与连接实录：本包尚未包含。若介绍以已完成的软硬件联动为重点，应补充实际证据；目前只能展示固件、连接代码及概念图。
3. 独立托管的完整网页演示网址：尚未完成。已有 Cloudflare 正式网页和 YOLO 测试页不等于本包完整三样本流程。本次按 ZIP 交付，不依赖魔搭空间。
4. 报名表其他字段：团队、成员、赛道、作品名称、简介等需由报名者在表单按真实信息填写。包中提供可复制文案，但不虚构个人或团队资料。
5. ZIP大小上限及其他登录后必填项：当前截图没有显示，登录页无法在未登录状态下完整核对；以实际提交表单为准。
''')
    text('01_作品介绍/作品介绍与可复制文案.txt', '''
作品名称：I SEE YOU｜看见日常，也看见你
作品形态：面向视障用户的空间记忆助手；网页手机摄像头演示、安卓原生测试应用与 ESP32 硬件连接方案。
一句话介绍：用声音表达需要，用画面寻找线索，用记忆连接每一次找物。

项目背景：
看和听，原本是两种不同的感官，却可以共同指向同一个日常需要：知道身边有什么，找到自己想找的东西。
这让我们开始思考：摄像头获得的画面，怎样才能变成一句真正有用的话？用户说出的“这个”“刚才那个”“再看一下”，怎样才能被接住，让寻找继续下去？如果今天找到的位置，明天还能作为线索被记起，声音就能帮助人建立对周围空间更连贯的认识。
于是，我们构想了 I SEE YOU。用户用声音表达需要，助手根据需要观察画面，把物品和位置关系整理成清楚的语言；当用户希望记住时，把外观和位置线索留下。声音引导观察，画面回应询问，记忆连接起一次次对话。
“I see you”的另一层含义是看见一个人具体的需要，尊重他选择获取信息、探索环境的方式。有人需要简短提示，有人需要放大画面，也有人希望回看昨天的记录。我们希望技术落在这些小事里：少一次反复确认，多一条清楚线索，也多一份自己作出选择的把握。

产品功能：
观察画面、语音描述、物品外观样本采集、记忆保存、再次寻找、历史线索提示、左右对话记录、记忆修改与删除。界面采用柔和像素风和清晰的主要操作，支持语音与文字。

AI与记忆流程：
安卓在设备本机运行 YOLO；完整网页在后台运行相同原始模型。YOLO先给出类别候选，再结合外观信息与千问核对。用户明确要求记住后，采集三个实际外观样本，核对并写入成功才提示“已经记住”。再次寻找时读取样本，结合当前画面核对。上次位置是历史线索，不能当作现在的确认。

本次交付：
作品介绍、1920×1080封面、运行截图、SVG设计源文件、安卓0.5.1安装包、网页及安卓项目源码、YOLO模型、ESP32固件、提示词与工具定义、检查记录和运行说明。

目前边界：
还没有最新完整演示录像和硬件实拍；真实安卓手机麦克风与实体ESP32联合运行尚未验收。网页版与安卓的运行方式和记录存放位置不同，数据不自动同步。现有基础网站与YOLO测试页不等于完整三样本网页演示。识别效果需要在真实环境继续验证。

链接：
项目仓库：https://github.com/xu13791666851-sudo/spatial-memory-assistant
本次网页改动：https://github.com/xu13791666851-sudo/spatial-memory-assistant/pull/14
基础网页：https://i-see-you-spatial-memory.pages.dev/video/
浏览器YOLO测试：https://i-see-you-yolo-preview.pages.dev/video/
''')
    text('01_作品介绍/提交材料核对表.txt', '''
核对依据：用户提供的报名表截图，作品提交方式二选一；ZIP可包含作品文件、产品界面/原型图、实物照片、演示视频/GIF、AI实践佐证等。“可包含”不表示每一类都强制要求。

作品文件：已提供完整项目源码、网页运行文件、安卓安装包及硬件固件。
产品界面/原型图：已提供运行截图及SVG源文件；标明测试环境与早期设计稿。
作品封面：已提供1920×1080 PNG，可另行上传封面栏。
AI实践佐证：已提供提示词、工具定义、验证说明、检查结果及原始模型校验。
实物照片：尚缺，佩戴图片仅为概念参考。
演示视频/GIF：尚缺最新完整操作录像，提供90秒录制脚本。
魔搭创空间：选ZIP方式不需要同时提供空间链接。
团队信息及其他表单必填项：需在报名表另行填写，未写入公开作品包。
上传大小限制：截图未显示，需以登录后的表单为准。本包实际大小见根目录校验文件。

中文命名为本次整理方式；截图没有要求必须采用某个固定中文命名模板。
程序内部文件保留原名，以保证图片路径、模块引用及构建命令有效。
''')
    text('00_请先阅读.txt', f'''
I SEE YOU｜看见日常，也看见你
黑客松作品提交包，整理日期：{date}。

先打开“00_作品导览.html”，可离线查看介绍、封面和截图。导览是材料入口，完整应用需按以下方式启动。

目录：
01_作品介绍：作品背景、可复制报名文案、提交材料核对表。
02_作品封面：1920×1080封面和绘制源文件。
03_产品界面与设计源文件：运行截图、SVG设计稿及来源说明。
04_安卓安装包：安卓0.5.1测试APK及中文说明。
05_项目源码：GitHub整合源码、模型和已生成的完整网页。
06_硬件方案与固件：ESP32固件、硬件说明和佩戴概念参考。
07_AI实践与验证：提示词、工具定义、模型校验与检查结果。
08_演示与操作说明：90秒录制脚本与仍待补充的材料。
09_版本与文件清单：版本来源及逐文件校验信息。

运行完整网页：
安装 Node.js 22 与 Python 3.11 后，在“05_项目源码”目录执行：
npm ci
npm run build:demo
python -m pip install -r demo/requirements.txt
通过运行环境设置 QWEN_API_KEY，再执行：
python -m uvicorn demo.server:app --host 0.0.0.0 --port 7860
本机打开 http://127.0.0.1:7860/ 。手机使用相机与麦克风需要可访问的HTTPS网址。
Docker运行说明见“05_项目源码/docs/hackathon-web-demo.md”。保存的数据目录需要保留；不能依赖会被平台清空的临时磁盘。

安卓：Android 8以上、ARM64手机可安装；iPhone不能安装APK。安装包不含长期密钥，千问服务需要网络及有效后台。

版本：整合主分支已含完整网页与安卓源码；本次网页识别框改动在codex/web-parity-demo测试分支。源代码提交：{commit}。
APK沿用经过检查的0.5.1包，未因材料中文改名重新编译；其原始来源见版本说明。

本包不含长期密钥、个人记忆、Wi-Fi密码、私有录音或本地开发设置。
目前未包含最新完整演示录像与实体硬件实拍，且没有独立托管的完整网页演示网址；详见“仍待补充的材料.txt”。
上传ZIP只完成材料选择，仍需在报名表上传封面、填写其他必填项并完成最终提交。
''')

    cards = ''.join(f'<figure><img src="03_产品界面与设计源文件/{html.escape(name)}" alt="{html.escape(name)}"><figcaption>{html.escape(name)}</figcaption></figure>' for name, _ in shots)
    guide = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>I SEE YOU · 作品材料导览</title>
<style>body{{margin:0;background:#fff9ec;color:#112153;font:17px/1.8 system-ui,"Microsoft YaHei",sans-serif}}main{{max-width:1060px;margin:auto;padding:28px}}h1{{font-size:clamp(30px,5vw,52px);margin:8px 0}}h2{{font-size:25px;margin-top:32px}}p{{max-width:860px}}a{{color:#164bc5;text-underline-offset:4px}}.cover{{width:100%;border-radius:12px}}.lead{{font-size:22px}}.note{{border-left:5px solid #2457e7;background:#e6f2ff;padding:14px 20px}}.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}}figure{{margin:0;background:#fff;padding:12px;border:1px solid #bacce5;border-radius:12px}}figure img{{display:block;max-width:100%;height:410px;object-fit:contain;margin:auto}}figcaption{{font-size:14px;overflow-wrap:anywhere}}li{{margin:8px 0}}code{{background:#e6f2ff;padding:3px 6px}}footer{{border-top:1px solid #bacce5;margin-top:36px;padding-top:18px;font-size:14px}}@media(max-width:640px){{main{{padding:18px}}.grid{{grid-template-columns:1fr}}figure img{{height:360px}}}}</style>
<main><p>黑客松作品提交材料 · {date}</p><h1>I SEE YOU</h1><p class="lead">看见日常，也看见你。</p><img class="cover" src="02_作品封面/作品封面_1920x1080.png" alt="I SEE YOU 作品概念封面">
<h2>声音引导观察，画面回应询问</h2><p>面向视障用户的空间记忆助手。用户说出需要，摄像头观察眼前物品；系统将画面整理成语音提示，按要求记住外观与位置线索，之后帮助再次寻找。</p>
<div class="note">本包包括网页和安卓源码、安卓安装包、YOLO模型、ESP32固件、封面、设计源文件与验证材料。最新完整演示录像、实物照片及完整版本的独立托管网址仍待补充。</div>
<h2>先看这些材料</h2><ol><li><a href="01_作品介绍/作品介绍与可复制文案.txt">作品介绍与可复制报名文案</a> · <a href="01_作品介绍/提交材料核对表.txt">提交材料核对表</a></li><li><a href="04_安卓安装包/I_SEE_YOU_安卓测试版_0.5.1.apk">安卓0.5.1测试安装包</a> · <a href="04_安卓安装包/安装与使用说明.txt">安装说明</a>（iPhone无法安装）</li><li><a href="00_请先阅读.txt">完整网页启动说明</a> · <a href="05_项目源码/README.md">源码首页说明</a></li><li><a href="06_硬件方案与固件/硬件说明.txt">硬件方案与固件说明</a></li><li><a href="07_AI实践与验证/AI使用与验证说明.txt">AI使用与验证说明</a></li><li><a href="08_演示与操作说明/90秒演示脚本.txt">90秒演示脚本</a> · <a href="08_演示与操作说明/仍待补充的材料.txt">仍待补充的材料</a></li></ol>
<h2>运行界面与验证画面</h2><p>以下网页截图使用固定图片作相机测试输入，识别框来自真实模型；安卓截图来自模拟器。它们不作为真机或实体硬件验收证明。</p><div class="grid">{cards}</div>
<h2>可编辑设计文件</h2><p><a href="03_产品界面与设计源文件/05_像素首页设计稿.svg">首页SVG</a> · <a href="03_产品界面与设计源文件/06_像素记录页设计稿.svg">记录页SVG</a> · <a href="03_产品界面与设计源文件/07_像素界面总览设计稿.svg">界面总览SVG</a>。这些保留了早期设计过程，当前实现以运行截图为准。</p>
<h2>线上入口的使用范围</h2><p><a href="https://i-see-you-spatial-memory.pages.dev/video/">基础网页</a> · <a href="https://i-see-you-yolo-preview.pages.dev/video/">浏览器YOLO测试</a> · <a href="https://github.com/xu13791666851-sudo/spatial-memory-assistant">GitHub仓库</a>。现有公开网页不等于本包完整三样本流程。完整应用需要按说明启动后台并配置自己的千问服务。</p>
<footer>中文目录便于评审。源码内部保留原文件名与相对路径。封面和硬件佩戴图为概念表达；验证范围详见检查说明。此导览可在解压后离线打开。</footer></main></html>'''
    put('00_作品导览.html', guide.encode())

    version = {
        '整理日期': date, '源码提交': commit, '源码分支': 'codex/web-parity-demo',
        '主分支核对': '7c10a52f2242405e909149c512abe695958236c1（2026-10-21核对）',
        '安卓版本': '0.5.1-native-preview', '安卓原构建提交': android_check['commit'],
        '安卓安装包SHA256': APK_SHA, 'YOLO模型SHA256': manifest['sha256'],
        '重新编译安卓包': False, '最新完整演示录像已包含': False,
        '实物照片已包含': False, '完整演示已独立托管': False,
        '中文命名范围': '用户阅读的目录、说明、截图、封面与安装包；程序内部文件名不改',
    }
    put('09_版本与文件清单/版本说明.json', json.dumps(version, ensure_ascii=False, indent=2).encode())
    files = '\n'.join(f'{digest(data)}  {name}' for name, data in sorted(entries.items()))
    text('09_版本与文件清单/文件校验清单.txt', files)

    text_ext = ('.md', '.mjs', '.js', '.cjs', '.json', '.py', '.kt', '.xml', '.txt', '.toml', '.kts', '.properties', '.jsonc', '.html')
    for name, data in entries.items():
        if name.endswith(text_ext):
            for token in re.findall(rb'sk-[A-Za-z0-9_-]{20,}', data):
                # Exact, deliberately fake fixture shared by the two test suites.
                fixture = (name in ['05_项目源码/src/test_video.py', '05_项目源码/tests/web.test.mjs']
                           and digest(token) == '276ba285d6cb75e94ddd08c68a95960dcc905b3acb96bf321aa1e331482b35e4')
                assert fixture, 'Potential credential in ' + name
        assert not name.endswith(('.sqlite3', '.jks', '.keystore', '.pem', '.key')), name

    output.mkdir(parents=True, exist_ok=True)
    target = output / f'I_SEE_YOU_黑客松作品提交包_{date}.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    with zipfile.ZipFile(target) as z:
        assert z.testzip() is None
        assert len(z.namelist()) == len(set(z.namelist()))
        assert all(z.read(name) == data for name, data in entries.items())
    report = {'文件': str(target), '字节': target.stat().st_size, 'SHA256': digest(target.read_bytes()),
              '文件数量': len(entries), '压缩包完整性': '通过', '包含安卓包': True,
              '包含完整源码及固件': True, '包含新网页识别框': True,
              '演示录像': '未包含', '实物照片': '未包含', '源码提交': commit}
    (output / '提交包校验.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--materials-root', type=Path, required=True, help='Existing verified output materials directory')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--date', default='2026-10-21')
    args = parser.parse_args()
    build(args.materials_root.resolve(), args.output.resolve(), args.date)
