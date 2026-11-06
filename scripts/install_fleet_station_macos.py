#!/usr/bin/env python3
"""Install the safe PhoneUse fleet runtime as a per-user macOS LaunchAgent."""

from __future__ import annotations

import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
LABEL = "com.phoneuse.station"
TARGET = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG_DIR = ROOT / "build" / "runtime" / "fleet-station" / "logs"


def main() -> int:
    if sys.platform != "darwin":
        print("This installer only supports macOS", file=sys.stderr)
        return 2
    required = ["npm", "node", "ffmpeg", "swift"]
    missing = [name for name in required if not shutil.which(name)]
    if missing:
        print("Missing required commands: " + ", ".join(missing), file=sys.stderr)
        return 2
    config = ROOT / "config" / "device-fleet.json"
    if not config.exists():
        print("Run npm run fleet:enroll before installing the station", file=sys.stderr)
        return 2
    start_script = ROOT / "start-local.sh"
    supervisor_source = (ROOT / "bridge" / "fleet_supervisor.ts").read_text("utf-8")
    if 'PHONEBASE_BLACK_AUTO_HOME: "0"' not in supervisor_source:
        print("Fleet runtime does not explicitly disable automatic Home", file=sys.stderr)
        return 2
    if not (ROOT / ".vinext").exists():
        print("Build the Dashboard with npm run build before installation", file=sys.stderr)
        return 2

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": ["/bin/zsh", str(start_script)],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Interactive",
        "ThrottleInterval": 5,
        "EnvironmentVariables": {
            "PATH": os.environ.get(
                "PATH",
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            ),
            "PHONEBASE_BLACK_AUTO_HOME": "0",
            "PHONEBASE_FLEET_CONFIG": str(config),
        },
        "StandardOutPath": str(LOG_DIR / "launchd.out.log"),
        "StandardErrorPath": str(LOG_DIR / "launchd.err.log"),
    }
    with TARGET.open("wb") as handle:
        plistlib.dump(payload, handle)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain, str(TARGET)], check=False)
    subprocess.run(["launchctl", "bootstrap", domain, str(TARGET)], check=True)
    subprocess.run(["launchctl", "enable", f"{domain}/{LABEL}"], check=True)
    print(f"Installed {TARGET}")
    print("Automatic Home is disabled; newly enrolled devices remain locked for setup.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
