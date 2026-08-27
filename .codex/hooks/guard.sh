#!/usr/bin/env bash
# codex PreToolUse → 禁じ手の門。判定は honden guard に集約し、ここは薄い皮。
# 足跡は試験の間だけ（HONDEN_GUARD_TRACE が指す先へ）。
IN=$(cat)
OUT=$(printf '%s' "$IN" | /mnt/c/Users/aki/work/honden/bin/honden guard hook codex)
if [ -n "${HONDEN_GUARD_TRACE:-}" ]; then
  printf '[%s] in=%s out=%s\n' "$(date -Is)" "$IN" "${OUT:-<allow>}" >> "$HONDEN_GUARD_TRACE"
fi
printf '%s' "$OUT"
