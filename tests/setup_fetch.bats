#!/usr/bin/env bats
# 初度の仕度のうち、**降ろす道**の試験。
#
# ここは外から来た実行可能な物を `bin/` へ置く層である。判断を一つ誤れば、
# 検めを通らぬ物が座る。出し物はまだ無いゆえ、贋の curl を立てて道を通す。
#
# 肝は**置かぬ側**である。数が違う・紙に載っておらぬ・降りてこぬ——
# どれも「一つも置かぬ」で終わらねばならぬ。半分だけ新しい `bin/` は
# どちらの版とも違う物になる。

load helpers

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  stub_dir
  # 本物の repo を汚さぬよう、書だけを写した仮の置き場で走らせる
  FAKE="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$FAKE/scripts" "$FAKE/config" "$FAKE/bin"
  cp "$ROOT/scripts/first_setup.sh" "$FAKE/scripts/"
  cp "$ROOT/config/settings.yaml.example" "$FAKE/config/"
  export HONDEN_DB="$BATS_TEST_TMPDIR/x.db"
  # 配る物の中身と、その正しい数
  SERVE="$BATS_TEST_TMPDIR/serve"
  mkdir -p "$SERVE"
  for b in honden honden-bot honden-watch honden-parse; do
    printf 'これは %s の中身' "$b" > "$SERVE/$b-linux-x64"
  done
  ( cd "$SERVE" && sha256sum -- *-linux-x64 > SHA256SUMS )
  export SERVE
  stub uname 0 ""       # 下で上書きする
  fake_uname
  stub_curl_release
  stub sha256sum 0 ""   # 下で本物へ戻す
  rm -f "$STUB/sha256sum"   # 数の照らしは**本物で**行う（贋物では意味が無い）
  stub tmux 0 "tmux 3.4"
  stub flock 0 ""
  stub git 0 ""
}

# uname の贋物。土地を linux/x86_64 に固定する。
fake_uname() {
  {
    echo '#!/usr/bin/env bash'
    echo 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac'
  } > "$STUB/uname"
  chmod +x "$STUB/uname"
}

# curl の贋物。出し物の応えと、配り物を返す。
#   stub_curl_release [札]
stub_curl_release() {
  local tag="${1:-v9.9.9}"
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "curl" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'url=""; out=""'
    echo 'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac; done'
    echo "case \"\$url\" in"
    echo "  *api.github.com*) printf '{\"tag_name\": \"$tag\"}\\n'; exit 0 ;;"
    echo '  *releases/download/*)'
    echo '     name="${url##*/}"'
    echo '     [ -f "$SERVE/$name" ] || exit 22'
    echo '     if [ -n "$out" ]; then cp "$SERVE/$name" "$out"; else cat "$SERVE/$name"; fi; exit 0 ;;'
    echo 'esac'
    echo 'exit 22'
  } > "$STUB/curl"
  chmod +x "$STUB/curl"
}

run_fetch() { run bash "$FAKE/scripts/first_setup.sh" --fetch --yes; }

@test "四本とも数が合えば置く" {
  run_fetch
  assert_output --partial "四本とも数が合うた"
  assert_output --partial "v9.9.9 を置いた"
  for b in honden honden-bot honden-watch honden-parse; do
    [ -x "$FAKE/bin/$b" ]
    run cat "$FAKE/bin/$b"
    assert_output --partial "$b の中身"
  done
}

@test "**数が違えば一つも置かぬ**" {
  # 一本だけ中身を差し替える。紙の数は元のまま
  printf 'すり替えられた中身' > "$SERVE/honden-watch-linux-x64"
  run_fetch
  assert_failure
  assert_output --partial "検めを通らなんだ"
  assert_output --partial "一つも置いておらぬ"
  # **一本も置かれておらぬこと。** 先に降ろした三本が座ってはならぬ
  for b in honden honden-bot honden-watch honden-parse; do
    [ ! -e "$FAKE/bin/$b" ]
  done
}

@test "紙に載っておらぬ物は通さぬ（載せ忘れを無検査にせぬ）" {
  ( cd "$SERVE" && grep -v 'honden-parse' SHA256SUMS > t && mv t SHA256SUMS )
  run_fetch
  assert_failure
  assert_output --partial "検めを通らなんだ"
  [ ! -e "$FAKE/bin/honden" ]
}

@test "紙が空なら通さぬ（照らす物が無いのを合格にせぬ）" {
  : > "$SERVE/SHA256SUMS"
  run_fetch
  assert_failure
  [ ! -e "$FAKE/bin/honden" ]
}

@test "一本でも降りてこねば止まる" {
  rm "$SERVE/honden-bot-linux-x64"
  run_fetch
  assert_failure
  assert_output --partial "降ろせなんだ"
  [ ! -e "$FAKE/bin/honden" ]
}

@test "出し物が無ければ、建てよと言う（黙って古い物を置かぬ）" {
  stub curl 22 ""
  run_fetch
  assert_failure
  assert_output --partial "出し物が見当たらぬ"
}

@test "配っておらぬ土地では降ろさぬ" {
  {
    echo '#!/usr/bin/env bash'
    echo 'case "$1" in -s) echo Linux ;; -m) echo riscv64 ;; esac'
  } > "$STUB/uname"
  chmod +x "$STUB/uname"
  run_fetch
  assert_failure
  assert_output --partial "配っておらぬ"
}

@test "取りに行く先は repo の下だけ" {
  run_fetch
  run bash -c "grep '^curl' '$CALLS' | grep -v 'github.com/sousuke0422/honden\|api.github.com/repos/sousuke0422/honden' | grep -c http || true"
  assert_output "0"
}

@test "設定が無ければ雛形から作り、あるものは触らぬ" {
  run_fetch
  [ -f "$FAKE/config/settings.yaml" ]
  echo "# 手で直した" >> "$FAKE/config/settings.yaml"
  run bash "$FAKE/scripts/first_setup.sh" --fetch --yes
  run cat "$FAKE/config/settings.yaml"
  assert_output --partial "手で直した"
}
