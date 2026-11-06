#!/bin/zsh
set -euo pipefail

phonebase_dir="${0:A:h}"
cd "$phonebase_dir"

fleet_pid=""
vision_pid=""
frontend_pid=""

cleanup() {
  if [[ -f "$phonebase_dir/.runtime/fleet-supervisor.json" ]]; then
    node "$phonebase_dir/scripts/stop-fleet-owner.mjs" || true
  fi
  if [[ -n "$frontend_pid" ]]; then
    kill "$frontend_pid" 2>/dev/null || true
  fi
  if [[ -n "$fleet_pid" ]]; then
    kill "$fleet_pid" 2>/dev/null || true
  fi
  if [[ -n "$vision_pid" ]]; then
    kill "$vision_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 0' INT TERM

export PHONEBASE_FLEET_OWNER_PID="$$"
export PHONEBASE_CONTROL_PLANE_PORT="${PHONEBASE_CONTROL_PLANE_PORT:-3013}"
export PHONEBASE_CALIBRATION_DIRECTORY="${PHONEBASE_CALIBRATION_DIRECTORY:-$phonebase_dir/build/devices}"

# Fleet discovery starts the local control plane and hardware nodes with
# automatic homing disabled. The operator must clear the fixture and confirm
# homing from the Dashboard before physical control becomes available.
npm run fleet &
fleet_pid=$!

npm run vision &
vision_pid=$!

# A frontend crash or UI deployment must not stop the device fleet.
# Only a station shutdown invokes the EXIT cleanup above.
while true; do
  npm run start:3020 &
  frontend_pid=$!
  if wait "$frontend_pid"; then
    print "Dashboard stopped; restarting frontend only."
  else
    print -u2 "Dashboard exited; restarting frontend only."
  fi
  frontend_pid=""
  sleep 2
done
