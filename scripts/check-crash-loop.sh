#!/usr/bin/env bash
# Scripted check for the supervisor's crash-loop handling in start-all.sh.
#
# Phase 1: kill freshdesk-mcp repeatedly within the restart window and confirm
#          the supervisor logs "giving up" and the whole stack exits non-zero.
# Phase 2: exhaust all-but-one restart, wait past the window so the budget
#          resets, then kill again and confirm the stack stays up.
#
# Uses alternate ports so it can run alongside the normal workflow.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Alternate ports to avoid clashing with a running stack.
export JOOMLA_MCP_PORT=9400
export GANTRY_MCP_PORT=9401
export FRESHDESK_MCP_PORT=9407
export FTP_MCP_PORT=9404
export MOCKUP_MCP_PORT=9405
export KNOWLEDGE_GATEWAY_MCP_PORT=9406
export SITE_BUILDER_PORT=18403
export ORCHESTRATOR_PORT=6100
export DISABLE_9303_FORWARDER=1

PASS=0
FAIL=0
STACK_PID=""
ok()   { echo "PASS: $*"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $*"; FAIL=$((FAIL+1)); }

port_pid() { lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n1; }

wait_port_up() { # port timeout
  local deadline=$((SECONDS + $2))
  while ((SECONDS < deadline)); do
    [[ -n "$(port_pid "$1")" ]] && return 0
    sleep 0.3
  done
  return 1
}

kill_freshdesk() {
  local pid="" deadline=$((SECONDS + 10))
  while ((SECONDS < deadline)); do
    pid=$(port_pid "$FRESHDESK_MCP_PORT")
    [[ -n "$pid" ]] && break
    sleep 0.3
  done
  if [[ -z "$pid" ]]; then
    echo "could not find freshdesk pid on port $FRESHDESK_MCP_PORT" >&2
    return 1
  fi
  kill -9 "$pid"
  # wait until the port is actually freed
  local deadline=$((SECONDS + 10))
  while ((SECONDS < deadline)); do
    [[ "$(port_pid "$FRESHDESK_MCP_PORT")" != "$pid" ]] && return 0
    sleep 0.2
  done
  return 1
}

ports_free() {
  for p in $JOOMLA_MCP_PORT $GANTRY_MCP_PORT $FRESHDESK_MCP_PORT $FTP_MCP_PORT \
           $MOCKUP_MCP_PORT $KNOWLEDGE_GATEWAY_MCP_PORT $SITE_BUILDER_PORT $ORCHESTRATOR_PORT; do
    [[ -n "$(port_pid "$p")" ]] && return 1
  done
  return 0
}

wait_ports_free() {
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    ports_free && return 0
    # Nudge any leftovers.
    for p in $JOOMLA_MCP_PORT $GANTRY_MCP_PORT $FRESHDESK_MCP_PORT $FTP_MCP_PORT \
             $MOCKUP_MCP_PORT $KNOWLEDGE_GATEWAY_MCP_PORT $SITE_BUILDER_PORT $ORCHESTRATOR_PORT; do
      pid=$(port_pid "$p"); [[ -n "$pid" ]] && kill -9 "$pid" 2>/dev/null
    done
    sleep 0.5
  done
  ports_free
}

start_stack() { # logfile extra env already exported
  wait_ports_free || { echo "test ports still occupied"; return 1; }
  setsid bash "$ROOT/scripts/start-all.sh" >"$1" 2>&1 &
  STACK_PID=$!
  local deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    grep -q "All services ready" "$1" && return 0
    kill -0 "$STACK_PID" 2>/dev/null || { echo "stack died during startup"; return 1; }
    sleep 0.5
  done
  echo "stack never became ready"; return 1
}

stop_stack() {
  if [[ -n "$STACK_PID" ]]; then
    # setsid put the whole stack in its own process group; kill it wholesale.
    kill -TERM -- "-$STACK_PID" 2>/dev/null
    wait "$STACK_PID" 2>/dev/null
    kill -KILL -- "-$STACK_PID" 2>/dev/null
    STACK_PID=""
  fi
  wait_ports_free
}

echo "=== Phase 1: crash loop exhausts budget -> giving up + non-zero exit ==="
LOG1=/tmp/crash-loop-phase1.log
export SERVICE_MAX_RESTARTS=3
export SERVICE_RESTART_WINDOW=60
if ! start_stack "$LOG1"; then
  bad "stack failed to start (phase 1, see $LOG1)"
else
  ok "stack started (phase 1)"
  gave_up=1
  for i in 1 2 3 4; do
    kill_freshdesk || { bad "kill #$i failed"; gave_up=0; break; }
    echo "  killed freshdesk-mcp (#$i)"
    if ((i < 4)); then
      wait_port_up "$FRESHDESK_MCP_PORT" 15 || { bad "freshdesk not restarted after kill #$i"; gave_up=0; break; }
    fi
  done
  if ((gave_up)); then
    status=0
    # start-all.sh should now shut everything down and exit non-zero.
    deadline=$((SECONDS + 30))
    while kill -0 "$STACK_PID" 2>/dev/null && ((SECONDS < deadline)); do sleep 0.5; done
    if kill -0 "$STACK_PID" 2>/dev/null; then
      bad "stack still running after budget exhausted"
    else
      wait "$STACK_PID"; status=$?
      ((status != 0)) && ok "stack exited non-zero (status $status)" || bad "stack exited zero"
    fi
    grep -q "freshdesk-mcp crashed .* times within .*; giving up" "$LOG1" \
      && ok "supervisor logged 'giving up'" || bad "no 'giving up' log line (see $LOG1)"
  fi
fi
stop_stack

echo
echo "=== Phase 2: budget resets after service stays up past the window ==="
LOG2=/tmp/crash-loop-phase2.log
export SERVICE_MAX_RESTARTS=3
export SERVICE_RESTART_WINDOW=20
if ! start_stack "$LOG2"; then
  bad "stack failed to start (phase 2, see $LOG2)"
else
  ok "stack started (phase 2)"
  reset_ok=1
  # Use up the full budget (3 restarts) quickly...
  for i in 1 2 3; do
    kill_freshdesk || { bad "kill #$i failed"; reset_ok=0; break; }
    echo "  killed freshdesk-mcp (#$i)"
    wait_port_up "$FRESHDESK_MCP_PORT" 15 || { bad "freshdesk not restarted after kill #$i"; reset_ok=0; break; }
  done
  if ((reset_ok)); then
    echo "  waiting $((SERVICE_RESTART_WINDOW + 5))s for the restart budget to reset..."
    sleep $((SERVICE_RESTART_WINDOW + 5))
    # Without a reset this 4th kill would exceed the budget and kill the stack.
    if kill_freshdesk; then
      echo "  killed freshdesk-mcp (#4, after window)"
      if wait_port_up "$FRESHDESK_MCP_PORT" 15 && kill -0 "$STACK_PID" 2>/dev/null; then
        sleep 3
        if kill -0 "$STACK_PID" 2>/dev/null && ! grep -q "giving up" "$LOG2"; then
          ok "budget reset: service restarted and stack stayed up after window elapsed"
        else
          bad "stack died or gave up after post-window kill (see $LOG2)"
        fi
      else
        bad "freshdesk did not restart / stack died after post-window kill"
      fi
    else
      bad "post-window kill failed"
    fi
  fi
fi
stop_stack

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
((FAIL == 0))
