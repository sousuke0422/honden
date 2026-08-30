#!/usr/bin/env bats
# 携帯からの耳（shutsujin_departure.sh earpiece）の試験。
#
# 肝は**立てぬ判断**である。topic が無いのに立てれば、繋がらぬ curl を
# 延々と張り直す窓が残り、「立っておる」が「効いておる」に見える——
# 見張りの沈黙は健全に見えるゆえ、そこが最も危うい。

load helpers

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  stub_dir
  export HONDEN_TEST_ROOT="$ROOT"
  stub_tmux 0 agents            # 陣はある・ntfy 窓は無い
  # 我らの本体を贋物へ。**道が一箇所に寄っておるゆえ差し替えられる**
  export HONDEN_BIN="$STUB/honden"
  stub honden 0 "honden-9f3a2b7c1d5e"   # 既定は「topic は設定されておる」
}

run_ear() { run bash "$ROOT/shutsujin_departure.sh" earpiece; }

@test "topic が設定されておれば耳を立てる" {
  stub_tmux_grows 0 "agents" "agents
ntfy"
  run_ear
  assert_success
  # **成功と失敗を言い分ける。** 断りも「耳を立てたが窓が消えた」で始まるゆえ、
  # 「耳を立てた」だけを見ると**倒れた枝でも通ってしまう**（実際にそうなっておった）。
  assert_output --partial "topic は設定に在り"
  refute_output --partial "窓が消えた"
  run bash -c "grep -F 'new-window' '$CALLS'"
  assert_output --partial "ntfy"
}

@test "立てたのに窓が消えておれば、届かぬと言う（立てたつもりで黙らせぬ）" {
  stub_tmux 0 "agents"   # 立てても窓は生えぬ
  run_ear
  assert_success
  assert_output --partial "窓が消えた"
  assert_output --partial "届かぬ"
  refute_output --partial "topic は設定に在り"
}

@test "**topic が無ければ何も立てぬ**（繋がらぬ窓を残さぬ）" {
  stub honden 0 ""
  run_ear
  assert_success
  refute_output --partial "耳"
  run bash -c "grep -c 'new-window' '$CALLS' || true"
  assert_output "0"
}

@test "本体が答えぬ時も立てぬ（沈黙を topic と読み違えぬ）" {
  stub honden 1 ""
  run_ear
  assert_success
  run bash -c "grep -c 'new-window' '$CALLS' || true"
  assert_output "0"
}

@test "よその陣へは接がぬ（@honden の印が無い）" {
  export HONDEN_TEST_ROOT="/somewhere/else"
  run_ear
  assert_output --partial "我らの陣ではない"
  run bash -c "grep -c 'new-window' '$CALLS' || true"
  assert_output "0"
}

@test "既に耳があれば二本目を立てぬ" {
  stub_tmux 0 "agents
ntfy"
  run_ear
  assert_success
  assert_output --partial "既にある"
  run bash -c "grep -c 'new-window' '$CALLS' || true"
  assert_output "0"
}

@test "道に単引用符があっても命が壊れぬ（%q で包む）" {
  run bash -c "grep -n \"printf '%q'\" '$ROOT/scripts/shutsujin.sh' | grep -c qhonden"
  [ "$output" -ge 1 ]
}

@test "耳が落ちても張り直す輪の中で回す" {
  stub_tmux_grows 0 "agents" "agents
ntfy"
  run_ear
  run bash -c "grep -F 'new-window' '$CALLS'"
  assert_output --partial "while true"
  assert_output --partial "ntfy listen"
}
