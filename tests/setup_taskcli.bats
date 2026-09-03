#!/usr/bin/env bats
# task CLI の仕度（scripts/setup_task_cli.sh）。
#
# 主眼は honden の --fetch と同じ——**検めを通らぬ物は置かぬ**。
# 署名が落ちる・数が合わぬ・断られた、いずれの道でも $HOME に task が現れぬ。

load helpers

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  stub_dir
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  SERVE="$BATS_TEST_TMPDIR/serve"
  mkdir -p "$SERVE"
  # 実物と同じ形の tarball（中身は贋）を焼き、本物の sha で紙を作る
  printf '#!/bin/sh\necho task 9.9.9\n' > "$BATS_TEST_TMPDIR/task"
  chmod +x "$BATS_TEST_TMPDIR/task"
  tar -czf "$SERVE/task-9.9.9-x86_64-unknown-linux-gnu.tar.gz" -C "$BATS_TEST_TMPDIR" task
  ( cd "$SERVE" && sha256sum -- *.tar.gz > SHA256SUMS )
  printf 'にせの束' > "$SERVE/SHA256SUMS.cosign.bundle"
  export SERVE
  stub_curl_release
  stub uname 0 ""
  { echo '#!/usr/bin/env bash'
    echo 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac'
  } > "$STUB/uname"; chmod +x "$STUB/uname"
  fake_cosign v3.1.3 0
  rm -f "$STUB/sha256sum" 2>/dev/null || true   # 数の照らしは本物で
}

@test "検めが通れば ~/.local/bin/task へ置き、--version まで確かめる" {
  run bash "$ROOT/scripts/setup_task_cli.sh" --yes
  [ "$status" -eq 0 ]
  [ -x "$HOME/.local/bin/task" ]
  [[ "$output" == *"数が合うた"* ]]
  [[ "$output" == *"動く: task 9.9.9"* ]]
}

@test "**署名が落ちれば置かぬ**" {
  fake_cosign v3.1.3 1
  run bash "$ROOT/scripts/setup_task_cli.sh" --yes
  [ "$status" -ne 0 ]
  [ ! -e "$HOME/.local/bin/task" ]
  [[ "$output" == *"置いておらぬ"* ]]
}

@test "**数が合わねば置かぬ**（紙を書き換えて仕込む）" {
  sed -i '1s/^./0/; 1s/^0/1/' "$SERVE/SHA256SUMS"   # 先頭一字を確実に変える
  run bash "$ROOT/scripts/setup_task_cli.sh" --yes
  [ "$status" -ne 0 ]
  [ ! -e "$HOME/.local/bin/task" ]
}

@test "訊かれて断れば置かぬ（--yes 無し）" {
  run bash -c "echo n | bash '$ROOT/scripts/setup_task_cli.sh'"
  [ "$status" -ne 0 ]
  [ ! -e "$HOME/.local/bin/task" ]
  [[ "$output" == *"やめた"* ]]
}

@test "Linux でなければ正直に断る" {
  { echo '#!/usr/bin/env bash'; echo 'echo Darwin'; } > "$STUB/uname"; chmod +x "$STUB/uname"
  run bash "$ROOT/scripts/setup_task_cli.sh" --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"Linux 向け"* ]]
}
