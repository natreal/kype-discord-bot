@echo off
REM ==========================================================================
REM Discord bot launcher (Windows).
REM
REM Windows equivalent of double-clicking "Discord Bot.app" on macOS.
REM It asks botctl.ps1 to start the bot, which goes through the
REM "kype-discord-bot" scheduled task when one exists - the same path a logon
REM takes, so an external watchdog cannot replace this supervisor with a second
REM one. The bot keeps running after this window closes. Everything is written
REM to logs\bot.log.
REM ==========================================================================
setlocal
set "PROJECT_DIR=%~dp0"

echo Starting Discord bot...
echo Logs: %PROJECT_DIR%logs\bot.log

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%scripts\windows\botctl.ps1" start

exit /b 0