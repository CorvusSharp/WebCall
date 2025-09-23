@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dump.ps1"
if errorlevel 1 (
  echo [ERROR] Dump failed. See messages above.
) else (
  echo Done.
)
