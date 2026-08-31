#!/usr/bin/env bash
# 門の入口（Claude Code）。
#
# **道は己の在り処から解く。** 絶対で焼き付けると二つ困る。
#
# 一、公にすると、書いた者の利用者名と作業場の配置が出る
# 二、他所へ clone すると**無い binary を指し、黙って守りが止まる**
#     （倒れるなら気づけるが、黙るのは気づけぬ・点検が釣った 2026-09-01）
#
# ゆえに書の在り処から根を辿る。`HONDEN_BIN` があればそちらを優先する
# ——出陣の書（scripts/shutsujin.sh）と同じ流儀である。
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${HONDEN_BIN:-$ROOT/bin/honden}"

# **無ければ黙って通さぬ。** 門が居らぬまま素通りさせるのは、
# 門を置いていないのと同じである。人が読める形で断る。
if [ ! -x "$BIN" ]; then
  echo "guard: honden が居らぬ（$BIN）。建ててから使われよ: bun run build:all" >&2
  exit 1
fi

exec "$BIN" guard hook claude
