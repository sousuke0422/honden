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
  assert_output --partial "応えておらぬ"
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
