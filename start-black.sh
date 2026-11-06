#!/bin/zsh
set -euo pipefail

phonebase_dir="${0:A:h}"
cd "$phonebase_dir"

if curl --max-time 1 -sS http://127.0.0.1:3016/status >/dev/null 2>&1; then
  echo "Phonebase Supervisor is already running on port 3016."
  echo "Use: npm run stable:status"
  exit 0
fi

driver_pid=""
control_plane_pid=""
node_pid=""

cleanup() {
  for child_pid in "$node_pid" "$control_plane_pid" "$driver_pid"; do
    if [[ -n "$child_pid" ]]; then
      kill "$child_pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

export PHONEBASE_CONTROL_PLANE_PORT="${PHONEBASE_CONTROL_PLANE_PORT:-3013}"
default_calibration="$phonebase_dir/build/black-arm-calibration.json"
learned_calibration="$phonebase_dir/build/runtime/black-arm-calibration.json"
if [[ -z "${PHONEBASE_CALIBRATION_PATH:-}" ]]; then
  if [[ -f "$learned_calibration" ]]; then
    export PHONEBASE_CALIBRATION_PATH="$learned_calibration"
  else
    export PHONEBASE_CALIBRATION_PATH="$default_calibration"
  fi
fi
export PHONEBASE_CALIBRATION_OUTPUT_PATH="${PHONEBASE_CALIBRATION_OUTPUT_PATH:-$learned_calibration}"

python3 bridge/black_arm_driver.py &
driver_pid=$!

for _ in {1..30}; do
  if curl --max-time 1 -fsS http://127.0.0.1:3014/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl --max-time 2 -fsS http://127.0.0.1:3014/health >/dev/null

# Every fresh controller session attempts to establish a known origin.  A
# driver-only restart during supervised visual recovery must preserve the
# already verified X=8/Y=0 recovery point, so that case opts out explicitly.
if [[ "${PHONEBASE_BLACK_SKIP_START_HOME:-0}" == "1" ]]; then
  echo "Skipping startup home; preserving the supervised visual-recovery position."
else
  # A bounded pre-home recovery moves only away from active X/Y/Z inputs.  If
  # a sensor remains active, keep the control plane and console online in view-only mode
  # so the failure can be diagnosed remotely instead of killing every process.
  if curl --max-time 60 --fail-with-body -sS -X POST \
    http://127.0.0.1:3014/api/home-machine \
    -H 'Content-Type: application/json' -d '{}'; then
    echo
    if ! curl --max-time 8 --fail-with-body -sS -X POST \
      http://127.0.0.1:3014/api/move \
      -H 'Content-Type: application/json' -d '{"x":18,"y":20.5}'; then
      echo
      echo "Black arm homed but could not reach park; continuing for diagnostics." >&2
    fi
    echo
  else
    echo
    echo "Black arm recovery failed; continuing in preview-only mode." >&2
    echo "Open /api/status or the remote console for limit-pin diagnostics." >&2
  fi
fi

npm run control-plane &
control_plane_pid=$!

for _ in {1..50}; do
  if curl --max-time 1 -fsS http://127.0.0.1:3013/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl --max-time 2 -fsS http://127.0.0.1:3013/health >/dev/null

npm run black:node &
node_pid=$!

npm run dev:3020
