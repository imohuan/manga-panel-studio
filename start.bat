@echo off
setlocal
cd /d "%~dp0"
title comic-canvas

rem Python 解释器从 settings.json 的 translator.projectRoot 推导，
rem 也可以用环境变量 MT_ROOT 或 STUDIO_PYTHON 覆盖。
rem 没配置时 start.bat 提示去设置页填，画布仍会启动（OCR 功能不可用）。
for /f "usebackq delims=" %%i in (`node -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('settings.json','utf8'));const mt=(process.env.MT_ROOT||s.translator.projectRoot||'');for(const p of [mt+'/py310/python.exe',mt+'/venv/Scripts/python.exe',mt+'/.venv/Scripts/python.exe']){if(p.startsWith('/')||p.startsWith('undefined'))continue;if(fs.existsSync(p)){console.log(p);process.exit(0)}}}catch(e){};console.log(process.env.STUDIO_PYTHON||'python')"`) do set "OCR_PY=%%i"

set "CANVAS_URL=http://127.0.0.1:7788"

echo ============================================
echo   comic-canvas  (canvas 7788 + OCR 5009)
echo   canvas  %CANVAS_URL%
echo   ocr     http://127.0.0.1:5009/health
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Install Node.js first.
  pause
  exit /b 1
)

if exist "%OCR_PY%" (
  echo [1/2] starting OCR service on 5009 ...
  start "ocr-service" /min "%OCR_PY%" server\ocr_service.py --port 5009 --use-gpu
) else (
  echo [WARN] OCR python not found: %OCR_PY%
  echo        canvas starts anyway, but OCR jobs will fail.
)

start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%CANVAS_URL%'"

echo [2/2] starting canvas on 7788 ...
echo       keep this window open; close it to stop the canvas.
echo.
echo       note: OCR needs 1-3 minutes to load models on first run.
echo.
node server\canvas.mjs

echo.
echo canvas stopped.
pause
