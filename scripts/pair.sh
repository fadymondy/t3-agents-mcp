#!/usr/bin/env bash
# macOS (including the bundled Bash 3.2) and Linux. Never enable shell tracing.
set +x
set -eu
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ! -t 0 ]]; then
  printf '%s\n' 'Run this helper in an interactive terminal, or use node dist/cli.js pair --stdin with protected input.' >&2
  exit 1
fi

secret=''
trap 'unset secret' EXIT
printf '%s' 'Paste your LOCAL or explicitly trusted T3 pairing link (hidden): ' >&2
IFS= read -r -s secret
printf '\n' >&2
printf '%s\n' "$secret" | node "$script_dir/../dist/cli.js" pair --stdin
