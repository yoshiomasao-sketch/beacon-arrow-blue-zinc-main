@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto nonode
node "%~dp0lan-sync-server.mjs"
echo.
pause
exit /b 0
:nonode
echo Node.js is not installed.
echo Install the LTS version from https://nodejs.org/ and double-click this file again.
pause
exit /b 1
