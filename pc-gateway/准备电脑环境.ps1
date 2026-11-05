param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
if($LASTEXITCODE -ne 0){throw '请先安装 Node.js 24 或更新版本'}
if(-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')){
    & $Python -m venv .venv
    if($LASTEXITCODE -ne 0){throw '需要可用的 Python 3.11 或更新版本'}
}
& '.venv/Scripts/python.exe' -m pip install --disable-pip-version-check -r requirements-lock-cpu.txt --extra-index-url https://download.pytorch.org/whl/cpu
if($LASTEXITCODE -ne 0){throw '电脑推理环境安装未完成'}
& npm ci --ignore-scripts --no-audit --no-fund
if($LASTEXITCODE -ne 0){throw '电脑连接组件安装未完成'}
& '.venv/Scripts/python.exe' -c 'from pathlib import Path;import hashlib,json;p=Path("models");m=json.loads((p/"manifest.json").read_text());assert hashlib.sha256((p/m["file"]).read_bytes()).hexdigest()==m["sha256"]'
if($LASTEXITCODE -ne 0){throw '本地 YOLO 模型缺失或校验失败，请补齐交付包中的模型文件'}
Write-Output '电脑环境已准备好。运行“启动电脑服务.ps1”即可。'
