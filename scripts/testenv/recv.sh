#!/usr/bin/env bash
# 試験の受け手。pane に打ち込まれた行を、時刻つきで残す。
#
# 本物の CLI の代わりに pane へ座る。nudge の send-keys（本文 + Enter）が
# read の一行になる。capture-pane で画面を読むより、ファイルに落ちた行の方が
# 検めやすく、消えぬ。
#
# C-c が来ると死ぬが、試験の布陣（fixtures/test-env）に copilot / kimi は
# 居らぬので、立て直しの Escape×2 + C-c は飛んで来ぬ。
AGENT="$1"; LOG="$2"
mkdir -p "$(dirname "$LOG")"
printf '[%s] %s の受け手が立った\n' "$(date -Is)" "$AGENT" >> "$LOG"
while IFS= read -r line; do
  printf '[%s] %s\n' "$(date -Is)" "$line" >> "$LOG"
done
