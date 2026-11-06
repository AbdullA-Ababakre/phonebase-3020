#!/bin/zsh
set -euo pipefail

phonebase_dir="${0:A:h:h}"
cd "$phonebase_dir"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Phonebase currently supports macOS only."
  exit 1
fi

missing=()
for command_name in node npm python3 ffmpeg swift; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing+=("$command_name")
  fi
done

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if (( node_major < 22 )); then
    missing+=("Node.js 22+")
  fi
fi

if (( ${#missing[@]} > 0 )); then
  print -u2 "Phonebase needs: ${missing[*]}"
  print -u2 "Install the missing runtime, then run this setup again."
  print -u2 "With Homebrew: brew install node@22 ffmpeg python"
  print -u2 "For Swift tools: xcode-select --install"
  exit 2
fi

print "Phonebase system check passed."
print "Installing the local application…"
npm install
./scripts/build-camera-broker-macos.sh

cli_dir="${PHONEBASE_CLI_DIRECTORY:-$HOME/.phonebase/bin}"
mkdir -p "$cli_dir"
ln -sfn "$phonebase_dir/bin/phonebase.mjs" "$cli_dir/phonebase"
chmod +x "$phonebase_dir/bin/phonebase.mjs" "$cli_dir/phonebase"

profile_file="$HOME/.zprofile"
path_line="export PATH=\"$cli_dir:\$PATH\" # Phonebase CLI"
if ! grep -Fq "Phonebase CLI" "$profile_file" 2>/dev/null; then
  print "" >> "$profile_file"
  print -r -- "$path_line" >> "$profile_file"
fi

print ""
print "Setup complete."
print "1. Connect one Phonebase controller and one UVC camera."
print "2. Run: $cli_dir/phonebase onboard --prepared"
print "3. Open: http://127.0.0.1:3020"
