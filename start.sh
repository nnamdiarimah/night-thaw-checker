#!/bin/bash

echo ""
echo "========================================"
echo "  Midnight Token Thaw Checker"
echo "========================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo ""
    echo "Please install Node.js from: https://nodejs.org/"
    echo ""
    exit 1
fi

echo "[OK] Node.js found"
echo "    Version: $(node -v)"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "[INFO] Installing dependencies..."
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "[ERROR] Failed to install dependencies"
        exit 1
    fi
    echo ""
    echo "[OK] Dependencies installed"
    echo ""
fi

echo "[INFO] Starting Thaw Checker..."
echo ""
echo "========================================"
echo "  App will open in your browser at:"
echo "  http://localhost:3000"
echo "========================================"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Start the development server
npm run dev
