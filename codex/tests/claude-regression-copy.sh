#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 SOURCE_ROOT" >&2
  exit 64
fi

protected_paths=(
  "hooks/auto-approve.ps1"
  "hooks/destructive-guard.ps1"
  "hooks/hooks.json"
  "hooks/html-bundler.ps1"
  "hooks/lsp-autofix.ps1"
  "hooks/mx-tag-validator.ps1"
  "hooks/permission-request-guard.ps1"
  "hooks/spec-generator.ps1"
  "hooks/step-auto-continue.ps1"
  "hooks/step-obedience-guard.ps1"
  "hooks/step-progress-loader.ps1"
  "hooks/step-progress-writer.ps1"
  "hooks/trust5-validator.ps1"
  "hooks/validate-tools.ps1"
  "hooks/webapp-trigger.ps1"
  "tests/security-regression.ps1"
)

resolve_physical_directory() {
  [ -d "$1" ] || return 1
  (cd -P -- "$1" && pwd -P)
}

assert_strict_child() {
  child=$1
  parent=$2
  [ "$child" != "$parent" ] || return 1
  case "$parent" in
    /) prefix=/ ;;
    *) prefix=${parent%/}/ ;;
  esac
  case "$child" in
    "$prefix"*) return 0 ;;
    *) return 1 ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    echo "SHA256_TOOL_MISSING" >&2
    return 1
  fi
}

source_root=$(resolve_physical_directory "$1") || {
  echo "SOURCE_ROOT_INVALID: $1" >&2
  exit 1
}
temp_root=$(resolve_physical_directory "${TMPDIR:-/tmp}") || {
  echo "SYSTEM_TEMP_INVALID: ${TMPDIR:-/tmp}" >&2
  exit 1
}

before_hashes=()
for relative_path in "${protected_paths[@]}"; do
  protected_file=$source_root/$relative_path
  [ -f "$protected_file" ] || {
    echo "PROTECTED_PATH_NOT_FILE: $relative_path" >&2
    exit 1
  }
  before_hashes[${#before_hashes[@]}]=$(sha256_file "$protected_file")
done

stage_root=
stage_real=

verify_active_tree() {
  local hash_status=0
  local index
  local relative_path
  local protected_file
  local after_hash
  for index in "${!protected_paths[@]}"; do
    relative_path=${protected_paths[$index]}
    protected_file=$source_root/$relative_path
    if [ ! -f "$protected_file" ]; then
      echo "ACTIVE_TREE_CHANGED: $relative_path" >&2
      hash_status=1
      continue
    fi
    if ! after_hash=$(sha256_file "$protected_file"); then
      hash_status=1
      continue
    fi
    if [ "${before_hashes[$index]}" != "$after_hash" ]; then
      echo "ACTIVE_TREE_CHANGED: $relative_path" >&2
      hash_status=1
    fi
  done
  return "$hash_status"
}

cleanup() {
  original_status=$?
  final_status=$original_status
  trap - EXIT HUP INT TERM

  if ! verify_active_tree; then
    final_status=1
  fi

  if [ -n "$stage_root" ] && { [ -e "$stage_root" ] || [ -L "$stage_root" ]; }; then
    cleanup_real=$(resolve_physical_directory "$stage_root") || {
      echo "UNSAFE_TEMP_PATH: cannot physically resolve '$stage_root' for cleanup" >&2
      exit 1
    }
    if ! assert_strict_child "$cleanup_real" "$temp_root"; then
      echo "UNSAFE_TEMP_PATH: '$cleanup_real' is not a strict child of '$temp_root'" >&2
      exit 1
    fi
    if [ "$cleanup_real" != "$stage_real" ]; then
      echo "TEMP_PATH_CHANGED: '$stage_root' resolved as '$cleanup_real'" >&2
      exit 1
    fi
    rm -rf -- "$cleanup_real"
  fi

  exit "$final_status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

stage_root=$(mktemp -d "${temp_root%/}/harness50-claude-regression.XXXXXXXX")
stage_real=$(resolve_physical_directory "$stage_root") || {
  echo "UNSAFE_TEMP_PATH: cannot physically resolve '$stage_root'" >&2
  exit 1
}
if ! assert_strict_child "$stage_real" "$temp_root"; then
  echo "UNSAFE_TEMP_PATH: '$stage_real' is not a strict child of '$temp_root'" >&2
  exit 1
fi

tar \
  --exclude='.git' \
  --exclude='step_archive' \
  --exclude='node_modules' \
  --exclude='./hooks/*.log' \
  --exclude='./hooks/*.state' \
  --exclude='./hooks/*.beacon' \
  --exclude='./hooks/*.tmp' \
  --exclude='./hooks/*.tmp.*' \
  -C "$source_root" -cf - . | tar -C "$stage_real" -xf -

if find "$stage_real" -type l -print -quit | grep -q .; then
  echo "COPIED_ALIAS_REJECTED" >&2
  exit 1
fi
if find "$stage_real" \( -name .git -o -name step_archive -o -name node_modules \) -print -quit | grep -q .; then
  echo "COPY_EXCLUSION_FAILED" >&2
  exit 1
fi
for ignored_hook_file in \
  "$stage_real"/hooks/*.log \
  "$stage_real"/hooks/*.state \
  "$stage_real"/hooks/*.beacon \
  "$stage_real"/hooks/*.tmp \
  "$stage_real"/hooks/*.tmp.*; do
  if [ -e "$ignored_hook_file" ] || [ -L "$ignored_hook_file" ]; then
    echo "COPY_EXCLUSION_FAILED: $ignored_hook_file" >&2
    exit 1
  fi
done

copied_regression=$stage_real/tests/security-regression.sh
[ -f "$copied_regression" ] || {
  echo "COPIED_REGRESSION_MISSING" >&2
  exit 1
}

set +e
(cd -P -- "$stage_real" && bash "$copied_regression")
regression_status=$?
set -e

if [ "$regression_status" -ne 0 ]; then
  echo "CLAUDE_REGRESSION_FAILED: exit code $regression_status" >&2
  exit "$regression_status"
fi
verify_active_tree

echo "CLAUDE_REGRESSION_COPY_OK"
