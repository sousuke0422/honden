#!/usr/bin/env bats
# 出陣そのもの（shutsujin_departure.sh up）の試験。
#
# 主眼は一つ——**既に立っておる陣へ命を打ち込まぬこと**。
# 二度打った時に働いておる者の入力欄へ CLI の起動命が流れ込む罠があった
# （敵対レビュー critical・2026-08-29）。ここに釘を打つ。

load helpers

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  stub_dir
  export HONDEN_VIEWER_SETTLE=0
  # 正本も binary も贋物で足りる。ここで見たいのは差配の筋だけ。
  export HONDEN_DB="$BATS_TEST_TMPDIR/h.db"
  export HONDEN_SETTINGS="$BATS_TEST_TMPDIR/settings.yaml"
  : > "$HONDEN_SETTINGS"
  stub ss 0 ""
  stub curl 0
  stub sleep 0
  # honden は名簿と設定を答える。中身は最小で足りる。
  cat > "$STUB/honden" <<'EOF'
#!/usr/bin/env bash
printf 'honden'; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'
EOF
  mv "$STUB/honden" "$STUB/honden.real"
  {
    echo '#!/usr/bin/env bash'
    echo 'printf "honden" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'case "$1 $2" in'
    echo '  "roster ") printf "shogun\nkaro\nashigaru1\ngunshi\n" ;;'
    echo '  "config get") printf "claude\n" ;;'
    echo 'esac'
    echo 'exit 0'
  } > "$STUB/honden"
  chmod +x "$STUB/honden"
  # 出陣は $ROOT/bin/honden を直に叩く所もあるゆえ、そちらも贋物に向ける。
  export PATH
}

# 出陣は bin/honden の新しさを検める。贋物の作業場を仕立てて逃れる。
fake_root() {
  FAKE="$BATS_TEST_TMPDIR/root"
  mkdir -p "$FAKE/bin" "$FAKE/src" "$FAKE/core/watch/src" "$FAKE/scripts"
  cp "$ROOT/scripts/shutsujin.sh" "$FAKE/scripts/"
  cp "$ROOT/shutsujin_departure.sh" "$FAKE/"
  cp "$STUB/honden" "$FAKE/bin/honden"
  cp "$STUB/honden" "$FAKE/bin/honden-watch"
  # 構文の解き手も要る（出陣が新しさを検める）。
  mkdir -p "$FAKE/core/guard/src"
  cp "$STUB/honden" "$FAKE/bin/honden-parse"
  chmod +x "$FAKE/bin/honden" "$FAKE/bin/honden-watch" "$FAKE/bin/honden-parse"
}

run_up() { run bash "$FAKE/shutsujin_departure.sh" up; }

@test "陣が無ければ立てて召喚する" {
  fake_root
  stub tmux 1 ""            # has-session が「無い」と答える
  run_up
  called_with tmux "new-session"
  called_with tmux "send-keys"
}

@test "陣が既にあれば召喚せぬ（働いておる者の手を止めぬ）" {
  fake_root
  stub tmux 0 ""            # has-session が「ある」と答える
  run_up
  assert_output --partial "召喚は行わぬ"
  # **これが本丸。** 既存の pane へ命を打ち込んではならぬ。
  refute_line --partial "send-keys"
  run bash -c "grep -c '^tmux send-keys' '$CALLS' || true"
  assert_output "0"
}
