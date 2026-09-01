#!/usr/bin/env bash
# macOS の Finder から二度打ちで起きる形。中身は configure-agents.sh と同じ。
# Finder は cwd を継がぬので、己の在処へ移ってから呼ぶ。閉じる前に一度止まる。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
bash "$ROOT/configure-agents.sh" "$@" || { echo ""; read -r -p "  Enter で閉じる…"; exit 1; }
echo ""
read -r -p "  Enter で閉じる…"
