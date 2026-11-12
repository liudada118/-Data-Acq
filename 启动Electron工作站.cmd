@echo off
chcp 65001 >nul
cd /d "%~dp0node"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 请先在 node 目录运行 npm install，并在 node\ui 目录运行 npm ci。
  pause
  exit /b 1
)
if not exist "ui\dist\index.html" (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm run desktop
if errorlevel 1 pause
