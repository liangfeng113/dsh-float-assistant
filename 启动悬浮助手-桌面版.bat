@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   Floating AI Assistant - DESKTOP (Electron)
echo   always-on-top click-through floating window
echo   close the floating window to stop
echo ==========================================
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)
if not exist "electron\node_modules\electron\dist\electron.exe" (
  echo [INFO] Installing Electron first time... (needs network)
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  set ELECTRON_CACHE=%~dp0.electron-cache
  pushd electron
  call npm install --registry=https://registry.npmmirror.com --cache "%~dp0.npm-cache" --loglevel=error
  popd
)
pushd electron
call npx electron .
popd
pause
