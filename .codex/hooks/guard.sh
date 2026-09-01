#!/usr/bin/env bash
# 門の入口（Codex）。
#
# **道は己の在り処から解く。** 絶対で焼き付けると、公にした折に書いた者の
# 利用者名と作業場の配置が出る。加えて他所へ clone すれば無い binary を指す。
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${HONDEN_BIN:-$ROOT/bin/honden}"

IN=$(cat)

# **本体が居らぬ時、終了コードで断ってはならぬ。**
#
# 拒みは「拒みの JSON を吐く」ことで伝わる。無言なら通る。
# 終了コードの読まれ方は host 次第で、**非零を「意見なし＝通す」と読む作りなら
# 門が黙って素通りする**。はじめ `exit 1` で断っていたのがそれであった
# （2026-09-01 に自分で叩いて気づいた）。
#
# ゆえに本体と同じ形の JSON で言う。
if [ ! -x "$BIN" ]; then
  printf '%s' '{"permissionDecision":"deny","permissionDecisionReason":"guard: honden が居らぬゆえ検められぬ。検められぬ物は通さぬ。bun run build:all で建てられよ"}'
  exit 0
fi

OUT=$(printf '%s' "$IN" | "$BIN" guard hook codex)
if [ -n "${HONDEN_GUARD_TRACE:-}" ]; then
  printf '[%s] in=%s out=%s\n' "$(date -Is)" "$IN" "${OUT:-<allow>}" >> "$HONDEN_GUARD_TRACE"
fi
printf '%s' "$OUT"
