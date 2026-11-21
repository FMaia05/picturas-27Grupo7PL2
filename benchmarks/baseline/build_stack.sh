#!/usr/bin/env bash
# Builds and starts the subset of docker-compose.yaml used by the CAND-1/CAND-2
# measurements (services.txt), one service at a time with up to 4 attempts each, so that a
# single pip/npm network timeout does not abort the whole build.
#
# The AI image tools, generative-mock, watermark, subscriptions and mongo-backup
# are not started: none of them takes part in the video pipeline, the broker or the
# orchestrator measured here, and the AI images download several GB of CUDA wheels.
# The final (post-refactoring) measurement MUST use the same services.txt.
#
# Usage: bash benchmarks/baseline/build_stack.sh            # subset from services.txt
#        SERVICES="all" bash benchmarks/baseline/build_stack.sh   # whole compose file
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
P="${PICTURAS_PROJECT:-picturas-baseline}"
DC=(docker compose -p "$P" -f "$REPO/docker-compose.yaml")
mkdir -p "$HERE/results"

if [ "${SERVICES:-}" = "all" ]; then
  SVCS=$("${DC[@]}" config --services)
else
  SVCS=$(grep -v '^\s*#' "$HERE/services.txt" | tr -s ' \n' ' ')
fi

failed=()
for svc in $SVCS; do
  ok=0
  for attempt in 1 2 3 4; do
    echo "=== build $svc (attempt $attempt) $(date -u +%FT%TZ)"
    if "${DC[@]}" build "$svc" > "$HERE/results/build_${svc}.log" 2>&1; then ok=1; break; fi
    tail -3 "$HERE/results/build_${svc}.log"
    sleep 10
  done
  [ $ok = 1 ] && echo "=== ok $svc" || { echo "=== FAILED $svc"; failed+=("$svc"); }
done
if [ ${#failed[@]} -gt 0 ]; then echo "FAILED: ${failed[*]}"; exit 1; fi
# shellcheck disable=SC2086
"${DC[@]}" up -d --no-build $SVCS
echo "EXIT=$?"
