@echo off
REM ==========================================================================
REM run-bot.cmd - launches the bot with its output merged into logs\bot.log.
REM Called by scripts\windows\supervisor.ps1. Kept as a .cmd so node is started
REM with a simple, correctly-quoted command line (the node path contains spaces).
REM ==========================================================================
setlocal
set "PROJECT_DIR=%~dp0"
set "NODE_EXE=%~1"
if "%NODE_EXE%"=="" set "NODE_EXE=node.exe"
set "LOG_FILE=%PROJECT_DIR%logs\bot.log"
if not exist "%PROJECT_DIR%logs" mkdir "%PROJECT_DIR%logs"

cd /d "%PROJECT_DIR%"
"%NODE_EXE%" --env-file-if-exists=.env dist\index.js >> "%LOG_FILE%" 2>&1
exit /b %ERRORLEVEL%