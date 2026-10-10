#!/usr/bin/env bats
# 立て直し（scripts/switch_cli.sh）の試験。足軽ごとの env が、立て直しの命に載ること。
#
# tmux も honden も贋物で足りる。本物の pane・正本・settings.yaml には触れぬ。

load helpers

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  stub_dir
  stub sleep 0
  export HONDEN_DB="$BATS_TEST_TMPDIR/h.db"
  export HONDEN_SETTINGS="$BATS_TEST_TMPDIR/settings.yaml"
  : > "$HONDEN_SETTINGS"
  FAKE="$BATS_TEST_TMPDIR/root"
  mkdir -p "$FAKE/bin" "$FAKE/scripts"
  cp "$ROOT/scripts/switch_cli.sh" "$FAKE/scripts/"
  # tmux の贋物: 名乗りで pane を返し、CLI を答え、抜けた後は shell の印（$）を見せる
  cat > "$STUB/tmux" <<'EOF'
#!/usr/bin/env bash
printf "tmux" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"
case "$1" in
  list-panes) printf '%%5 ashigaru1\n' ;;
  show-options) printf 'codex\n' ;;
  capture-pane) printf 'user@host:~$ \n' ;;
esac
exit 0
EOF
  chmod +x "$STUB/tmux"
}

# 贋の honden。ashigaru1 の env に、空白と $ を含む値を単引用で包んで返す。
# $1 の case 行が先に当たる（env の誤りを差し込む口）。
fake_honden() {
  {
    cat <<'EOF'
#!/usr/bin/env bash
printf "honden" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"
case "$1 $2" in
EOF
    printf '%s\n' "${1:-}"
    cat <<'EOF'
  "config get") case "$3" in *.model) printf 'gpt-x\n' ;; *) printf 'codex\n' ;; esac ;;
  "config env") [ "$3" = ashigaru1 ] && printf '%s\n' "CODEX_HOME='/tmp/a b\$c'" ;;
esac
exit 0
EOF
  } > "$FAKE/bin/honden"
  chmod +x "$FAKE/bin/honden"
}

@test "**足軽ごとの env が、立て直しの命の頭に載る**（--dry-run の打つ命）" {
  fake_honden
  run bash "$FAKE/scripts/switch_cli.sh" ashigaru1 --dry-run
  [ "$status" -eq 0 ]
  assert_output --partial "打つ命: CODEX_HOME='/tmp/a b\$c' codex --model gpt-x --search"
}

@test "**立て直しで実際に打つ命にも env が載る**（空白と \$ を含む値も崩れぬ）" {
  fake_honden
  run bash "$FAKE/scripts/switch_cli.sh" ashigaru1
  [ "$status" -eq 0 ]
  called_with tmux "%5 CODEX_HOME='/tmp/a b\$c' codex --model gpt-x --search"
}

@test "**env の名が外れておれば、抜けさせる前に止まる**（何も替えぬ）" {
  fake_honden '  "config env") echo "cli.agents.ashigaru1.env の名 OPENAI_API_KEY は許しておらぬ" >&2; exit 2 ;;'
  run bash "$FAKE/scripts/switch_cli.sh" ashigaru1
  [ "$status" -ne 0 ]
  assert_output --partial "env の欄が誤っておる"
  # 抜けさせる鍵（/exit 等）も、起こす命も打っておらぬ
  run bash -c "grep -c 'send-keys' '$CALLS' || true"
  assert_output "0"
}

@test "陽性対照: env の無い足軽は、今どおり前置き無しで起こす" {
  fake_honden '  "config env") ;;'
  run bash "$FAKE/scripts/switch_cli.sh" ashigaru1 --dry-run
  [ "$status" -eq 0 ]
  assert_output --partial "打つ命: codex --model gpt-x --search"
}
