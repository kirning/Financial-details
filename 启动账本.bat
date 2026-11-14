@echo off
rem Nanfeng Village Ledger - one-click launcher
rem Double-click this file to start the service and open the page.
cd /d "%~dp0server"

netstat -ano | findstr "LISTENING" | findstr ":7300" >nul 2>&1
if %errorlevel%==0 (
  echo Ledger service is already running on port 7300.
  goto OPEN
)

echo Starting ledger service on 127.0.0.1:7300 ...
start "NanfengLedger" /min node dist\index.js
timeout /t 3 >nul

netstat -ano | findstr "LISTENING" | findstr ":7300" >nul 2>&1
if not %errorlevel%==0 (
  echo [ERROR] Service did not start. Check by running: node dist\index.js
  echo Press any key to close.
  pause >nul
  exit /b 1
)
echo Service started.

:OPEN
start "" http://127.0.0.1:7300/
echo.
echo Ledger page opened in browser.
echo Keep the minimized "NanfengLedger" window running; close it to stop the service.
timeout /t 3 >nul
