#!/usr/bin/env bash
# Copyright 2026 Hall Boys, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# MCP4Acumatica — one-command installer.
#
# Usage:
#   curl -fsSL https://mcp4acumatica.hallboys.com/install.sh | bash
#
# Clones the repo, installs dependencies, and runs ./setup.sh. The
# setup script itself does the Cloudflare-side wiring (KV, R2,
# secrets, deploy) and runs a preflight against Acumatica.

set -euo pipefail

REPO="https://github.com/hallboys/MCP4Acumatica.git"
TARGET="${MCP4ACUMATICA_DIR:-MCP4Acumatica}"

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"
  RESET="$(printf '\033[0m')"
  BLUE="$(printf '\033[34m')"
  RED="$(printf '\033[31m')"
else
  BOLD="" RESET="" BLUE="" RED=""
fi

step() { printf "\n${BOLD}${BLUE}▶ %s${RESET}\n" "$*"; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

for bin in git node npm bash; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    err "Missing required binary: $bin"
    echo "   Install Node.js (includes npm) from https://nodejs.org and git from https://git-scm.com" >&2
    exit 1
  fi
done

if [ -e "$TARGET" ]; then
  err "'$TARGET' already exists in the current directory."
  echo "   Remove it, or set MCP4ACUMATICA_DIR to a different name, then re-run." >&2
  exit 1
fi

step "Cloning $REPO into $TARGET"
git clone --depth=1 "$REPO" "$TARGET"
cd "$TARGET"

step "Installing dependencies"
npm install

# When invoked via `curl | bash`, stdin is the pipe (the script), not the
# terminal. setup.sh prompts interactively, so we must hand it the tty.
step "Running setup.sh"
exec ./setup.sh < /dev/tty
