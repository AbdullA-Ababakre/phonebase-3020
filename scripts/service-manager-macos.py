#!/usr/bin/env python3
"""Install and manage the local Phonebase macOS LaunchAgents."""

from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent.parent
LAUNCH_AGENTS = Path.home() / "Library" / "LaunchAgents"
RUNTIME = ROOT / ".runtime"
DOMAIN = f"gui/{os.getuid()}"


def npm_path() -> str:
    value = shutil.which("npm")
    if not value:
        raise RuntimeError("npm is not available. Run phonebase setup first.")
    return str(Path(value).resolve())


def environment() -> dict[str, str]:
    path = os.environ.get(
        "PATH",
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    )
    node22 = Path("/opt/homebrew/opt/node@22/bin")
    if node22.exists() and str(node22) not in path.split(":"):
        path = f"{node22}:{path}"
    return {"PATH": path}


def services() -> list[dict[str, object]]:
    npm = npm_path()
    camera_app = ROOT / "build" / "PhonebaseCameraBroker.app"
    fleet_environment = {"PHONEBASE_FLEET_START_CONTROL_PLANE": "0"}
    if camera_app.exists():
        fleet_environment["PHONEBASE_CAMERA_BROKER_APP"] = str(camera_app)
    return [
        {
            "label": "com.phonebase.control-plane",
            "arguments": [npm, "run", "control-plane"],
            "environment": {
                "PHONEBASE_CONTROL_PLANE_HOST": "127.0.0.1",
                "PHONEBASE_CONTROL_PLANE_PORT": "3013",
                "PHONEBASE_CALIBRATION_DIRECTORY": str(ROOT / "build" / "devices"),
            },
        },
        {
            "label": "com.phonebase.fleet",
            "arguments": [npm, "run", "fleet"],
            "environment": fleet_environment,
        },
        {
            "label": "com.phonebase.vision",
            "arguments": [npm, "run", "vision"],
            "environment": {
                "PHONEBASE_AUTO_SETUP_HOST": "127.0.0.1",
                "PHONEBASE_AUTO_SETUP_PORT": "3031",
                "PHONEBASE_CONTROL_PLANE_URL": "http://127.0.0.1:3013",
                "PHONEBASE_AUTO_SETUP_STATE_DIRECTORY": str(RUNTIME / "auto-setup"),
            },
        },
        {
            "label": "com.phonebase.dashboard",
            "arguments": [npm, "run", "start:3020"],
            "environment": {},
        },
    ]


def target(label: str) -> Path:
    return LAUNCH_AGENTS / f"{label}.plist"


def run(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(arguments, check=check, text=True, capture_output=not check)


def write_service(service: dict[str, object]) -> None:
    label = str(service["label"])
    payload = {
        "Label": label,
        "ProgramArguments": service["arguments"],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 3,
        "EnvironmentVariables": {
            **environment(),
            **dict(service["environment"]),
        },
        "StandardOutPath": str(RUNTIME / f"{label.rsplit('.', 1)[-1]}.log"),
        "StandardErrorPath": str(RUNTIME / f"{label.rsplit('.', 1)[-1]}-error.log"),
    }
    path = target(label)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("wb") as handle:
        plistlib.dump(payload, handle)
    os.replace(temporary, path)


def bootout(label: str) -> None:
    run("launchctl", "bootout", f"{DOMAIN}/{label}", check=False)


def wait_until_unloaded(label: str, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = run("launchctl", "print", f"{DOMAIN}/{label}", check=False)
        if result.returncode != 0:
            return
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {label} to stop.")


def start_service(label: str) -> None:
    path = target(label)
    result = run("launchctl", "bootstrap", DOMAIN, str(path), check=False)
    if result.returncode != 0 and "already" not in (result.stderr or "").lower():
        # A loaded service may report a generic bootstrap error. Kickstart is
        # the authoritative final operation and will fail clearly if absent.
        pass
    run("launchctl", "enable", f"{DOMAIN}/{label}")
    run("launchctl", "kickstart", "-k", f"{DOMAIN}/{label}")


def install() -> None:
    if sys.platform != "darwin":
        raise RuntimeError("Phonebase local services currently support macOS only.")
    LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    configured = services()
    for service in configured:
        bootout(str(service["label"]))
    for service in configured:
        wait_until_unloaded(str(service["label"]))
    for service in configured:
        write_service(service)
    for service in configured:
        start_service(str(service["label"]))
    print("Phonebase services installed.")
    print("Dashboard: http://127.0.0.1:3020")
    print("Control API: http://127.0.0.1:3013")
    print("Phone recognition: http://127.0.0.1:3031")


def start() -> None:
    for service in services():
        label = str(service["label"])
        if not target(label).exists():
            raise RuntimeError("Phonebase services are not installed. Run phonebase onboard.")
        start_service(label)
    print("Phonebase services started.")


def stop() -> None:
    for service in reversed(services()):
        bootout(str(service["label"]))
    print("Phonebase services stopped.")


def status() -> None:
    values: list[dict[str, object]] = []
    for service in services():
        label = str(service["label"])
        result = run("launchctl", "print", f"{DOMAIN}/{label}", check=False)
        values.append({"label": label, "loaded": result.returncode == 0})
    print(json.dumps({"services": values}, indent=2))


def uninstall() -> None:
    stop()
    for service in services():
        path = target(str(service["label"]))
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    print("Phonebase background services removed. Local data was preserved.")


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    actions = {
        "install": install,
        "start": start,
        "stop": stop,
        "restart": lambda: (stop(), time.sleep(0.5), start()),
        "status": status,
        "uninstall": uninstall,
    }
    if action not in actions:
        print(f"Unknown service action: {action}", file=sys.stderr)
        return 2
    try:
        actions[action]()
        return 0
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Phonebase service manager: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
