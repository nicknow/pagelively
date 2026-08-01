#!/usr/bin/env pwsh
# Thin wrapper for Windows PowerShell. Run `node setup.mjs` from the repo root.
$ErrorActionPreference = "Stop"
& node setup.mjs @args
