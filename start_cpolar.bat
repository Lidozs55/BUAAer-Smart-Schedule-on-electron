@echo off
chcp 65001 >nul
REM cpolar tunnel startup script
REM Expose local Flask backend port to public network

set CPOLAR_PATH=./cpolar/cpolar.exe
set BACKEND_PORT=5000

REM Check if cpolar exists
if not exist %CPOLAR_PATH% (
    echo Error: cpolar.exe not found
    echo Please download and extract cpolar to ./cpolar/ directory
    pause
    exit /b 1
)

echo ====================================
echo cpolar Tunnel Startup Script
echo ====================================
echo Backend Port: %BACKEND_PORT%
echo Access URLs:
echo   - Production: http://localhost:%BACKEND_PORT%
echo   - Mobile: http://localhost:%BACKEND_PORT%/mobile
echo ====================================
echo Starting cpolar tunnel...
echo ====================================
echo Visit https://dashboard.cpolar.com/auth to get auth token
echo Then run in new window: cpolar.exe authtoken YOUR_TOKEN
echo ====================================
echo Note: cpolar will tunnel to Flask backend (port %BACKEND_PORT%)
echo       Frontend Vite dev server (port 5173) proxies to backend
echo ====================================

REM Start cpolar tunnel
%CPOLAR_PATH% http %BACKEND_PORT%

pause