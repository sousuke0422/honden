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
  # 贋 codex は本物と同じく TOML を正しく解いて答える（引用符つきの区画も見える）。
  # add は ADDON_CODEX_CFG へ書く——本物が己の config へ書くのと同じ流れ
  { echo '#!/usr/bin/env bash'
    echo 'printf "codex" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'if [ "${1:-}" = mcp ] && [ "${2:-}" = get ]; then'
    echo '  python3 - "$ADDON_CODEX_CFG" "${3:-}" <<PY'
    echo 'import sys, tomllib, os'
    echo 'p, name = sys.argv[1], sys.argv[2]'
    echo 'if not os.path.exists(p): sys.exit(1)'
    echo 'try: cfg = tomllib.load(open(p, "rb"))'
    echo 'except Exception: sys.exit(1)'
    echo 'sys.exit(0 if name in (cfg.get("mcp_servers") or {}) else 1)'
    echo 'PY'
    echo '  exit $?'
    echo 'elif [ "${1:-}" = mcp ] && [ "${2:-}" = add ]; then'
    echo '  mkdir -p "$(dirname "$ADDON_CODEX_CFG")"'
    echo '  printf "\n[mcp_servers.%s]\nurl = \"%s\"\n" "${3:-}" "${5:-}" >> "$ADDON_CODEX_CFG"'
    echo 'fi'
    echo 'exit 0'
  } > "$STUB/codex"; chmod +x "$STUB/codex"
  # 贋 claude は本物と同じく、mcp add で己の設定（正しい JSON の user scope）へ
  # 名を書き残す。判じが JSON を読む以上、字面の追記では検められぬ
  { echo '#!/usr/bin/env bash'
    echo 'printf "claude" >> "$CALLS"; for a in "$@"; do printf " %s" "$a" >> "$CALLS"; done; printf "\n" >> "$CALLS"'
    echo 'if [ "${1:-}" = mcp ] && [ "${2:-}" = add ]; then'
    echo '  python3 - "$ADDON_CLAUDE_CFG" "${7:-}" "${8:-}" <<PY'
    echo 'import json, os, sys'
    echo 'path, name, url = sys.argv[1], sys.argv[2], sys.argv[3]'
    echo 'cfg = json.load(open(path)) if os.path.exists(path) else {}'
    echo 'cfg.setdefault("mcpServers", {})[name] = {"type": "http", "url": url}'
    echo 'json.dump(cfg, open(path, "w"))'
    echo 'PY'
    echo 'fi'
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

@test "**他の案件の段にだけ在る名は「据わっておらぬ」**——user scope だけを見る" {
  # 頂の mcpServers には context7 だけ。deepwiki は案件の段にしか居らぬ
  printf '{"mcpServers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp"}},"projects":{"/w/task":{"mcpServers":{"deepwiki":{"type":"http","url":"https://mcp.deepwiki.com/mcp"}}}}}' > "$ADDON_CLAUDE_CFG"
  run bash "$ROOT/scripts/setup_addons.sh" --check deepwiki
  assert_success
  assert_output --partial "deepwiki / claude: 据わっておらぬ"
  # 据えでは飛ばさず claude へ繋ぎに行く
  run bash "$ROOT/scripts/setup_addons.sh" --yes deepwiki
  assert_success
  assert_output --partial "deepwiki / claude: 繋いだ"
  called_with "claude" "mcp add -s user -t http deepwiki"
  # 陰性対照: user scope に真に在る context7 は触らず、二重に据えに行かぬ
  run bash "$ROOT/scripts/setup_addons.sh" --yes context7
  assert_success
  assert_output --partial "context7 / claude: 据わっておる（触れぬ）"
  ! called_with "claude" "mcp add -s user -t http context7"
}

@test "**引用符つきの区画を見逃さぬ**——codex は CLI に問う" {
  mkdir -p "$(dirname "$ADDON_CODEX_CFG")"
  printf '[mcp_servers."context7"]\nurl = "https://mcp.context7.com/mcp"\n' > "$ADDON_CODEX_CFG"
  before=$(cat "$ADDON_CODEX_CFG")
  run bash "$ROOT/scripts/setup_addons.sh" --yes context7
  assert_success
  assert_output --partial "context7 / codex: 据わっておる（触れぬ）"
  [ "$before" = "$(cat "$ADDON_CODEX_CFG")" ]  # 二重に書いておらぬ
  python3 -c "import tomllib,sys; tomllib.load(open(sys.argv[1],'rb'))" "$ADDON_CODEX_CFG"  # TOML は読めるまま
}

@test "codex CLI が無ければ手で config を書かず「据えられなんだ」と報じる" {
  export ADDON_CODEX_BIN=codex-not-here
  run bash "$ROOT/scripts/setup_addons.sh" --yes deepwiki
  assert_failure
  assert_output --partial "codex CLI が無い。据えられなんだ"
  [ ! -e "$ADDON_CODEX_CFG" ]  # 手書きしておらぬ
}

@test "serena は --no-python-downloads つきで据え、python が無ければ案内して止まる" {
  rm "$STUB/serena"
  run bash "$ROOT/scripts/setup_addons.sh" --yes serena
  called_with "uv" "tool install --no-python-downloads -p 3.13 serena-agent"
  # python 3.13 が無い形（uv が落ちる）
  stub uv 1
  run bash "$ROOT/scripts/setup_addons.sh" --yes serena
  assert_failure
  assert_output --partial "python 3.13 が無いなら先に据えられよ"
}

@test "**書けぬ先でも人の cursor 設定はそのまま**——仮の file だけで倒れる" {
  mkdir -p "$(dirname "$ADDON_CURSOR_CFG")"
  printf '{"mcpServers":{"mine":{"url":"https://example.invalid"}}}' > "$ADDON_CURSOR_CFG"
  before=$(cat "$ADDON_CURSOR_CFG")
  chmod 555 "$(dirname "$ADDON_CURSOR_CFG")"
  run bash "$ROOT/scripts/setup_addons.sh" --yes deepwiki
  chmod 755 "$(dirname "$ADDON_CURSOR_CFG")"
  assert_failure
  assert_output --partial "deepwiki / cursor: 繋げなんだ"
  [ "$before" = "$(cat "$ADDON_CURSOR_CFG")" ]  # 原形のまま
  # 仮の file の残骸も無い
  [ -z "$(ls "$(dirname "$ADDON_CURSOR_CFG")" | grep '^\.mcp\.json\.' || true)" ]
}

@test "Linux 以外は正直に断る" {
  { echo '#!/usr/bin/env bash'; echo 'echo Darwin'; } > "$STUB/uname"; chmod +x "$STUB/uname"
  run bash "$ROOT/scripts/setup_addons.sh" --check
  assert_failure
  assert_output --partial "Linux 向け"
}
