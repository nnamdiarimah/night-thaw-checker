# Midnight Token Thaw Checker

A standalone application to check your Midnight token thaw schedule and claim dates.

## Quick Start

### Windows
Double-click `start.cmd` or run in terminal:
```
start.cmd
```

### Mac/Linux
```bash
chmod +x start.sh
./start.sh
```

## Requirements

- [Node.js](https://nodejs.org/) (v18 or higher recommended)

## Features

- Check thaw schedule for single or multiple Cardano addresses
- Three view modes: Timeline, Table, and Calendar
- Export results to CSV or JSON
- Fully runs locally on your machine - no data sent to third parties
- Direct connection to Midnight mainnet API

## Usage

1. Enter your Cardano address (starting with `addr1`)
2. Click "Check Schedule"
3. View your token thaw schedule
4. Export data if needed

### Bulk Address Check

You can check multiple addresses at once:
- One address per line
- Or CSV format: `Label,addr1...`

Example:
```
My Main Wallet,addr1qxfymkctnvaq4vsdffsdfsfdl6gwkq5r4...
addr1qxyz...
```

## Technical Details

- Built with React + Vite + TypeScript
- Styled with Tailwind CSS
- Calls Midnight API directly: `https://mainnet.prod.gd.midnighttge.io`

## Troubleshooting

**"Node.js is not installed"**
- Download and install Node.js from https://nodejs.org/

**CORS errors in browser console**
- This shouldn't happen with the standalone app
- If it does, the Midnight API may have changed their CORS policy

**Address not found / No thaw schedule**
- Verify your address is correct (starts with `addr1`)
- Make sure you participated in the Scavenger Hunt or Glacier Airdrop
