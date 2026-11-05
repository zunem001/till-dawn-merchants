#!/usr/bin/env bash
# near/scripts/wsl.sh <cargo args...>   runs cargo on the contract from Windows' Linux: the build output stays on the Linux disk, away from the game's folder
source "$HOME/.cargo/env"
export CARGO_TARGET_DIR="$HOME/tdm-target"
cd "$(dirname "$0")/../contract" || exit 1
exec "$@"
