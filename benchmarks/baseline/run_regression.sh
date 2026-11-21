#!/usr/bin/env bash
# Runs the existing regression suites inside the images of the stack under test (EV-29),
# in throw-away containers (`docker compose run --rm --no-deps`), so the running stack
# and docker-compose.yaml are untouched. pytest is installed only in the throw-away
# video_tool container (the production image ships without dev dependencies).
# Usage: bash benchmarks/baseline/run_regression.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
P="${PICTURAS_PROJECT:-picturas-baseline}"
OUT="$HERE/regression_baseline.log"
DC=(docker compose -p "$P" -f "$REPO/docker-compose.yaml")

{
  echo "# Regression baseline — $(date -u +%FT%TZ) UTC"
  echo "# commit $(git -C "$REPO" rev-parse HEAD) · compose project $P"
  echo
  echo "=== [1/2] Tools/video/tests (pytest, image ${P}-video_tool) — start $(date -u +%FT%TZ)"
  "${DC[@]}" run --rm --no-deps -T --entrypoint sh video_tool -c \
    'python --version && ffmpeg -version | head -1 && pip install -q --disable-pip-version-check "pytest>=8" && python -m pytest -v -rA tests' 2>&1
  echo "=== [1/2] exit=$? end $(date -u +%FT%TZ)"
  echo
  echo "=== [2/2] projects/tests (node --test, image ${P}-projects) — start $(date -u +%FT%TZ)"
  "${DC[@]}" run --rm --no-deps -T --entrypoint sh projects -c \
    'node --version && node --test tests/*.test.js' 2>&1
  echo "=== [2/2] exit=$? end $(date -u +%FT%TZ)"
} > "$OUT" 2>&1
grep -E "^=== |passed|failed|^# (pass|fail|tests)" "$OUT"
echo "wrote $OUT"
