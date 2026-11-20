@echo off
setlocal
cd /d "%~dp0"
title manga-panel-studio

rem 双击用的快捷方式。真正的启动逻辑在 bin/cli.mjs，这里不再复制一份：
rem 它会读 ~/.manga-panel-studio/settings.json 里的 Python 路径，
rem 起 OCR（5009）和画布（7788），并打印地址和下一步提示。

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 没找到 node。先装 Node.js 18+：https://nodejs.org
  pause
  exit /b 1
)

node "%~dp0bin\cli.mjs" start-all

echo.
echo 服务已停止。
pause
