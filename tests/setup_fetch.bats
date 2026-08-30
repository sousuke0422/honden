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
  fake_cosign v3.1.3 0          # 既定は「v3 で、署名は我らの物」
  # **本物の導入を走らせぬ。** 試験は --yes で走るゆえ、塞がねば
  # `sudo apt-get install` が実際に動く。贋物を道の先頭に置いて止める。
  stub sudo 1 ""
  stub apt-get 1 ""
  stub brew 1 ""
  stub dnf 1 ""
  # 束も配る（署名の検めが降ろしに行く）
  printf 'にせの束' > "$SERVE/SHA256SUMS.cosign.bundle"
}

# cosign の贋物。版と、検めの通り不通りを操る。
#   fake_cosign <名乗る版> <verify-blob の終了コード>
fake_cosign() {
  local ver="$1" rc="${2:-0}"
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "cosign" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'case "$1" in'
    echo "  version) printf '{\"gitVersion\":\"$ver\"}\\n'; exit 0 ;;"
    echo "  verify-blob) exit $rc ;;"
    echo 'esac'
    echo 'exit 0'
  } > "$STUB/cosign"
  chmod +x "$STUB/cosign"
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

# ── 署名 ────────────────────────────────────────────────────────────

@test "署名が通れば、そう言うて置く" {
  run_fetch
  assert_output --partial "署名は我らの物である"
  [ -x "$FAKE/bin/honden" ]
}

@test "**縛りを渡しておるか**（身元と発行者の両方）" {
  run_fetch
  run bash -c "grep '^cosign' '$CALLS'"
  assert_output --partial "verify-blob"
  assert_output --partial "--certificate-identity-regexp"
  assert_output --partial "workflows/release\\.yml@refs/tags/"
  assert_output --partial "--certificate-oidc-issuer"
  assert_output --partial "token.actions.githubusercontent.com"
}

@test "**署名が通らねば一つも置かぬ**" {
  fake_cosign v3.1.3 1
  run_fetch
  assert_failure
  assert_output --partial "署名が我らの物と認められなんだ"
  for b in honden honden-bot honden-watch honden-parse; do
    [ ! -e "$FAKE/bin/$b" ]
  done
}

@test "cosign が無ければ、まず入れてよいか訊く" {
  # 贋の apt が「入った」ことにする
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "apt-get" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'exit 0'
  } > "$STUB/apt-get"
  chmod +x "$STUB/apt-get"
  stub sudo 0 ""
  run_fetch     # 本物の cosign が道に在るので「入った」ことになる
  assert_success
  assert_output --partial "署名は我らの物である"
}

@test "cosign が無く、入れられもせねば断る（「あれば検める」にせぬ）" {
  # 手元に本物の cosign が在ることがある。**消すのではなく、指す先を変える**
  HONDEN_COSIGN=/nonexistent/cosign run_fetch
  assert_failure
  assert_output --partial "検められぬ物は置かぬ"
  assert_output --partial "insecure-skip-signature"
  [ ! -e "$FAKE/bin/honden" ]
}

@test "**建てる道は、飛ばす旗より先に来る**（急ぐ者を危うい道へ導かぬ）" {
  HONDEN_COSIGN=/nonexistent/cosign run_fetch
  assert_failure
  printf '%s\n' "$output" > "$BATS_TEST_TMPDIR/out.txt"
  a=$(grep -n -- '--build' "$BATS_TEST_TMPDIR/out.txt" | head -1 | cut -d: -f1)
  b=$(grep -n -- 'insecure-skip-signature' "$BATS_TEST_TMPDIR/out.txt" | head -1 | cut -d: -f1)
  [ -n "$a" ]
  [ -n "$b" ]
  [ "$a" -lt "$b" ]
}

@test "**cosign は brew を先に試す**（土地の archive は古いことがある）" {
  # 両方あるとき、どちらへ行くか。cosign は上流に近いほうを採る
  stub apt-get 0 ""
  stub brew 0 ""
  stub sudo 0 ""
  HONDEN_COSIGN=/nonexistent/cosign run_fetch || true
  # 先に呼ばれたほうが上に来る
  run bash -c "grep -n -e '^brew' -e '^apt-get' '$CALLS' | head -1"
  assert_output --partial "brew"
}

@test "土台の道具は土地の手を先に試す（brew に寄せぬ）" {
  # 土台の道具は本物が在るゆえ、その枝は踏めぬ。**順そのものを問う。**
  # brew は /home/linuxbrew に入り土地の物を覆い隠すゆえ、tmux や git まで
  # 寄せるのは筋が違う——cosign だけが例外である。
  run bash "$FAKE/scripts/first_setup.sh" --pkg-order
  assert_success
  assert_line --index 0 --partial "既定:   apt brew dnf"
  assert_line --index 1 --partial "cosign: brew apt dnf"
}

@test "**v2 の cosign では断る**（素の apt が配るのはこちらのことがある）" {
  fake_cosign v2.6.2 0
  run_fetch
  assert_failure
  assert_output --partial "cosign が古い"
  assert_output --partial "2.6.2"
  [ ! -e "$FAKE/bin/honden" ]
}

@test "**版が読めぬ時も断る**（読めぬ物を新しいと見なさぬ）" {
  fake_cosign "こわれた" 0
  run_fetch
  assert_failure
  assert_output --partial "版が読めぬ"
  [ ! -e "$FAKE/bin/honden" ]
}

@test "束が降りてこねば止まる（無い署名を通さぬ）" {
  rm "$SERVE/SHA256SUMS.cosign.bundle"
  run_fetch
  assert_failure
  assert_output --partial "署名の束を降ろせなんだ"
  [ ! -e "$FAKE/bin/honden" ]
}

@test "旗を明示すれば飛ばすが、必ず警める" {
  export HONDEN_COSIGN=/nonexistent/cosign
  run bash "$FAKE/scripts/first_setup.sh" --fetch --yes --insecure-skip-signature
  assert_output --partial "署名を検めずに降ろす"
  assert_output --partial "**署名は検めておらぬ**"
  [ -x "$FAKE/bin/honden" ]
}

@test "旗を飛ばしても、数の検めは残る（守りを二つとも外さぬ）" {
  export HONDEN_COSIGN=/nonexistent/cosign
  printf 'すり替えられた中身' > "$SERVE/honden-watch-linux-x64"
  run bash "$FAKE/scripts/first_setup.sh" --fetch --yes --insecure-skip-signature
  assert_failure
  assert_output --partial "検めを通らなんだ"
  [ ! -e "$FAKE/bin/honden" ]
}
