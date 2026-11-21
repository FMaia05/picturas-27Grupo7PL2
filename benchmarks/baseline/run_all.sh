#!/usr/bin/env bash
# Full baseline, in the order used for the recorded results. Run from the repository root
# on the untouched base commit. Takes roughly 1 h after the stack is built.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export PICTURAS_PROJECT="${PICTURAS_PROJECT:-picturas-baseline}"
PY="$HERE/.venv/Scripts/python.exe"; [ -x "$PY" ] || PY="$HERE/.venv/bin/python"

if [ ! -x "$PY" ]; then
  python -m venv "$HERE/.venv"
  PY="$HERE/.venv/Scripts/python.exe"; [ -x "$PY" ] || PY="$HERE/.venv/bin/python"
  "$PY" -m pip install -q -r "$HERE/requirements.txt"
fi

cd "$REPO"
bash "$HERE/build_stack.sh"   # measurement subset (services.txt)
bash "$HERE/env_capture.sh"
bash "$HERE/run_regression.sh"
"$PY" "$HERE/c1_performance.py" warmup
"$PY" "$HERE/c1_performance.py" c1a --reps 3 --levels 1,2,4 2>&1 | tee "$HERE/results/c1a_run.log"
"$PY" "$HERE/c1_performance.py" c1b --reps 1 2>&1 | tee "$HERE/results/c1b_run.log"
"$PY" "$HERE/c2_reliability.py" all --reps 3 2>&1 | tee "$HERE/results/c2_run.log"
