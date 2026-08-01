#!/usr/bin/env bash
# Thin wrapper for Linux/macOS. Run `node setup.mjs` from the repo root.
set -euo pipefail
exec node setup.mjs "$@"
