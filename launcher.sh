#!/bin/bash

echo ""
echo "  ============================================"
echo "    CrashPilot - Crash Report Auto-Analyzer"
echo "  ============================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo "Install via: brew install node"
    exit 1
fi

cd "$(dirname "$0")"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "[1/4] Installing root dependencies..."
    npm install
fi

if [ ! -d "server/node_modules" ]; then
    echo "[2/4] Installing server dependencies..."
    cd server && npm install && cd ..
fi

if [ ! -d "client/node_modules" ]; then
    echo "[3/4] Installing client dependencies..."
    cd client && npm install && cd ..
fi

# Build client if needed
if [ ! -d "client/dist" ]; then
    echo "[4/4] Building client..."
    cd client && npm run build && cd ..
fi

echo ""
echo "Starting CrashPilot server..."
echo ""

# Open browser
open "http://localhost:3001" 2>/dev/null || xdg-open "http://localhost:3001" 2>/dev/null &

# Start server
cd server
npx tsx src/index.ts
