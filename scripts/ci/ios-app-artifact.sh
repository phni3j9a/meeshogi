#!/usr/bin/env bash
set -euo pipefail

# Package the built iOS Simulator app separately from the UI acceptance run.
# The archive is reusable only when the product inputs that produced it still
# have the same content. The workflow is part of the build contract; Maestro
# flows, CI harness scripts, and docs remain outside this fingerprint so that
# acceptance-only changes do not require a forty-minute native rebuild.

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

usage() {
  cat >&2 <<'EOF'
usage:
  ios-app-artifact.sh package <simulator-app> <artifact-directory>
  ios-app-artifact.sh verify <artifact-directory> [diagnostics-directory] [expected-source-sha] [expected-run-id]
  ios-app-artifact.sh restore <artifact-directory> <products-directory>
EOF
  exit 2
}

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$repo_root" "$1" ;;
  esac
}

hash_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

source_files() {
  local file_list=$1
  local source_root
  local path
  local root_file_list="$file_list"

  # These directories are the inputs used to make the product bundle. The
  # generated CocoaPods framework is build output and is deliberately omitted.
  for source_root in app src modules native assets scripts/engine; do
    if [[ -d "$source_root" ]]; then
      find "$source_root" -type f -print >> "$file_list"
    fi
  done
  if [[ -f scripts/generate-notices.mjs ]]; then
    printf '%s\n' 'scripts/generate-notices.mjs' >> "$root_file_list"
  fi
  # The replay must use an app built under this exact CI/build contract. A
  # workflow change therefore requires a fresh native artifact.
  printf '%s\n' '.github/workflows/mobile.yml' >> "$root_file_list"

  # Keep root-level build/configuration inputs explicit. Globs that have no
  # match are harmless because each candidate is checked with -f first.
  for path in \
    app.json app.config.js app.config.cjs app.config.mjs app.config.ts \
    package.json package-lock.json .npmrc .nvmrc .yarnrc .yarnrc.yml \
    expo-env.d.ts index.js index.ts index.tsx; do
    if [[ -f "$path" ]]; then
      printf '%s\n' "$path" >> "$root_file_list"
    fi
  done
  for path in tsconfig*.json babel.config.* metro.config.* react-native.config.*; do
    if [[ -f "$path" ]]; then
      printf '%s\n' "$path" >> "$root_file_list"
    fi
  done
}

is_fingerprint_input() {
  local path=$1
  case "$path" in
    # Generated native output is copied into this directory by build-ios.sh.
    modules/sekirei/ios/generated/*) return 1 ;;
    modules/*/build/*|modules/*/jniLibs/*) return 1 ;;
    native/target/*|native/*/target/*) return 1 ;;
  esac
  return 0
}

generate_fingerprint() {
  local output_dir=$1
  local temp_dir
  local raw_files
  local sorted_files
  local manifest
  local path
  local digest

  mkdir -p "$output_dir"
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/meeshogi-ios-fingerprint.XXXXXX")
  raw_files="$temp_dir/raw-files.txt"
  sorted_files="$temp_dir/sorted-files.txt"
  manifest="$output_dir/source-manifest.txt"
  : > "$raw_files"
  source_files "$raw_files"

  # find emits paths without a leading ./ for the source roots and the root
  # globs above do the same. Sorting makes the digest independent of traversal
  # order. Files with an unusual newline in their name are outside the product
  # source convention and are rejected rather than hashed ambiguously.
  LC_ALL=C sort -u "$raw_files" | sed 's#^\./##' > "$sorted_files"
  if LC_ALL=C grep -q '[[:cntrl:]]' "$sorted_files"; then
    echo 'Product source contains a control character in a path.' >&2
    rm -rf "$temp_dir"
    return 1
  fi

  {
    printf '%s\n' 'meeshogi-ios-source-fingerprint-v1'
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      is_fingerprint_input "$path" || continue
      if [[ ! -f "$path" ]]; then
        echo "Fingerprint input disappeared while hashing: $path" >&2
        rm -rf "$temp_dir"
        return 1
      fi
      digest=$(hash_file "$path")
      printf '%s  %s\n' "$digest" "$path"
    done < "$sorted_files"
  } > "$manifest"

  hash_file "$manifest" > "$output_dir/source-fingerprint.txt"
  rm -rf "$temp_dir"
}

write_metadata() {
  local artifact_dir=$1
  local archive=$2
  {
    printf 'artifact_format=meeshogi-ios-simulator-v1\n'
    printf 'archive=%s\n' "$(basename "$archive")"
    printf 'source_fingerprint=%s\n' "$(cat "$artifact_dir/source-fingerprint.txt")"
    printf 'git_sha=%s\n' "${GITHUB_SHA:-unknown}"
    printf 'run_id=%s\n' "${GITHUB_RUN_ID:-unknown}"
    printf 'run_attempt=%s\n' "${GITHUB_RUN_ATTEMPT:-unknown}"
    printf 'ref=%s\n' "${GITHUB_REF:-unknown}"
    printf 'workflow=%s\n' "${GITHUB_WORKFLOW:-unknown}"
    printf 'runner_os=%s\n' "${RUNNER_OS:-unknown}"
    printf 'developer_dir=%s\n' "${DEVELOPER_DIR:-unknown}"
    if command -v xcodebuild >/dev/null 2>&1; then
      xcode_version=$(xcodebuild -version 2>/dev/null | tr '\n' ';')
      printf 'xcode_version=%s\n' "$xcode_version"
    else
      printf 'xcode_version=unknown\n'
    fi
  } > "$artifact_dir/build-metadata.txt"
}

package_app() {
  local app_path
  local artifact_dir
  local archive

  [[ $# -eq 2 ]] || usage
  app_path=$(absolute_path "$1")
  artifact_dir=$(absolute_path "$2")
  [[ -d "$app_path" ]] || { echo "Simulator app does not exist: $app_path" >&2; exit 1; }
  [[ -f "$app_path/Info.plist" ]] || { echo "Simulator app has no Info.plist: $app_path" >&2; exit 1; }
  command -v ditto >/dev/null 2>&1 || { echo 'ditto is required to package the iOS app.' >&2; exit 1; }

  rm -rf "$artifact_dir"
  mkdir -p "$artifact_dir"
  generate_fingerprint "$artifact_dir"
  archive="$artifact_dir/meeshogi-ios-simulator.zip"
  ditto -c -k --sequesterRsrc --keepParent "$app_path" "$archive"
  [[ -f "$archive" ]] || { echo "Failed to create app archive: $archive" >&2; exit 1; }
  hash_file "$archive" > "$artifact_dir/app-archive-sha256.txt"
  write_metadata "$artifact_dir" "$archive"
  echo "Packaged reusable iOS Simulator app: $archive"
}

copy_diagnostics() {
  local artifact_dir=$1
  local diagnostics_dir=$2
  [[ -n "$diagnostics_dir" ]] || return 0
  mkdir -p "$diagnostics_dir"
  for path in source-fingerprint.txt source-manifest.txt build-metadata.txt app-archive-sha256.txt; do
    [[ -f "$artifact_dir/$path" ]] && cp "$artifact_dir/$path" "$diagnostics_dir/artifact-$path"
  done
}

metadata_value() {
  local key=$1
  local metadata_file=$2
  awk -F= -v key="$key" \
    '$1 == key { sub(/^[^=]*=/, ""); print; found=1; exit } END { if (!found) exit 1 }' \
    "$metadata_file"
}

verify_artifact() {
  local artifact_dir
  local diagnostics_dir=${2:-}
  local expected_source_sha=${3:-}
  local expected_run_id=${4:-}
  local current_dir
  local expected_fingerprint
  local actual_fingerprint
  local expected_archive_sha
  local actual_archive_sha
  local metadata_source_sha
  local metadata_run_id
  local archive

  [[ $# -ge 1 && $# -le 4 ]] || usage
  artifact_dir=$(absolute_path "$1")
  [[ -d "$artifact_dir" ]] || { echo "Artifact directory does not exist: $artifact_dir" >&2; exit 1; }
  [[ -f "$artifact_dir/meeshogi-ios-simulator.zip" ]] \
    || { echo 'Reusable iOS artifact archive is missing.' >&2; exit 1; }
  [[ -f "$artifact_dir/source-fingerprint.txt" ]] \
    || { echo 'Reusable iOS artifact fingerprint is missing.' >&2; exit 1; }
  [[ -f "$artifact_dir/build-metadata.txt" ]] \
    || { echo 'Reusable iOS artifact build metadata is missing.' >&2; exit 1; }
  [[ -f "$artifact_dir/app-archive-sha256.txt" ]] \
    || { echo 'Reusable iOS artifact archive checksum is missing.' >&2; exit 1; }

  if [[ -n "$expected_source_sha" || -n "$expected_run_id" ]]; then
    [[ -n "$expected_source_sha" && -n "$expected_run_id" ]] \
      || { echo 'Expected source SHA and run ID must be supplied together.' >&2; exit 1; }
    metadata_source_sha=$(metadata_value git_sha "$artifact_dir/build-metadata.txt") \
      || { echo 'Artifact build metadata has no git_sha.' >&2; exit 1; }
    metadata_run_id=$(metadata_value run_id "$artifact_dir/build-metadata.txt") \
      || { echo 'Artifact build metadata has no run_id.' >&2; exit 1; }
    [[ "$metadata_source_sha" == "$expected_source_sha" ]] \
      || { echo 'Artifact git_sha does not match the source workflow run.' >&2; exit 1; }
    [[ "$metadata_run_id" == "$expected_run_id" ]] \
      || { echo 'Artifact run_id does not match the source workflow run.' >&2; exit 1; }
  fi

  copy_diagnostics "$artifact_dir" "$diagnostics_dir"
  current_dir=$(mktemp -d "${TMPDIR:-/tmp}/meeshogi-ios-current.XXXXXX")
  generate_fingerprint "$current_dir"
  cp "$current_dir/source-fingerprint.txt" "$artifact_dir/current-source-fingerprint.txt"
  cp "$current_dir/source-manifest.txt" "$artifact_dir/current-source-manifest.txt"
  [[ -n "$diagnostics_dir" ]] && {
    cp "$current_dir/source-fingerprint.txt" "$diagnostics_dir/current-source-fingerprint.txt"
    cp "$current_dir/source-manifest.txt" "$diagnostics_dir/current-source-manifest.txt"
  }

  expected_fingerprint=$(cat "$artifact_dir/source-fingerprint.txt")
  actual_fingerprint=$(cat "$current_dir/source-fingerprint.txt")
  if [[ "$expected_fingerprint" != "$actual_fingerprint" ]]; then
    echo 'iOS app artifact source fingerprint does not match the current checkout.' >&2
    diff -u "$artifact_dir/source-manifest.txt" "$current_dir/source-manifest.txt" >&2 || true
    rm -rf "$current_dir"
    exit 1
  fi

  archive="$artifact_dir/meeshogi-ios-simulator.zip"
  expected_archive_sha=$(cat "$artifact_dir/app-archive-sha256.txt")
  actual_archive_sha=$(hash_file "$archive")
  if [[ "$expected_archive_sha" != "$actual_archive_sha" ]]; then
    echo 'iOS app artifact archive checksum does not match its manifest.' >&2
    rm -rf "$current_dir"
    exit 1
  fi

  rm -rf "$current_dir"
  echo "Verified iOS app artifact source fingerprint: $actual_fingerprint"
}

restore_app() {
  local artifact_dir
  local products_dir
  local archive
  local app_path

  [[ $# -eq 2 ]] || usage
  artifact_dir=$(absolute_path "$1")
  products_dir=$(absolute_path "$2")
  verify_artifact "$artifact_dir"
  command -v ditto >/dev/null 2>&1 || { echo 'ditto is required to restore the iOS app.' >&2; exit 1; }
  archive="$artifact_dir/meeshogi-ios-simulator.zip"
  mkdir -p "$products_dir"
  rm -rf "$products_dir/meeshogi.app"
  ditto -x -k "$archive" "$products_dir"
  app_path="$products_dir/meeshogi.app"
  [[ -d "$app_path" && -f "$app_path/Info.plist" ]] \
    || { echo "Restored app is missing at expected path: $app_path" >&2; exit 1; }
  echo "Restored iOS Simulator app: $app_path"
}

[[ $# -ge 1 ]] || usage
command=$1
shift
case "$command" in
  package) package_app "$@" ;;
  verify) verify_artifact "$@" ;;
  restore) restore_app "$@" ;;
  *) usage ;;
esac
