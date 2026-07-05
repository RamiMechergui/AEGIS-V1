@echo off
title AEGIS Browser (Portable)
cd /d "%~dp0"

:: Create data directory if needed
if not exist "data\" mkdir "data"
if not exist "data\session\" mkdir "data\session"

:: If AEGIS.exe exists next to this script, launch it (packaged mode)
if exist "AEGIS.exe" (
    set PORTABLE=1
    start "" "%~dp0AEGIS.exe" %*
    goto :eof
)

:: Otherwise, try electron (dev mode)
if exist "node_modules\.bin\electron.cmd" (
    set PORTABLE=1
    start "" "%~dp0node_modules\.bin\electron.cmd" "%~dp0."
    goto :eof
)

echo Could not find AEGIS.exe or electron. Make sure you are in the correct directory.
pause
