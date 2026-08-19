@echo off
rem One-click Poki packaging. Double-click this file.
rem All the real work (and all the Chinese output) lives in scripts/one-click-poki.ps1;
rem this launcher exists only because double-clicking a .ps1 opens Notepad instead of running it.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\one-click-poki.ps1"
echo.
pause
