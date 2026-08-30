# bats の共通手。
#
# assert 一式は旧環境と同じ置き方で submodule に繋いだ
# （tests/test_helper/bats-{support,assert}・同じ commit に留めてある）。
# kagemusha が既に submodule ゆえ、--init の手間は元より要る。
#
#   git submodule update --init --recursive
#
# 出陣の書は tmux・ss・curl を叩く。本物を叩けば本陣を乱すし、結果が
# その時の盤面に依ってしまう——口が塞がっておるかは、何が動いておるか次第。
# ゆえに贋物を道の先頭へ置いて操る。

load test_helper/bats-support/load
load test_helper/bats-assert/load

stub_dir() {
  STUB="$BATS_TEST_TMPDIR/bin"
  CALLS="$BATS_TEST_TMPDIR/calls"
  mkdir -p "$STUB"; : > "$CALLS"
  PATH="$STUB:$PATH"; export PATH CALLS STUB
}

# stub <名> [終了コード] [吐く文字列]
stub() {
  local name="$1" code="${2:-0}" out="${3:-}"
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "%s" "'"$name"'" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    [ -n "$out" ] && printf 'cat <<%s\n%s\n%s\n' "'STUBOUT'" "$out" "STUBOUT"
    echo "exit $code"
  } > "$STUB/$name"
  chmod +x "$STUB/$name"
}

# `--` で区切る。`--noproxy` のような当てを grep が己の旗と誤読するゆえ
# （試験が即座に暴いた）。
called()      { grep -q -- "^$1" "$CALLS"; }
called_with() { grep -- "^$1" "$CALLS" | grep -qF -- "$2"; }

# tmux の贋物。副命令ごとに応え分ける。
#   stub_tmux <has-session の終了コード> <list-windows が吐く窓の名>
stub_tmux() {
  local has="$1" windows="${2:-agents}"
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "tmux" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'case "$1" in'
    echo "  has-session) exit $has ;;"
    echo "  list-windows) printf '%s\\n' '$windows' ;;"
    # 既定は「我らの陣」。@honden の印は出陣の書が見る $ROOT と揃える。
    echo "  show-options) printf '%s\\n' \"\$HONDEN_TEST_ROOT\" ;;"
    echo 'esac'
    echo 'exit 0'
  } > "$STUB/tmux"
  chmod +x "$STUB/tmux"
}

# curl の贋物。我らの印を返すか否かで「生きておる」を作る。
#   stub_curl alive | stub_curl dead | stub_curl stranger
stub_curl() {
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "curl" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    case "$1" in
      alive)    echo 'printf "HTTP/1.1 200 OK\r\nX-Honden: dashboard\r\n\r\n"; exit 0' ;;
      stranger) echo 'printf "HTTP/1.1 200 OK\r\nServer: nazo\r\n\r\n"; exit 0' ;;
      # **長い応え。** grep -q は印を見つけた瞬間に抜けるゆえ、書き手はまだ
      # 書いておる最中に SIGPIPE を食う。`… | grep -q` を使うておれば、
      # pipefail がその 141 を拾い「印は無い」と嘘をつく。
      loud)     echo 'printf "HTTP/1.1 200 OK\r\nX-Honden: dashboard\r\n"'
                echo 'for i in $(seq 1 200000); do printf "X-Filler-%s: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n" "$i"; done'
                echo 'exit 0' ;;
      *)        echo 'exit 7' ;;
    esac
  } > "$STUB/curl"
  chmod +x "$STUB/curl"
}

# 窓が**生える** tmux の贋物。
#   stub_tmux_grows <has-session の終了コード> <立てる前の窓> <立てた後の窓>
#
# 元の stub_tmux は常に同じ窓一覧を返す。それでは「立てたら見えるようになる」
# を写せず、**立てる筋そのものを試験できぬ**（我が最初の組み方がこれで、
# 「既にある」枝へ落ちておった）。new-window を受けた跡で応えを変える。
stub_tmux_grows() {
  local has="$1" before="$2" after="$3"
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "tmux" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'case "$1" in'
    echo "  has-session) exit $has ;;"
    echo '  new-window) : > "$STUB/.grown" ;;'
    echo "  list-windows) if [ -e \"\$STUB/.grown\" ]; then printf '%s\\n' '$after'; else printf '%s\\n' '$before'; fi ;;"
    echo "  show-options) printf '%s\\n' \"\$HONDEN_TEST_ROOT\" ;;"
    echo 'esac'
    echo 'exit 0'
  } > "$STUB/tmux"
  chmod +x "$STUB/tmux"
}

# 特権昇格の贋物。**渡された命をそのまま走らせる。**
#
# ただ 0 を返すだけの贋物では、`sudo apt-get install` が apt へ届かぬ——
# 「入れたはずが入っておらぬ」を作り、試験が嘘をつく（実測で一度踏んだ）。
# 本物と同じく、後ろの命へ道を譲る。
stub_sudo_exec() {
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "sudo" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'exec "$@"'
  } > "$STUB/sudo"
  chmod +x "$STUB/sudo"
}
