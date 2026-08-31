#!/usr/bin/env bash
# 門の入口（Codex）。
#
# **道は己の在り処から解く。** 絶対で焼き付けると、公にした折に書いた者の
# 利用者名と作業場の配置が出る。加えて他所へ clone すると無い binary を指し、
# **黙って守りが止まる**（点検が釣った・2026-09-01）。
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${HONDEN_BIN:-$ROOT/bin/honden}"

IN=$(cat)

# **門が居らぬなら止める。** 素通りさせれば、門を置いていないのと同じ。
if [ ! -x "$BIN" ]; then
  echo "guard: honden が居らぬ（$BIN）。建ててから使われよ: bun run build:all" >&2
  exit 1
fi

OUT=$(printf '%s' "$IN" | "$BIN" guard hook codex)
if [ -n "${HONDEN_GUARD_TRACE:-}" ]; then
  printf '[%s] in=%s out=%s\n' "$(date -Is)" "$IN" "${OUT:-<allow>}" >> "$HONDEN_GUARD_TRACE"
fi
printf '%s' "$OUT"
