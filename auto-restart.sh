#!/bin/bash

# auto-restart.sh v0.1.1
# Auto-restart script for bidirectional-bridge.cjs
# Monitors the bridge process, restarts it if unresponsive, and displays live bridge logs

# Configuration
SCRIPT_NAME="bidirectional-bridge.cjs"
RESTART_INTERVAL="6h"  # Restart every 6 hours (4 times daily)
HEALTH_CHECK_INTERVAL="5m"  # Check every 5 minutes
LOG_FILE="/home/ubuntu/hostr/hostr-bridge-restart.log"
PID_FILE="/home/ubuntu/hostr/hostr-bridge.pid"
BRIDGE_LOG="/tmp/hostr-bridge.log"
HEALTH_TIMEOUT="3h"  # Consider process dead if no activity for 3 hours
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

# Start tailing the bridge log file for live feedback
start_log_tail() {
    # Filter for relevant bridge messages (e.g., processing posts, errors, listening)
    tail -f "$BRIDGE_LOG" | grep --line-buffered -E "\[Bridge\].*(Processing post|Error|Listening)" &
    local tail_pid=$!
    echo "$tail_pid" > "$PID_FILE.tail"
    log "${BLUE}Started live log tail (PID: $tail_pid)${NC}"
}

# Stop tailing the bridge log file
stop_log_tail() {
    if [ -f "$PID_FILE.tail" ]; then
        local tail_pid=$(cat "$PID_FILE.tail" 2>/dev/null)
        if [ -n "$tail_pid" ] && kill -0 "$tail_pid" 2>/dev/null; then
            kill -TERM "$tail_pid" 2>/dev/null
            log "${YELLOW}Stopped live log tail (PID: $tail_pid)${NC}"
        fi
        rm -f "$PID_FILE.tail"
    fi
}

# Check if process is running and responsive
check_process_health() {
    if [ ! -f "$PID_FILE" ]; then
        log "${RED}No PID file found, assuming process is not running${NC}"
        return 1
    fi
    
    local pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        log "${RED}Process $pid is not running${NC}"
        return 1
    fi
    
    # Check if the log file has been updated recently (indicating activity)
    if [ -f "$BRIDGE_LOG" ]; then
        local last_activity=$(stat -c %Y "$BRIDGE_LOG" 2>/dev/null || echo 0)
        local now=$(date +%s)
        local time_diff=$((now - last_activity))
        
        if [ $time_diff -gt 10800 ]; then  # 3 hours
            log "${YELLOW}Process appears unresponsive (no log activity for ${time_diff}s)${NC}"
            return 1
        fi
    else
        log "${YELLOW}Log file $BRIDGE_LOG not found, assuming process is unresponsive${NC}"
        return 1
    fi
    
    return 0
}

# Start the bridge process
start_bridge() {
    log "${BLUE}Starting $SCRIPT_NAME...${NC}"
    
    cd "$SCRIPT_DIR"
    node "$SCRIPT_NAME" > /dev/null 2>&1 &
    local pid=$!
    
    if [ -n "$pid" ]; then
        echo "$pid" > "$PID_FILE"
        log "${GREEN}Bridge started with PID: $pid${NC}"
        start_log_tail
        return 0
    else
        log "${RED}Failed to start bridge - could not get PID${NC}"
        return 1
    fi
}

# Stop the bridge process
stop_bridge() {
    log "${YELLOW}Stopping bridge process...${NC}"
    
    stop_log_tail
    
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null
            sleep 5
            if kill -0 "$pid" 2>/dev/null; then
                log "${YELLOW}Process didn't stop gracefully, forcing kill...${NC}"
                kill -KILL "$pid" 2>/dev/null
            fi
        fi
        rm -f "$PID_FILE"
    fi
    
    # Also try to kill any remaining node processes running the script
    pkill -f "node $SCRIPT_NAME" 2>/dev/null || true
    
    log "${GREEN}Bridge process stopped${NC}"
}

# Restart the bridge process
restart_bridge() {
    log "${BLUE}Restarting bridge process...${NC}"
    stop_bridge
    sleep 2
    start_bridge
}

# Main monitoring loop
monitor_bridge() {
    log "${GREEN}Starting bridge monitor (restart every $RESTART_INTERVAL, health check every $HEALTH_CHECK_INTERVAL)${NC}"
    
    local last_restart=$(date +%s)
    local restart_interval_seconds=21600  # 6 hours in seconds
    
    while true; do
        local current_time=$(date +%s)
        local time_since_restart=$((current_time - last_restart))
        
        # Check if it's time for a scheduled restart
        if [ $time_since_restart -ge $restart_interval_seconds ]; then
            log "${BLUE}Scheduled restart triggered (${time_since_restart}s since last restart)${NC}"
            restart_bridge
            last_restart=$current_time
        # Check process health
        elif ! check_process_health; then
            log "${RED}Process health check failed, restarting...${NC}"
            restart_bridge
            last_restart=$current_time
        else
            log "${GREEN}Process is healthy${NC}"
        fi
        
        # Wait before next check
        sleep 300  # 5 minutes
    done
}

# Handle signals
cleanup() {
    log "${YELLOW}Received shutdown signal, stopping monitor...${NC}"
    stop_bridge
    exit 0
}

trap cleanup SIGINT SIGTERM

# Main execution
case "${1:-monitor}" in
    "start")
        start_bridge
        ;;
    "stop")
        stop_bridge
        ;;
    "restart")
        restart_bridge
        ;;
    "status")
        if check_process_health; then
            echo "Bridge is running and healthy"
        else
            echo "Bridge is not running or unresponsive"
        fi
        ;;
    "monitor")
        monitor_bridge
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|monitor}"
        echo "  start   - Start the bridge process"
        echo "  stop    - Stop the bridge process"
        echo "  restart - Restart the bridge process"
        echo "  status  - Check if bridge is running"
        echo "  monitor - Start monitoring loop (default)"
        exit 1
        ;;
esac

# auto-restart.sh v0.1.1
# Monitors and restarts bidirectional-bridge.cjs if unresponsive
# Runs process directly in the background without tmux
# Uses user-writable paths for log and PID files
# Displays live bridge logs filtered for processing, errors, and listening messages
# Features:
# - Periodic restarts every 6 hours
# - Health checks every 5 minutes based on PID and log activity
# - Graceful shutdown handling
# - Color-coded logging
# - Live feedback of bridge activity via tail