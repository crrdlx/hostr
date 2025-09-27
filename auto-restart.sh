#!/bin/bash

# Auto-restart script for bidirectional-bridge.cjs
# This script monitors the bridge process and restarts it if it becomes unresponsive
# Designed to work with tmux sessions

# Configuration
SCRIPT_NAME="bidirectional-bridge.cjs"
SESSION_NAME="hostr-bridge"
RESTART_INTERVAL="6h"  # Restart every 6 hours (4 times daily)
HEALTH_CHECK_INTERVAL="5m"  # Check every 5 minutes
LOG_FILE="/var/log/hostr-bridge-restart.log"
PID_FILE="/var/run/hostr-bridge.pid"
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

# Check if process is running and responsive
check_process_health() {
    if [ ! -f "$PID_FILE" ]; then
        return 1
    fi
    
    local pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        log "${RED}Process $pid is not running${NC}"
        return 1
    fi
    
    # Check if the log file has been updated recently (indicating activity)
    if [ -f "/var/log/hostr-bridge.log" ]; then
        local last_activity=$(stat -c %Y "/var/log/hostr-bridge.log" 2>/dev/null || echo 0)
        local now=$(date +%s)
        local time_diff=$((now - last_activity))
        
        if [ $time_diff -gt 10800 ]; then  # 3 hours
            log "${YELLOW}Process appears unresponsive (no log activity for ${time_diff}s)${NC}"
            return 1
        fi
    fi
    
    return 0
}

# Start the bridge process
start_bridge() {
    log "${BLUE}Starting $SCRIPT_NAME...${NC}"
    
    # Create tmux session if it doesn't exist
    if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        tmux new-session -d -s "$SESSION_NAME"
        log "Created new tmux session: $SESSION_NAME"
    fi
    
    # Start the script in the tmux session
    tmux send-keys -t "$SESSION_NAME" "cd $SCRIPT_DIR" Enter
    tmux send-keys -t "$SESSION_NAME" "node $SCRIPT_NAME" Enter
    
    # Wait a moment for the process to start
    sleep 5
    
    # Get the process ID and save it
    local pid=$(tmux list-panes -t "$SESSION_NAME" -F "#{pane_pid}" | head -1)
    if [ -n "$pid" ]; then
        echo "$pid" > "$PID_FILE"
        log "${GREEN}Bridge started with PID: $pid${NC}"
        return 0
    else
        log "${RED}Failed to start bridge - could not get PID${NC}"
        return 1
    fi
}

# Stop the bridge process
stop_bridge() {
    log "${YELLOW}Stopping bridge process...${NC}"
    
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
    pkill -f "$SCRIPT_NAME" 2>/dev/null || true
    
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
