@echo off
:: This file must be saved with ANSI/GBK encoding. Do NOT save as UTF-8!!!!!
cd /d "%~dp0"

echo [WeMessage 消息提示] 正在启动...
taskkill /f /im node.exe >nul 2>nul
taskkill /f /im WeFlow.exe >nul 2>nul
taskkill /f /im python.exe >nul 2>nul

:: Auto-compile C proxy
gcc -O2 -o WeFlow.exe proxy\proxy.c -lws2_32
if errorlevel 1 (
    echo [ERROR] C proxy compilation failed!
    echo [ERROR] 编译失败！
    pause
    exit /b 1
)

echo ======================================================
echo  正在启动 WeMessage 消息监听 + Windows 通知支持...
echo  详细配置请参考 [配置文件] 或 [开发者文档]
echo ======================================================
echo.

:: 启动 Python 通知脚本（后台运行）
start "WeMessage Notify" python main.py

:: 前台启动消息监听（C 代理 WeFlow.exe 由 WeMessage.js 自动拉起）
node WeMessage.js

pause
