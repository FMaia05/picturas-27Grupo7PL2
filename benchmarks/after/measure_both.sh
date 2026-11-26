#!/usr/bin/env bash
# Measures the base and the refactored stack one after the other, in the same session and
# conditions (same machine, charger connected, no other heavy load), with the same scripts.
# Only one stack runs at a time: they share the published ports.
# Usage (repository root): bash benchmarks/after/measure_both.sh
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
B="$REPO/benchmarks/baseline"
PY="$B/.venv/Scripts/python.exe"; [ -x "$PY" ] || PY="$B/.venv/bin/python"
export PYTHONUTF8=1
SCENARIOS=${SCENARIOS:-"warmup c1a c1b c2e"}

power() { powershell.exe -NoProfile -Command '$b=Get-CimInstance Win32_Battery; "$(Get-Date -Format o) battery status $($b.BatteryStatus) (2 = charger) $($b.EstimatedChargeRemaining)%"' 2>/dev/null | tr -d '\r'; }

stop_project() { docker stop -t 10 $(docker ps -q --filter "label=com.docker.compose.project=$1") >/dev/null 2>&1 || true; }

start_project() {
  local p=$1
  docker start $(docker ps -aq --filter "label=com.docker.compose.project=$p" --filter "label=com.docker.compose.service=rabbitmq") >/dev/null
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$p-rabbitmq-1")" = healthy ]; do sleep 2; done
  docker start $(docker ps -aq --filter "label=com.docker.compose.project=$p") >/dev/null
  sleep 15
  docker restart "$p-nginx-1" >/dev/null
  until curl -sk -o /dev/null https://localhost:8080/api-gateway/users/x; do sleep 2; done
}

measure() {
  local p=$1 out=$2
  mkdir -p "$out"
  export PICTURAS_PROJECT=$p PICTURAS_RESULTS="$out"
  power > "$out/power.log"
  for s in $SCENARIOS; do
    case $s in
      warmup) "$PY" "$B/c1_performance.py" warmup > "$out/warmup_run.log" 2>&1 ;;
      c1a) "$PY" "$B/c1_performance.py" c1a --reps 3 --levels 1,2,4 > "$out/c1a_run.log" 2>&1 ;;
      c1b) "$PY" "$B/c1_performance.py" c1b --reps 3 > "$out/c1b_run.log" 2>&1 ;;
      *) "$PY" "$B/c2_reliability.py" "$s" > "$out/${s}_run.log" 2>&1 ;;
    esac
    echo "$p $s exit $?"
  done
  power >> "$out/power.log"
}

stop_project picturas-after
start_project picturas-baseline
measure picturas-baseline "$REPO/benchmarks/after/results_base"
stop_project picturas-baseline
start_project picturas-after
measure picturas-after "$REPO/benchmarks/after/results"
