#!/bin/zsh
set -euo pipefail

phonebase_root="${0:A:h:h}"
application="$phonebase_root/build/PhonebaseCameraBroker.app"
contents="$application/Contents"
executable="$contents/MacOS/PhonebaseCameraBroker"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Phonebase Camera currently supports macOS only."
  exit 1
fi

command -v swiftc >/dev/null 2>&1 || {
  print -u2 "Swift compiler is unavailable. Install Apple command-line tools first."
  exit 2
}

mkdir -p "$contents/MacOS"
cp "$phonebase_root/resources/PhonebaseCameraBroker-Info.plist" "$contents/Info.plist"
swiftc -O "$phonebase_root/bridge/CameraBroker.swift" -o "$executable"
chmod +x "$executable"

if command -v codesign >/dev/null 2>&1; then
  # Keep a stable designated requirement across local rebuilds. The default
  # ad-hoc signature uses the executable CDHash, so every build otherwise looks
  # like a brand-new camera application to macOS privacy controls.
  codesign --force --sign - \
    --requirements '=designated => identifier "ai.phonebase.camera-broker"' \
    "$application" >/dev/null
fi

print "Phonebase Camera app built: $application"
