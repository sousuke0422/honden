#!/usr/bin/env bash
# beforeShellExecution → 禁じ手の門。判定は honden guard に集約し、ここは薄い皮。
cd "$(dirname "$0")/../.." || exit 1
exec ./bin/honden guard hook cursor
