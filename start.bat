@echo off
setlocal
cd /d "%~dp0"
title Repertoire Trainer

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org and run start.bat again.
  echo.
  pause
  exit /b 1
)

node check-node.cjs
if errorlevel 1 (
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo   First run: installing dependencies. This takes a minute.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

node server.js --open
echo.
echo   The trainer has stopped.
pause
