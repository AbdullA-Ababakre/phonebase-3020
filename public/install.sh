#!/bin/bash
set -euo pipefail

PRODUCT_NAME="PhoneUse"
DEFAULT_INSTALL_ROOT="$HOME/.phonebase"
DEFAULT_RELEASE_BASE_URL="https://phoneuse.com"
ARCHIVE_SHA256="5f5a3980456b41d238502c5b32f1d5b57498aa1562fe6e1156ae9f216a1c0455"

install_root="${PHONEBASE_INSTALL_ROOT:-$DEFAULT_INSTALL_ROOT}"
release_base_url="${PHONEBASE_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE_URL}"
archive_url="${PHONEBASE_ARCHIVE_URL:-$release_base_url/downloads/phonebase-macos.tgz}"
run_onboard=1
add_to_path=1
assume_yes=0
dry_run=0

usage() {
  cat <<'EOF'
Install PhoneUse on macOS.

Usage:
  curl -fsSL --proto '=https' --tlsv1.2 \
    https://phoneuse.com/install.sh | bash

Options:
  --dir PATH       Install under PATH instead of ~/.phonebase
  --no-onboard     Install without launching guided onboarding
  --no-path        Do not update ~/.zprofile
  --yes            Accept dependency installation prompts
  --dry-run        Show what would happen without changing the Mac
  --help            Show this help

Environment overrides:
  PHONEBASE_INSTALL_ROOT
  PHONEBASE_RELEASE_BASE_URL
  PHONEBASE_ARCHIVE_URL
  PHONEBASE_ARCHIVE_FILE (local package path; still checksum-verified)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      [[ $# -ge 2 ]] || { echo "--dir requires a path" >&2; exit 2; }
      install_root="$2"
      shift 2
      ;;
    --no-onboard)
      run_onboard=0
      shift
      ;;
    --no-path)
      add_to_path=0
      shift
      ;;
    --yes)
      assume_yes=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "$PRODUCT_NAME currently supports macOS only." >&2
  exit 1
fi

case "$install_root" in
  "$HOME"|"/"|"")
    echo "Refusing unsafe install directory: $install_root" >&2
    exit 2
    ;;
esac

app_dir="$install_root/app"
bin_dir="$install_root/bin"
backup_dir="$install_root/backups"
profile_file="$HOME/.zprofile"

if [[ "$dry_run" == "1" ]]; then
  cat <<EOF
PhoneUse install dry run
- Download: $archive_url
- Verify the published SHA-256 checksum
- Install runtime dependencies only when missing
- Build in a temporary staging directory
- Preserve local configuration, calibration, and runtime data
- Install application: $app_dir
- Install CLI: $bin_dir/phonebase
- Install localhost services on ports 3020 and 3013
- Never home or move the arm
EOF
  exit 0
fi

echo "PhoneUse macOS installer"
echo "Installation directory: $install_root"
echo

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple command-line tools are required. Opening the Apple installer…"
  xcode-select --install >/dev/null 2>&1 || true
  echo "Finish that installation, then run the PhoneUse installer again."
  exit 2
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/opt/node@22/bin:$PATH"

missing=()
for command_name in node npm python3 ffmpeg swift; do
  command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  [[ "$node_major" -ge 22 ]] || missing+=("Node.js 22+")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing runtime components: ${missing[*]}"
  if [[ "$assume_yes" != "1" && -t 0 ]]; then
    read -r -p "Install the missing components with Homebrew? [Y/n] " answer
    case "${answer:-y}" in
      y|Y|yes|YES) ;;
      *) echo "Installation cancelled."; exit 2 ;;
    esac
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "Installing Homebrew…"
    brew_installer="$(mktemp -t phonebase-homebrew.XXXXXX)"
    trap 'rm -f "$brew_installer"' EXIT
    curl -fsSL --proto '=https' --tlsv1.2 \
      https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
      -o "$brew_installer"
    NONINTERACTIVE=1 /bin/bash "$brew_installer"
    rm -f "$brew_installer"
    trap - EXIT
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  fi
  brew install node@22 ffmpeg python
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

for command_name in node npm python3 ffmpeg swift curl tar shasum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is still unavailable: $command_name" >&2
    exit 2
  }
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$node_major" -lt 22 ]]; then
  echo "PhoneUse requires Node.js 22 or newer." >&2
  exit 2
fi

temporary="$(mktemp -d -t phonebase-install.XXXXXX)"
stage_dir="$install_root/app.stage.$$"
cleanup() {
  rm -rf "$temporary"
  if [[ -d "$stage_dir" ]]; then rm -rf "$stage_dir"; fi
}
trap cleanup EXIT INT TERM

archive="$temporary/phonebase-macos.tgz"
if [[ -n "${PHONEBASE_ARCHIVE_FILE:-}" ]]; then
  [[ -f "$PHONEBASE_ARCHIVE_FILE" ]] || {
    echo "Local PhoneUse package does not exist: $PHONEBASE_ARCHIVE_FILE" >&2
    exit 2
  }
  echo "Reading local PhoneUse package…"
  cp "$PHONEBASE_ARCHIVE_FILE" "$archive"
else
  echo "Downloading PhoneUse…"
  curl -fL --proto '=https' --tlsv1.2 "$archive_url" -o "$archive"
fi

if [[ ! "$ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "The published installer has no release checksum. Installation stopped." >&2
  exit 3
fi
actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual_sha256" != "$ARCHIVE_SHA256" ]]; then
  echo "PhoneUse download verification failed. Installation stopped." >&2
  exit 3
fi

mkdir -p "$install_root" "$bin_dir" "$backup_dir"
rm -rf "$stage_dir"
mkdir -p "$stage_dir"
tar -xzf "$archive" -C "$stage_dir" --strip-components 1

if [[ -d "$app_dir" ]]; then
  for relative in .env.local .env.supervisor config/device-fleet.json build/devices build/runtime; do
    if [[ -e "$app_dir/$relative" ]]; then
      mkdir -p "$(dirname "$stage_dir/$relative")"
      ditto "$app_dir/$relative" "$stage_dir/$relative"
    fi
  done
fi

echo "Building the local application…"
(
  cd "$stage_dir"
  npm ci
  npm run build
  ./scripts/build-camera-broker-macos.sh
)

if [[ -d "$app_dir" ]]; then
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$app_dir" "$backup_dir/app-$timestamp"
fi
mv "$stage_dir" "$app_dir"
ln -sfn "$app_dir/bin/phonebase.mjs" "$bin_dir/phonebase"
chmod +x "$app_dir/bin/phonebase.mjs" "$bin_dir/phonebase"

path_line="export PATH=\"$bin_dir:\$PATH\" # PhoneUse CLI"
if [[ "$add_to_path" == "1" ]] && ! grep -Fq 'PhoneUse CLI' "$profile_file" 2>/dev/null; then
  printf '\n%s\n' "$path_line" >> "$profile_file"
fi
export PATH="$bin_dir:$PATH"

echo
echo "PhoneUse installed successfully."
echo "CLI: $bin_dir/phonebase"
if [[ "$add_to_path" == "1" ]]; then
  echo "Open a new Terminal window before using the phonebase command."
fi

if [[ "$run_onboard" == "1" ]]; then
  "$bin_dir/phonebase" onboard --prepared
else
  echo "Run this when ready: $bin_dir/phonebase onboard --prepared"
fi

trap - EXIT INT TERM
rm -rf "$temporary"
