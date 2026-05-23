@echo off
cd /d "%~dp0"

echo [WeMessage 消息提示] 正在启动...
taskkill /f /im node.exe >nul 2>nul
taskkill /f /im WeFlow.exe >nul 2>nul
taskkill /f /im python.exe >nul 2>nul

echo ======================================================
echo  正在启动 WeMessage 消息监听 + Windows 通知支持...
echo  详细配置请参考 [配置文件] 或 [开发者文档]
echo ======================================================
echo.

:: 启动 Python 通知脚本（后台运行）
start "WeMessage Notify" D:\Development\Python\python.exe main.py

:: 前台启动消息监听
WeFlow.exe WeMessage.js

pause