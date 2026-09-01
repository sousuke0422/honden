#!/usr/bin/env bats
# 戦況の窓（shutsujin_departure.sh viewer）の試験。
#
# tmux・ss・curl を贋物に差し替え、**根の入口から**叩く。関数を直に呼ぶより、
# 実際に使われる道を通した方が入口の綻びまで拾える。
#
# 肝は**見分け**である。「口が塞がっておる」も「viewer という窓がある」も
# 我らの窓が生きておる証にはならぬ——8787 に他人の中継が座っておった一件が
# それを教えた。生死は我らが返す印（X-Honden）でのみ判ずる。

load helpers

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  stub_dir
  export HONDEN_VIEWER_SETTLE=0
  export HONDEN_TEST_ROOT="$ROOT"   # 贋 tmux が返す @honden の印
  stub ss 0 ""            # 既定は「口は空いておる」
  stub_curl dead          # 既定は「我らは応えておらぬ」
  stub_tmux 0 agents      # 既定は「陣はある・viewer 窓は無い」
}

run_viewer() { run bash "$ROOT/shutsujin_departure.sh" viewer; }

@test "陣が立っておらねば、先に出陣せよと言う（tmux の生の悲鳴を出さぬ）" {
  stub_tmux 1
  run_viewer
  assert_success
  assert_output --partial "立っておらぬ"
  refute_output --partial "new-window"
}

@test "贋の curl が、我らの印を返す（**計器そのものの検め**）" {
  # 手元では通り、CI では落ちた（v0.1.0-rc.1・47 と 50 のみ）。二つの落ちは
  # 互いに矛盾しており、贋物そのものを疑う要が出た。
  #
  # **計器が生きておるかを、計器で測る。** ここが落ちれば贋物の作りが悪く、
  # ここが通って窓の検めが落ちるなら、悪いのは書のほうである。
  stub_curl alive
  run bash -c "command -v curl"
  assert_output --partial "$STUB/curl"
  run bash -c "curl -sf --noproxy '*' -m 2 -o /dev/null -D - 'http://127.0.0.1:8788/api/version' 2>/dev/null"
  assert_success
  assert_output --partial "X-Honden"
  run bash -c "curl -sf --noproxy '*' -m 2 -o /dev/null -D - 'http://127.0.0.1:8788/api/version' 2>/dev/null | grep -qi '^x-honden:'"
  assert_success
}

@test "**応えが長うても、印を見つければ生きておると判ずる**（pipefail × SIGPIPE）" {
  # 気まぐれの正体はこれであった。`curl | grep -q` は、grep が先に抜けた時
  # 書き手へ SIGPIPE を送り、pipefail がその 141 を拾う——**印が合うておるのに
  # 「死んでおる」と答える**。出るか出ぬかは走りの速さ次第ゆえ、CI でだけ、
  # しかも形を変えて現れた（v0.1.0-rc.1 の門で二度）。
  #
  # 長い応えを返させれば SIGPIPE は必ず起きる。気まぐれを**確かな試験**に変える。
  stub_curl loud
  run_viewer
  assert_success
  assert_output --partial "既に応えておる"
}

@test "我らが既に応えておれば、それでよい" {
  stub_curl alive
  run_viewer
  assert_success
  assert_output --partial "既に応えておる"
  run bash -c "grep -c 'new-window' '$CALLS' || true"
  assert_output "0"
}

@test "口は塞がっておるが我らでないなら、よその者と言う（別の口を促す）" {
  stub ss 0 "LISTEN 0 512 127.0.0.1:8788 0.0.0.0:*"
  stub_curl stranger      # 応えるが印が無い
  run_viewer
  assert_output --partial "よその者が座っておる"
  assert_output --partial "HONDEN_DASHBOARD_PORT"
  run bash -c "grep -c 'new-window' '$CALLS' || true"
  assert_output "0"
}

@test "窓はあるのに応えぬなら、中を見よと言う（立て直しを重ねぬ）" {
  stub_tmux 0 viewer
  run_viewer
  assert_output --partial "viewer 窓はあるが"
  assert_output --partial "では応えぬ"
  run bash -c "grep -c 'new-window' '$CALLS' || true"
  assert_output "0"
}

@test "空いておれば窓を立て、印で生死を確かめる" {
  # 立てる前は死んでおり、立てた後は生きておる——という順を贋物で作る。
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "curl" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'n=$(grep -c "^curl" "$CALLS")'
    echo 'if [ "$n" -ge 2 ]; then printf "HTTP/1.1 200 OK\r\nX-Honden: dashboard\r\n\r\n"; exit 0; fi'
    echo 'exit 7'
  } > "$STUB/curl"
  chmod +x "$STUB/curl"
  run_viewer
  assert_success
  called_with tmux "new-window"
  called_with tmux "viewer"
  assert_output --partial "窓を開いた"
}

@test "立てても応えねば、そう言う（黙って成功と言わぬ）" {
  run_viewer
  assert_output --partial "応えぬ"
  refute_output --partial "窓を開いた"
}

@test "口の見分けは厳密（18788 を 8788 と取り違えぬ）" {
  stub ss 0 "LISTEN 0 512 127.0.0.1:18788 0.0.0.0:*"
  run_viewer
  refute_output --partial "よその者"
  called_with tmux "new-window"
}

@test "口と繋ぎ先は環境で変えられる" {
  HONDEN_DASHBOARD_PORT=9911 HONDEN_DASHBOARD_HOST=0.0.0.0 run_viewer
  called_with tmux "9911"
  called_with tmux "0.0.0.0"
}

@test "輪は五度で諦める（直らぬ失敗を永遠に刷り続けぬ）" {
  run_viewer
  called_with tmux "n -lt 5"
  called_with tmux "諦めた"
}

@test "生死の問いは中継を迂回する（http_proxy に攫われぬ）" {
  run_viewer
  called_with curl "--noproxy"
}

@test "よその陣へは窓を接がぬ（印が無ければ断る）" {
  # has-session は通るが、show-options が印を返さぬ＝よその陣。
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "tmux" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'case "$1" in'
    echo '  has-session) exit 0 ;;'
    echo '  list-sessions) printf "honden-agents\t\n" ;;'      # 印が無い
    echo '  list-windows) printf "agents\n" ;;'
    echo 'esac'
    echo 'exit 0'
  } > "$STUB/tmux"
  chmod +x "$STUB/tmux"
  run_viewer
  assert_output --partial "我らの陣ではない"
  run bash -c "grep -c 'new-window' '$CALLS' || true"
  assert_output "0"
}

@test "止めの合図と、五度倒れたのを言い分ける" {
  run_viewer
  called_with tmux "止めよとの合図"
  called_with tmux "五度倒れた"
}

@test "道に単引用符があっても命が壊れぬ（%q で包む）" {
  # 単引用符で括ると、道に ' があった時に破れる（Issue #8）。
  run bash -c "grep -q \"qhonden=\\\$(printf '%q'\" '$ROOT/scripts/shutsujin.sh' && echo ok"
  assert_output "ok"
  # 生の単引用符括りが残っておらぬこと
  run bash -c "grep -c \"HONDEN_DB='\\\$DB' '\\\$ROOT/bin/honden' dashboard\" '$ROOT/scripts/shutsujin.sh' || true"
  assert_output "0"
}

@test "外へ開いた時の断りは、出陣を打った者の目の前に出る" {
  stub_curl alive
  HONDEN_DASHBOARD_HOST=0.0.0.0 run_viewer
  # 窓の中でなく、ここに出ねば誰も読まぬ
  assert_output --partial "外へ開いておる"
}

@test "己の内なら断りを出さぬ（常道を騒がせぬ）" {
  stub_curl alive
  run_viewer
  refute_output --partial "外へ開いておる"
}

@test "下見は一度きりで判ぜぬ（冷えた土地で偽の応えぬを出さぬ）" {
  run bash -c "grep -q 'for i in 1 2 3 4 5; do' '$ROOT/scripts/shutsujin.sh' && echo ok"
  assert_output "ok"
}

@test "中の書は己で構えを取る（exec bash は SHELLOPTS を渡さぬ）" {
  run bash -c "grep -q '^set -uo pipefail' '$ROOT/scripts/shutsujin.sh' && echo ok"
  assert_output "ok"
}
