# Auto-Restart Setup Guide

This guide explains how to set up automatic restart functionality for your bidirectional bridge script.

## Overview

The auto-restart system consists of:
1. **External monitoring scripts** - Monitor the process from outside and restart if needed
2. **Internal restart logic** - Built into the main script for graceful restarts
3. **Health monitoring** - Detects when the script becomes unresponsive

## Files Created

- `auto-restart.sh` - Bash script for Linux/macOS with tmux support
- `auto-restart.ps1` - PowerShell script for Windows
- `restart-config.json` - Configuration file
- `bidirectional-bridge.cjs` - Updated with internal restart logic

## Setup Instructions

### For Linux/macOS (with tmux):

1. **Make the script executable:**
   ```bash
   chmod +x auto-restart.sh
   ```

2. **Start monitoring:**
   ```bash
   ./auto-restart.sh monitor
   ```

3. **Or start the bridge directly:**
   ```bash
   ./auto-restart.sh start
   ```

### For Windows (PowerShell):

1. **Start monitoring:**
   ```powershell
   .\auto-restart.ps1 monitor
   ```

2. **Or start the bridge directly:**
   ```powershell
   .\auto-restart.ps1 start
   ```

## Configuration

### Restart Intervals

The system supports multiple restart intervals:
- **6 hours** (4 times daily) - Default, good for high-availability
- **8 hours** (3 times daily) - Balanced approach
- **12 hours** (2 times daily) - Less frequent
- **24 hours** (1 time daily) - Minimal restarts

### Health Monitoring

- **Check interval**: Every 5 minutes
- **Inactivity timeout**: 10 minutes (considers process dead if no activity)
- **Max restart attempts**: 3 (prevents infinite restart loops)

## How It Works

### External Monitoring
- Monitors the process PID and log file activity
- Restarts the process if it becomes unresponsive
- Handles both scheduled restarts and health-based restarts
- Works with tmux sessions for better process management

### Internal Monitoring
- Built into the main script
- Tracks activity timestamps
- Performs graceful shutdowns
- Prevents infinite restart loops

### Restart Triggers

1. **Scheduled restarts** - Every 6 hours by default
2. **Health check failures** - No activity for 10+ minutes
3. **Unhandled promise rejections** - JavaScript errors
4. **Bridge errors** - Connection or processing failures

## Usage Examples

### Check Status
```bash
./auto-restart.sh status
```

### Manual Restart
```bash
./auto-restart.sh restart
```

### Stop Bridge
```bash
./auto-restart.sh stop
```

## Log Files

- **Bridge logs**: `/tmp/hostr-bridge.log`
- **Restart logs**: `/tmp/hostr-bridge-restart.log`
- **PID file**: `/tmp/hostr-bridge.pid`

## Troubleshooting

### If the bridge keeps restarting:
1. Check the restart log for error patterns
2. Verify your `.env` file has correct credentials
3. Check network connectivity to Hive and Nostr relays

### If the bridge doesn't restart:
1. Check if the monitoring script is running
2. Verify file permissions on the scripts
3. Check the restart log for errors

### Manual Recovery:
If the auto-restart system fails, you can always:
1. Stop the monitoring script
2. Start the bridge manually: `node bidirectional-bridge.cjs`
3. Restart the monitoring script

## Customization

You can modify the restart intervals by editing the configuration in `bidirectional-bridge.cjs`:

```javascript
const RESTART_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RESTART_ATTEMPTS = 3;
```

## Benefits

- **Automatic recovery** from crashes and stalls
- **Scheduled maintenance** to prevent memory leaks
- **Health monitoring** to detect unresponsive states
- **Graceful shutdowns** to preserve data integrity
- **Multiple restart strategies** for different failure modes
