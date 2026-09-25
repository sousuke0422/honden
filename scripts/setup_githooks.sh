#!/usr/bin/env bash
# この repo の git hooks を .githooks に据える（local の core.hooksPath のみ）。
# global の ~/.git-hooks（Assisted-by）は prepare-commit-msg から明示的に呼ぶ。

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

chmod +x .githooks/prepare-commit-msg .githooks/commit-msg .githooks/lib/strip-cursor-trailers.sh 2>/dev/null || true

git config core.hooksPath .githooks
echo "  core.hooksPath → .githooks（この clone / worktree の local 設定）"
