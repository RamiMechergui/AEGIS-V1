@echo off
cd /d "%~dp0"
setlocal EnableDelayedExpansion

rem Read the app version from package.json so this script never goes stale
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v

echo ==========================================
echo    Building AEGIS single-file releases v!VERSION!
echo    - AEGIS-Setup-!VERSION!.exe    (installer)
echo    - AEGIS-Portable-!VERSION!.exe (no install)
echo ==========================================
echo.
echo [!] This bundles Node.js + Electron inside the
echo     .exe files. Target PCs need NOTHING installed.
echo.
call npm run release
if errorlevel 1 (
    echo.
    echo ==========================================
    echo    BUILD FAILED - see errors above.
    echo ==========================================
    pause
    exit /b 1
)
echo.
echo ==========================================
echo    Build complete! Check the dist\ folder for:
echo      AEGIS-Setup-!VERSION!.exe
echo      AEGIS-Portable-!VERSION!.exe
echo.
echo    Copy EITHER single .exe to any Windows PC.
echo    Do NOT copy the source folder or node_modules.
echo ==========================================
pause
