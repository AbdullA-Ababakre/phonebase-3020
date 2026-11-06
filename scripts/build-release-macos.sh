#!/bin/zsh
set -euo pipefail

phonebase_root="${0:A:h:h}"
archive_path="$phonebase_root/public/downloads/phonebase-macos.tgz"
checksum_path="$archive_path.sha256"
release_path="$phonebase_root/public/release.json"
installer_path="$phonebase_root/public/install.sh"
release_version="$(node -p "require('$phonebase_root/package.json').version")"
published_at="$(date -u +%Y-%m-%d)"
stage_root="$(mktemp -d -t phonebase-release.XXXXXX)"
stage_app="$stage_root/phonebase"
temporary_archive="$stage_root/phonebase-macos.tgz"

cleanup() {
  rm -rf "$stage_root"
}
trap cleanup EXIT INT TERM

mkdir -p "$stage_app"
while IFS= read -r -d $'\0' relative; do
  case "$relative" in
    public/downloads/phonebase-macos.tgz|public/downloads/phonebase-macos.tgz.sha256)
      continue
      ;;
  esac
  mkdir -p "$stage_app/${relative:h}"
  cp -p "$phonebase_root/$relative" "$stage_app/$relative"
done < <(git -C "$phonebase_root" ls-files -z)

# Avoid a checksum cycle inside the downloadable source package. The hosted
# installer is authoritative and contains the checksum for this archive.
perl -0pi -e \
  's/ARCHIVE_SHA256="[^"]+"/ARCHIVE_SHA256="__PHONEBASE_ARCHIVE_SHA256__"/' \
  "$stage_app/public/install.sh"

COPYFILE_DISABLE=1 tar -C "$stage_root" -czf "$temporary_archive" phonebase
archive_sha="$(shasum -a 256 "$temporary_archive" | awk '{print $1}')"
mkdir -p "${archive_path:h}"
mv "$temporary_archive" "$archive_path"
printf '%s  %s\n' "$archive_sha" "phonebase-macos.tgz" > "$checksum_path"

perl -0pi -e \
  "s/ARCHIVE_SHA256=\"[^\"]+\"/ARCHIVE_SHA256=\"$archive_sha\"/" \
  "$installer_path"
perl -0pi -e \
  "s/\"version\": \"[^\"]+\"/\"version\": \"$release_version\"/; s/\"sha256\": \"[a-f0-9]+\"/\"sha256\": \"$archive_sha\"/; s/\"publishedAt\": \"[^\"]+\"/\"publishedAt\": \"$published_at\"/" \
  "$release_path"

echo "Built Phonebase $release_version macOS release"
echo "SHA-256: $archive_sha"
