@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在删除桌面快捷方式和开机自启动...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装快捷方式.ps1" -Remove
pause
