#!/usr/bin/env bash
# 試験の受け手。pane に打ち込まれた行を、時刻つきで残す。
#
# 本物の CLI の代わりに pane へ座る。nudge の send-keys（本文 + Enter）が
# read の一行になる。capture-pane で画面を読むより、ファイルに落ちた行の方が
# 検めやすく、消えぬ。
#
# C-c は無視する。本物の CLI は C-c で死なぬ（プロンプトが空くだけ）ゆえ、
# 受け手も死なぬ方が本物に近い。旧 watcher の Phase 3（claude 向け）は
# /clear の**前に C-c を打つ**——それで受け手が死に、pane ごと消えた
# （実測 2026-08-27。「Phase 2 の C-c は copilot/kimi だけ」という読みは
# 甘かった。Phase 3 は claude にも打つ）。
AGENT="$1"; LOG="$2"
trap '' INT
mkdir -p "$(dirname "$LOG")"
printf '[%s] %s の受け手が立った\n' "$(date -Is)" "$AGENT" >> "$LOG"
while IFS= read -r line; do
  printf '[%s] %s\n' "$(date -Is)" "$line" >> "$LOG"
done
