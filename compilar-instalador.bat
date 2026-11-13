@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1"
if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao compilar o instalador. Verifique as mensagens acima.
    pause
    exit /b 1
)
echo.
pause
