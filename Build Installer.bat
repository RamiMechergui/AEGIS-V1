@echo off
cd /d "%~dp0"
echo ==========================================
echo    Building AEGIS single-file releases
echo    - AEGIS-Setup-1.0.0.exe    (installer)
echo    - AEGIS-Portable-1.0.0.exe (no install)
echo ==========================================
echo.
echo [!] This bundles Node.js + Electron inside the
echo     .exe files. Target PCs need NOTHING installed.
echo.
call node create-logo.js
call npx electron-builder --win nsis portable
echo.
echo ==========================================
echo    Build complete! Check the dist\ folder for:
echo      AEGIS-Setup-1.0.0.exe
echo      AEGIS-Portable-1.0.0.exe
echo.
echo    Copy EITHER single .exe to any Windows PC.
echo    Do NOT copy the source folder or node_modules.
echo ==========================================
pause
