#!/usr/bin/env bash
# Run a development command with the repository's Node/pnpm versions and Rust.
set -eo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: bash scripts/with-dev-env.sh <command> [args...]" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
if [ -s "$nvm_script" ]; then
  source "$nvm_script"
  nvm use --silent "$(cat "$repo_root/.nvmrc")"
fi

if [ -s "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

if ! command -v corepack >/dev/null 2>&1; then
  echo "Corepack is required. Load the Node version in .nvmrc before running this command." >&2
  exit 1
fi

# Put Corepack before an old global pnpm, including in nested package scripts.
# Temporary shims leave the user's global Node and pnpm installations untouched.
toolchain_bin=$(mktemp -d "${TMPDIR:-/tmp}/smart-beat-toolchain.XXXXXX")
trap 'rm -rf -- "$toolchain_bin"' EXIT
corepack enable --install-directory "$toolchain_bin" pnpm
export PATH="$toolchain_bin:$PATH"

"$@"
