@echo off
title Midnight Token Thaw Checker
echo.
echo ========================================
echo   Midnight Token Thaw Checker
echo ========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo.
    echo Please install Node.js from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo     Version: %NODE_VERSION%
echo.

:: Check if node_modules exists
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    echo.
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
    echo.
    echo [OK] Dependencies installed
    echo.
)

echo [INFO] Starting Thaw Checker...
echo.
echo ========================================
echo   App will open in your browser at:
echo   http://localhost:3000
echo ========================================
echo.
echo Press Ctrl+C to stop the server
echo.

:: Start the development server
call npm run dev
