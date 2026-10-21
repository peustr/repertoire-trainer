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

rem Install the dependencies on the first run, and again after an update changed them.
node check-install.cjs
if errorlevel 1 (
  echo.
  echo   Installing the trainer's components. This takes a minute and needs the internet.
  echo.
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   The installation failed. Check your internet connection, close any other
    echo   Repertoire Trainer window, and run start.bat again.
    pause
    exit /b 1
  )
  node check-install.cjs --done
)

node server.js --open
echo.
echo   The trainer has stopped.
pause
