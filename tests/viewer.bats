#!/usr/bin/env bats
# 戦況の窓（shutsujin_departure.sh viewer）の試験。
#
# tmux・ss・curl を贋物に差し替え、**根の入口から**叩く。関数を直に呼ぶより、
# 実際に使われる道を通した方が入口の綻びまで拾える。

load helpers

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  stub_dir
  export HONDEN_VIEWER_SETTLE=0   # 贋物ゆえ待つ意味が無い
}

run_viewer() { run bash "$ROOT/shutsujin_departure.sh" viewer; }

@test "口が塞がっておれば窓を立てぬ" {
  stub ss 0 "LISTEN 0 512 127.0.0.1:8788 0.0.0.0:*"
  stub tmux 0
  run_viewer
  assert_success
  assert_output --partial "既に塞がっておる"
  # 二本目を立てようとしてはならぬ
  ! called_with tmux "new-window"
}

@test "窓が既にあれば立て直さぬ" {
  stub ss 0 ""
  stub tmux 0 "viewer"
  run_viewer
  assert_success
  assert_output --partial "既にある"
  ! called_with tmux "new-window"
}

@test "空いておれば窓を立て、叩いて確かめる" {
  stub ss 0 ""
  stub tmux 0 "agents"
  stub curl 0
  run_viewer
  assert_success
  called_with tmux "new-window"
  called_with tmux "viewer"
  called curl                      # 立てたと言う前に叩いておる
  assert_output --partial "窓を開いた"
}

@test "立てても応えねば、そう言う（黙って成功と言わぬ）" {
  stub ss 0 ""
  stub tmux 0 "agents"
  stub curl 7                      # 繋がらぬ
  run_viewer
  assert_output --partial "応えぬ"
  refute_output --partial "窓を開いた"
}

@test "口の見分けは厳密（18788 を 8788 と取り違えぬ）" {
  stub ss 0 "LISTEN 0 512 127.0.0.1:18788 0.0.0.0:*"
  stub tmux 0 "agents"
  stub curl 0
  run_viewer
  refute_output --partial "既に塞がっておる"
  called_with tmux "new-window"
}

@test "口と繋ぎ先は環境で変えられる" {
  stub ss 0 ""
  stub tmux 0 "agents"
  stub curl 0
  HONDEN_DASHBOARD_PORT=9911 HONDEN_DASHBOARD_HOST=0.0.0.0 run_viewer
  called_with tmux "9911"
  called_with tmux "0.0.0.0"
}

@test "窓の命は輪で回り、落ちても立ち直る形になっておる" {
  stub ss 0 ""
  stub tmux 0 "agents"
  stub curl 0
  run_viewer
  called_with tmux "while true"
  called_with tmux "dashboard --serve"
}
