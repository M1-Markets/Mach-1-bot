#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bot_workspace="packages/mach1_bot"

tmp_dir="${TMPDIR:-/tmp}/mach-one-bot-session-$(date +%Y%m%d)"

if [[ ! -d "$tmp_dir" ]]; then
    mkdir -p "$tmp_dir"
    echo "Creating persistent temp session directory: $tmp_dir"
else
    echo "Using existing temp session directory: $tmp_dir"
fi

if [[ $# -eq 0 ]]; then
    echo "No arguments passed. Defaulting to 'run --dry-run' in temp session directory."
    set -- run --dry-run
fi

quoted_args=()
for arg in "$@"; do
    quoted_args+=("$(printf '%q' "$arg")")
done

cmd="cd '$tmp_dir' && exec mach-one-bot ${quoted_args[*]}"
echo "Running mach-one-bot in temp session directory: $tmp_dir"
echo "Building mach-one-bot CLI..."
npm --prefix "$repo_root" --workspace "$bot_workspace" run build:cli
echo "Command: $cmd"

(
    pushd "$tmp_dir" >/dev/null
    npm --prefix "$repo_root" --workspace "$bot_workspace" exec -- mach-one-bot "$@"
    popd >/dev/null
)
