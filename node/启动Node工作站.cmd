@echo off
cd /d "%~dp0"
if not exist "node_modules\archiver\package.json" (
  echo Please run npm run setup first.
  pause
  exit /b 1
)
if not exist "ui\dist\index.html" (
  echo Please run npm run build first.
  pause
  exit /b 1
)
node --env-file-if-exists=.env.local src/server.mjs
if errorlevel 1 pause
