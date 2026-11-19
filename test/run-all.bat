@echo off
cd /d "%~dp0\.."
echo === UI 结构测试 ===
node test\run-tests.mjs
if errorlevel 1 exit /b 1
echo.
echo === 交互测试（含真实 OCR） ===
node test\run-interaction.mjs
