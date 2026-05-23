@echo off
:: This file must be saved with ANSI/GBK encoding. Do NOT save as UTF-8!!!!!
cd /d "%~dp0"

echo [WeMessage ��Ϣ��ʾ] ��������...
taskkill /f /im node.exe >nul 2>nul
taskkill /f /im WeFlow.exe >nul 2>nul
taskkill /f /im python.exe >nul 2>nul

echo ======================================================
echo  �������� WeMessage ��Ϣ���� + Windows ֪֧ͨ��...
echo  ��ϸ������ο� [�����ļ�] �� [�������ĵ�]
echo ======================================================
echo.

:: ���� Python ֪ͨ�ű�����̨���У�
start "WeMessage Notify" D:\Development\Python\python.exe main.py

:: ǰ̨������Ϣ����
WeFlow.exe WeMessage.js

pause