@echo off
title CrashPilot - Starting...
echo.
echo   ============================================
echo     CrashPilot - Crash Report Auto-Analyzer
echo   ============================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

cd /d "%~dp0"

:: Install dependencies if needed
if not exist "node_modules" (
    echo [1/4] Installing root dependencies...
    call npm install
)

if not exist "server\node_modules" (
    echo [2/4] Installing server dependencies...
    cd server && call npm install && cd ..
)

if not exist "client\node_modules" (
    echo [3/4] Installing client dependencies...
    cd client && call npm install && cd ..
)

:: Build client if needed
if not exist "client\dist" (
    echo [4/4] Building client...
    cd client && call npm run build && cd ..
)

echo.

:: Check if server is already running on port 3001
netstat -ano | findstr ":3001 " | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 (
    echo CrashPilot is already running. Opening browser...
    start "" "http://localhost:3001"
    exit /b 0
)

echo Starting CrashPilot server...
echo.

:: Start server (serves both API + static React build)
cd server
start "" "http://localhost:3001"
call npx tsx src/index.ts
