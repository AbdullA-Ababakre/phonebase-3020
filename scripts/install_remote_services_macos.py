#!/usr/bin/env python3
"""Restore only the existing authenticated gateway and named tunnel, not hardware."""

import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
LABELS = ("com.phoneuse.remote-gateway", "com.phoneuse.public-console", "com.phoneuse.remote-tunnel")


def read_config(root, node):
    # Do not print secrets, put them in launchctl's global environment, or create
    # replacements: the gateway loads the station's existing private env files.
    result = subprocess.run([
        node, "--input-type=module", "-e", """
        import './shared/station-env.mjs';
        import { existsSync, readFileSync } from 'node:fs';
        import { resolve } from 'node:path';
        const e = process.env;
        const named = JSON.parse(readFileSync(resolve(e.PHONEBASE_REMOTE_NAMED_CONFIG_PATH || '.runtime/named-remote.json'), 'utf8'));
        const leases = resolve(e.PHONEBASE_RENTAL_LEASES_PATH || '.runtime/rental-leases.json');
        const secret = e.PHONEBASE_LEASE_SIGNING_SECRET || e.PHONEBASE_REMOTE_TOKEN || '';
        if ((e.PHONEBASE_REMOTE_TOKEN || '').length < 32 || secret.length < 32 || secret.length > 256)
          throw Error('Existing gateway/signing credentials are required');
        if (!existsSync(leases)) throw Error('Existing customer registry is missing');
        JSON.parse(readFileSync(leases, 'utf8'));
        const fleet = JSON.parse(readFileSync(resolve(e.PHONEBASE_FLEET_CONFIG || 'config/device-fleet.json'), 'utf8'));
        if (fleet.devices.some(d => [d.driverPort, d.cameraStreamPort, d.digitalStreamPort].includes(3040)))
          throw Error('Public Console port 3040 conflicts with a hardware service');
        console.log(JSON.stringify({ named, leases,
          host: e.PHONEBASE_REMOTE_HOST || '127.0.0.1',
          port: Number(e.PHONEBASE_REMOTE_PORT || 3015),
          upstream: e.PHONEBASE_REMOTE_UPSTREAM || 'http://127.0.0.1:3013',
          publicUrl: e.PHONEBASE_REMOTE_PUBLIC_URL,
          origins: e.PHONEBASE_REMOTE_ALLOWED_ORIGINS || '' }));
        """,
    ], cwd=root, capture_output=True, text=True)
    if result.returncode:
        raise ValueError("Station configuration validation failed; check private config locally")
    config = json.loads(result.stdout)
    named = config["named"]
    if named.get("version") != 1 or named.get("gatewayUrl") != config["publicUrl"]:
        raise ValueError("Named tunnel and station public URL must match")
    if not str(config["publicUrl"]).startswith("https://"):
        raise ValueError("An existing fixed HTTPS gateway is required")
    if config["host"] != "127.0.0.1" or config["port"] != 3015:
        raise ValueError("Expected the authenticated gateway on 127.0.0.1:3015")
    if config["upstream"] != "http://127.0.0.1:3013":
        raise ValueError("Check the existing localhost control upstream before installing")
    origins = [s.strip() for s in config["origins"].split(",") if s.strip()]
    if not origins or any(not s.startswith("https://") or "*" in s for s in origins):
        raise ValueError("Exact HTTPS allowed origins are required")
    token = Path(named["tokenFile"])
    if not token.is_absolute() or not token.is_file() or not token.stat().st_size:
        raise ValueError("Existing named tunnel token file is missing")
    if token.stat().st_uid != os.getuid() or token.stat().st_mode & 0o077:
        raise ValueError("Tunnel token must belong to this user and have mode 600")
    if not token.resolve().is_relative_to(root.resolve()):
        raise ValueError("Use the deployed runtime's private token, not a development checkout")
    return config


def service_payloads(root, node, cloudflared, token):
    logs = root / "build" / "runtime" / "remote"
    commands = (
        [node, "--import", "tsx", "bridge/remote_gateway.ts"],
        [node, "scripts/public_console_proxy.mjs"],
        [cloudflared, "tunnel", "--no-autoupdate", "--edge-ip-version", "4",
         "--protocol", "http2", "--metrics", "127.0.0.1:20241",
         "run", "--token-file", str(token)],
    )
    return [{
        "Label": label,
        "ProgramArguments": command,
        "WorkingDirectory": str(root),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "EnvironmentVariables": {
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
        "StandardOutPath": str(logs / f"{label}.out.log"),
        "StandardErrorPath": str(logs / f"{label}.err.log"),
    } for label, command in zip(LABELS, commands)]


def main():
    if sys.platform != "darwin":
        raise ValueError("This installer requires macOS")
    if sys.argv[1:] not in ([], ["--check"], ["--without-tunnel"]):
        raise ValueError("Usage: install_remote_services_macos.py [--check | --without-tunnel]")
    node, cloudflared = shutil.which("node"), shutil.which("cloudflared")
    if not node or not cloudflared:
        raise ValueError("Install node and cloudflared first")
    config = read_config(ROOT, node)
    payloads = service_payloads(ROOT, node, cloudflared, config["named"]["tokenFile"])
    if "--check" in sys.argv:
        print("Existing named tunnel, credentials, customer registry and localhost gateway configuration validated.")
        return
    if "--without-tunnel" in sys.argv:
        payloads = payloads[:-1]
    domain = f"gui/{os.getuid()}"
    directory = Path.home() / "Library" / "LaunchAgents"
    directory.mkdir(parents=True, exist_ok=True)
    (ROOT / "build" / "runtime" / "remote").mkdir(parents=True, exist_ok=True)
    for payload in payloads:
        label = payload["Label"]
        target = directory / f"{label}.plist"
        temporary = target.with_suffix(".plist.tmp")
        with temporary.open("wb") as handle:
            plistlib.dump(payload, handle)
        temporary.replace(target)
        # Only these remote services are touched; never restart the fleet.
        subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], capture_output=True)
        deadline = time.monotonic() + 10
        while subprocess.run(["launchctl", "print", f"{domain}/{label}"], capture_output=True).returncode == 0:
            if time.monotonic() > deadline:
                raise ValueError(f"Timed out unloading {label}; no hardware services were touched")
            time.sleep(0.1)
        subprocess.run(["launchctl", "enable", f"{domain}/{label}"], check=True)
        subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True)
        print(f"Installed {label}")
    print("Login autostart and crash recovery enabled. No hardware services or credentials changed.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"Remote service setup failed: {error}", file=sys.stderr)
        raise SystemExit(1)
