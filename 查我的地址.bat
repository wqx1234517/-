@echo off
chcp 65001 >nul
cd /d %~dp0
set PYTHONIOENCODING=utf-8

where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [!] Python not found. Please install Python first.
    echo.
    pause
    exit /b
)

python show_address.py

echo.
pause
