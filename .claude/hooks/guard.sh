#!/usr/bin/env bash
# 門の入口（Claude Code）。
#
# **道は己の在り処から解く。** 絶対で焼き付けると二つ困る。
#
# 一、公にすると、書いた者の利用者名と作業場の配置が出る
# 二、他所へ clone すると無い binary を指す
#
# ゆえに書の在り処から根を辿る。`HONDEN_BIN` があればそちらを優先する
# ——出陣の書（scripts/shutsujin.sh）と同じ流儀である。
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${HONDEN_BIN:-$ROOT/bin/honden}"

# **本体が居らぬ時、終了コードで断ってはならぬ。**
#
# Claude Code の作法では、PreToolUse hook を止めるのは `exit 2` か、
# `permissionDecision: "deny"` の JSON である。**`exit 1` は「止めぬ誤り」**で、
# 画面に出るだけで命はそのまま走る。
#
# はじめ `exit 1` で断っていた。つまり binary が無い機体では、
# **門が黙って素通りしていた**（2026-09-01 に自分で叩いて気づいた）。
# 門が居らぬまま通すのは、門を置いていないのと同じである。
#
# ゆえに拒みは**本体と同じ形の JSON**で言う。終了コードの読まれ方に依らぬ。
if [ ! -x "$BIN" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"guard: honden が居らぬゆえ検められぬ。検められぬ物は通さぬ。bun run build:all で建てられよ"}}'
  exit 0
fi

exec "$BIN" guard hook claude
