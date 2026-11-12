@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo Please run: python scripts\bootstrap.py
  pause
  exit /b 1
)
start "Synapse DAQ" ".venv\Scripts\pythonw.exe" "desktop\launch.py"
