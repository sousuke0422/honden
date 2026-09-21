#!/usr/bin/env bats
# addon の仕度（scripts/setup_addons.sh）。
#
# 主眼は三つ——**鍵なしで据わる**・**既に在る設定に触れぬ**・**鍵を漏らさぬ**。
# 外の口（uv・claude・serena）はすべて贋物で塞ぐ。網へは一切出ぬ。

load helpers

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  stub_dir
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  export ADDON_CLAUDE_CFG="$HOME/.claude.json"
  export ADDON_CODEX_CFG="$HOME/.codex/config.toml"
  export ADDON_CURSOR_CFG="$HOME/.cursor/mcp.json"
  # 客の名簿は正本でなく贋物から（試験が本物の正本を読んではならぬ）
  stub honden 0 $'claude\ncodex\ncursor'
  # 外の道具はみな贋物。curl も置いて、呼ばれたら記録に残す（呼ばれぬのが正）
  stub uv 0
  stub serena 0
  # 贋 claude は本物と同じく、mcp add で己の設定へ名を書き残す
  { echo '#!/usr/bin/env bash'
    echo 'printf "claude" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'if [ "${1:-}" = mcp ] && [ "${2:-}" = add ]; then echo "\"${7:-}\"" >> "$ADDON_CLAUDE_CFG"; fi'
    echo 'exit 0'
  } > "$STUB/claude"; chmod +x "$STUB/claude"
  stub curl 0
  stub uname 0 "Linux"
}

@test "据わっておらぬ時、--check は据わっておらぬと述べ、何も変えぬ" {
  run bash "$ROOT/scripts/setup_addons.sh" --check
  assert_success
  assert_output --partial "据わっておらぬ"
  assert_output --partial "何も変えぬ"
  [ ! -e "$ADDON_CODEX_CFG" ]
  [ ! -e "$ADDON_CURSOR_CFG" ]
  # 据える口は一つも呼ばれておらぬ
  ! called "uv tool install"
  ! called "serena setup"
}

@test "鍵なしで据わる——codex へは url だけが書かれ、鍵の類は一字も書かれぬ" {
  run bash "$ROOT/scripts/setup_addons.sh" --yes context7 deepwiki
  assert_success
  grep -q '^\[mcp_servers\.context7\]' "$ADDON_CODEX_CFG"
  grep -q '^\[mcp_servers\.deepwiki\]' "$ADDON_CODEX_CFG"
  ! grep -qi 'authorization\|bearer\|api.key\|http_headers' "$ADDON_CODEX_CFG"
  grep -q '"context7"' "$ADDON_CURSOR_CFG"
  called_with "claude" "mcp add -s user -t http context7"
}

@test "検めが落ちれば置かぬ——uv が落ちれば serena は繋がれず、非 0 で終わる" {
  stub uv 1
  rm "$STUB/serena"   # 本体も居らぬ状態にする（据える道を通らせる）
  run bash "$ROOT/scripts/setup_addons.sh" --yes serena
  assert_failure
  assert_output --partial "置いておらぬ"
  ! called "serena setup"
}

@test "二度走らせても壊れぬ——codex の区画は増えず、二度目はすることが無い" {
  run bash "$ROOT/scripts/setup_addons.sh" --yes context7 deepwiki
  assert_success
  before=$(cat "$ADDON_CODEX_CFG")
  run bash "$ROOT/scripts/setup_addons.sh" --yes context7 deepwiki
  assert_success
  assert_output --partial "することが無い"
  [ "$(grep -c '^\[mcp_servers\.context7\]' "$ADDON_CODEX_CFG")" -eq 1 ]
  [ "$before" = "$(cat "$ADDON_CODEX_CFG")" ]
}

@test "--yes 無しで n と答えれば、やめて何も書かぬ" {
  run bash -c "echo n | bash '$ROOT/scripts/setup_addons.sh' context7"
  assert_failure
  assert_output --partial "やめた"
  [ ! -e "$ADDON_CODEX_CFG" ]
}

@test "**鍵が出力に漏れぬ**——env にも設定にも鍵が在る状態で全ての口を叩く" {
  export CONTEXT7_API_KEY="SECRET-KEY-XYZZY"
  mkdir -p "$(dirname "$ADDON_CODEX_CFG")"
  printf '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n[mcp_servers.context7.http_headers]\nAuthorization = "Bearer SECRET-KEY-XYZZY"\n' > "$ADDON_CODEX_CFG"
  run bash "$ROOT/scripts/setup_addons.sh" --check
  assert_success
  refute_output --partial "SECRET-KEY-XYZZY"
  assert_output --partial "鍵: 在る"
  run bash "$ROOT/scripts/setup_addons.sh" --yes context7 deepwiki
  assert_success
  refute_output --partial "SECRET-KEY-XYZZY"
}

@test "**既に在る設定を壊さぬ**——鍵付きの context7 と他の server に触れぬ" {
  mkdir -p "$(dirname "$ADDON_CODEX_CFG")"
  printf '[mcp_servers.memory]\ncommand = "bun"\n\n[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n[mcp_servers.context7.http_headers]\nAuthorization = "Bearer SECRET-KEY-XYZZY"\n' > "$ADDON_CODEX_CFG"
  before_ctx7=$(sed -n '/^\[mcp_servers\.context7\]/,/^$/p' "$ADDON_CODEX_CFG")
  run bash "$ROOT/scripts/setup_addons.sh" --yes context7 deepwiki
  assert_success
  assert_output --partial "context7 / codex: 据わっておる（触れぬ）"
  # 既存の区画は一字も変わらず、鍵も他の server も残る
  [ "$before_ctx7" = "$(sed -n '/^\[mcp_servers\.context7\]/,/^$/p' "$ADDON_CODEX_CFG")" ]
  grep -q '^\[mcp_servers\.memory\]' "$ADDON_CODEX_CFG"
  grep -q 'SECRET-KEY-XYZZY' "$ADDON_CODEX_CFG"
  # 足されたのは deepwiki だけ
  grep -q '^\[mcp_servers\.deepwiki\]' "$ADDON_CODEX_CFG"
}

@test "網へ出ぬ——どの道でも curl は一度も呼ばれぬ" {
  run bash "$ROOT/scripts/setup_addons.sh" --yes
  run bash "$ROOT/scripts/setup_addons.sh" --check
  ! called "curl"
}

@test "Linux 以外は正直に断る" {
  { echo '#!/usr/bin/env bash'; echo 'echo Darwin'; } > "$STUB/uname"; chmod +x "$STUB/uname"
  run bash "$ROOT/scripts/setup_addons.sh" --check
  assert_failure
  assert_output --partial "Linux 向け"
}
