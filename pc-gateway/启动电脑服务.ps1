param([ValidateSet('cpu','0')][string]$Device = 'cpu',[ValidateRange(1024,65535)][int]$Port = 8765)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if(-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')){throw '请先运行“准备电脑环境.ps1”'}
$env:ISEEYOU_PYTHON=(Resolve-Path -LiteralPath '.venv/Scripts/python.exe').Path
$env:ISEEYOU_DEVICE=$Device
$env:ISEEYOU_PORT=[string]$Port
$env:PYTHONUTF8='1'
& node src/server.mjs
if($LASTEXITCODE -ne 0){throw '电脑服务未正常启动，请查看上面的提示'}
