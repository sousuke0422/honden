#!/usr/bin/env bats
# 撤収（shutsujin_departure.sh down）。
#
# 主眼は一つ——**己が立てた陣だけを畳み、よその陣には手を出さぬ。**
# 判ずるのは名ではなく印（@honden）。印が無い、または別の置き場を指すなら畳まぬ。

load helpers

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  stub_dir
  export HONDEN_DB="$BATS_TEST_TMPDIR/h.db"
  # 贋 tmux は @honden にこれを答える。既定は「己の置き場」
  export HONDEN_TEST_ROOT="$ROOT"
  export PATH
}

@test "印が己の置き場を指す陣は畳む。働き手の陣が先" {
  stub_tmux 0
  run bash "$ROOT/shutsujin_departure.sh" down
  [ "$status" -eq 0 ]
  called_with "tmux kill-session" "=honden-agents"
  called_with "tmux kill-session" "=honden"
  # 順: 働き手 → 将軍
  first=$(grep -n "^tmux kill-session" "$CALLS" | head -1)
  [[ "$first" == *"honden-agents"* ]]
  [[ "$output" == *"honden-agents を畳んだ"* ]]
}

@test "**印がよその置き場を指す陣は、名が同じでも畳まぬ**" {
  stub_tmux 0
  export HONDEN_TEST_ROOT="/somewhere/else"
  run bash "$ROOT/shutsujin_departure.sh" down
  [ "$status" -eq 0 ]
  ! called "tmux kill-session"
  [[ "$output" == *"我らの陣ではない"* ]]
}

@test "印そのものが無い陣は畳まぬ（fail-closed）" {
  stub_tmux 0
  export HONDEN_TEST_ROOT=""
  run bash "$ROOT/shutsujin_departure.sh" down
  ! called "tmux kill-session"
  [[ "$output" == *"畳まぬ"* ]]
}

@test "立っておらぬ陣には何もせぬ" {
  stub_tmux 1
  run bash "$ROOT/shutsujin_departure.sh" down
  [ "$status" -eq 0 ]
  ! called "tmux kill-session"
  [[ "$output" == *"立っておらぬ"* ]]
}

@test "陣の名を差し替えても、その名で畳む" {
  stub_tmux 0
  HONDEN_SESSION_AGENTS=jin-a HONDEN_SESSION_SHOGUN=jin-s run bash "$ROOT/shutsujin_departure.sh" down
  called_with "tmux kill-session" "=jin-a"
  called_with "tmux kill-session" "=jin-s"
}
