#!/usr/bin/env bash
# 外の道具（addon）を一つの口から据える。第一弾は Serena と context7 / deepwiki。
#
# これはアドオンの仕度である——**入れずとも honden は立つ**。走らせた者と
# 走らせぬ者で honden の振る舞いは変わらぬ。
#
#   bash scripts/setup_addons.sh --check          # 何が据わっておるかを述べる（何も変えぬ）
#   bash scripts/setup_addons.sh                  # 訊いてから全部を据える
#   bash scripts/setup_addons.sh --yes            # 訊かぬ
#   bash scripts/setup_addons.sh serena           # 選んで据える（serena / context7 / deepwiki）
#   bash scripts/setup_addons.sh --uninstall serena  # serena を外す
#
# 作法は setup_task_cli.sh / setup_skills.sh に揃える:
#   訊いてから変える（--yes で黙る）・検めを通らぬ物は置かぬ・断りは正直に。
#
# 鍵の扱い:
#   **既定は鍵なし**である。context7 は鍵なしでも据わり、動く（上流の README は
#   「鍵は rate limit を上げる推奨」と述べる。必須とは述べぬ）。deepwiki は
#   そもそも鍵を持たぬ（free / no-authentication・上流の書）。この script は
#   鍵を**書き込まぬし読み上げぬ**——在るか無いかだけを述べる。鍵を持つ者は
#   各人の設定（~/.codex/config.toml の http_headers 等）へ自分で足す。
#   repo の下へ鍵が落ちる道は無い（この script はカレントや repo 内に書かぬ）。
#
# 既に在る設定には触れぬ:
#   設定に同じ名（mcp_servers.context7 等）が既に居れば、その区画は読みも
#   書きもせず「据わっておる」と述べるだけである。鍵付きで繋いでおる者の
#   設定を、仕度が黙って書き換えてはならぬ（setup_skills.sh と同じ倒し方）。
set -uo pipefail

CLAUDE_CFG="${ADDON_CLAUDE_CFG:-$HOME/.claude.json}"
CODEX_CFG="${ADDON_CODEX_CFG:-$HOME/.codex/config.toml}"
CURSOR_CFG="${ADDON_CURSOR_CFG:-$HOME/.cursor/mcp.json}"
# 試験が「codex CLI が無い」形を作れるよう、呼び名だけ差し替えられるようにする
CODEX_BIN="${ADDON_CODEX_BIN:-codex}"
HONDEN_BIN="${ADDON_HONDEN_BIN:-honden}"
CTX7_URL="https://mcp.context7.com/mcp"
DEEPWIKI_URL="https://mcp.deepwiki.com/mcp"

c()   { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info(){ echo "  $(c '0;36' '│') $*"; }
ok()  { echo "  $(c '1;32' '✓') $*"; }
warn(){ echo "  $(c '1;33' '▲') $*"; }
die() { echo "  $(c '1;31' '✗') $*" >&2; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }

YES=0; CHECK=0; UNINSTALL=0; PICK=()
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --check) CHECK=1 ;;
    --uninstall) UNINSTALL=1 ;;
    serena|context7|deepwiki) PICK+=("$a") ;;
    *) die "知らぬ旗: $a（--check / --yes / --uninstall / serena / context7 / deepwiki）" ;;
  esac
done
[ ${#PICK[@]} -eq 0 ] && PICK=(serena context7 deepwiki)

[ "$(uname -s)" = Linux ] || die "この仕度は Linux 向けである（$(uname -s)）。他の土地は上流の手引きで手で"

# ── 客（CLI）は正本から引く ──
#
# 三つへ倒すのは honden 自体が居らぬ時だけ。honden が在るなら roster の
# 結果をそのまま正とし、対応する客（claude / codex / cursor）が零件なら
# 何も変えずに終う——在りもせぬ客の設定へ手を出さぬ。
if have "$HONDEN_BIN"; then
  # 引く段と選ぶ段を分ける。引けなんだ（非 0）は「無い」ではない——
  # 正本の悲鳴を見せて止まる。零件は引けた上での事実ゆえ、静かに終う。
  ROSTER_ERR=$(mktemp)
  if ! ROSTER_OUT=$("$HONDEN_BIN" roster 2>"$ROSTER_ERR"); then
    msg=$(head -c 500 "$ROSTER_ERR"); rm -f "$ROSTER_ERR"
    die "正本を読めなんだ（$HONDEN_BIN roster が非 0 で落ちた）。何も変えておらぬ。
      正本の言い分: ${msg:-（何も言わなんだ）}"
  fi
  rm -f "$ROSTER_ERR"
  CLIENTS=$(printf '%s\n' "$ROSTER_OUT" | grep -oE '\b(claude|codex|cursor)\b' | sort -u)
  if [ -z "$CLIENTS" ]; then
    info "roster に対応する客（claude / codex / cursor）が居らぬ。何も変えず終う"
    exit 0
  fi
else
  CLIENTS=$'claude\ncodex\ncursor'
fi

# ── 在るか無いかを見る（読み専用） ──
#
# claude の設定は user scope（頂の .mcpServers）の他に、案件ごとの段
# （projects.*.mcpServers）を抱える。字面の grep では他の案件の段にだけ
# 在る名まで「据わっておる」と誤読し、据えるべき物を飛ばす。JSON として
# user scope だけを見る（python3 は cursor_add が既に前提としておる——
# 新たな頼りは増えぬ）。読んだ中身は真偽にしか使わず、画面へは出さぬ。
json_has_server() { # <設定の道> <名> — 頂の mcpServers に鍵として在るか
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1]) as f: cfg = json.load(f)
except Exception:
    sys.exit(1)
sys.exit(0 if sys.argv[2] in (cfg.get('mcpServers') or {}) else 1)
PY
}
in_claude(){ [ -f "$CLAUDE_CFG" ] && json_has_server "$CLAUDE_CFG" "$1"; }
# codex は CLI に問う。toml の字面読みは引用符つきの区画
# （[mcp_servers."名"]）を見逃す。CLI が無ければ「判じられぬ」（偽を返す）
# ——据えの側は have codex を先に見て「据えられなんだ」と報じる。
in_codex(){ have "$CODEX_BIN" && "$CODEX_BIN" mcp get "$1" >/dev/null 2>&1; }
# cursor の mcp.json は claude と同じ形の平ら一枚。同じ手で見る。
in_cursor(){ [ -f "$CURSOR_CFG" ] && json_has_server "$CURSOR_CFG" "$1"; }
codex_key(){ [ -f "$CODEX_CFG" ] && grep -q "^\[mcp_servers\.$1\.http_headers\]" "$CODEX_CFG"; }

state_line() { # <tool> <client> → 一行
  local t="$1" cl="$2" s=""
  case "$cl" in
    claude) in_claude "$t" && s="据わっておる" || s="据わっておらぬ" ;;
    codex)  if ! have "$CODEX_BIN"; then s="判じられぬ（codex CLI が無い）"
            else in_codex "$t" && s="据わっておる" || s="据わっておらぬ"; fi
            [ "$t" = context7 ] && codex_key "$t" && s="$s（鍵: 在る）" ;;
    cursor) in_cursor "$t" && s="据わっておる" || s="据わっておらぬ" ;;
  esac
  echo "    $t / $cl: $s"
}

do_check() {
  info "据わり具合（何も変えぬ）:"
  if have serena; then ok "serena の本体: 在る（$(command -v serena)）"; else info "serena の本体: 無い"; fi
  have uv || info "uv: 無い（serena を据えるには要る）"
  for t in "${PICK[@]}"; do
    if [ "$t" = serena ] && ! have serena && ! in_codex serena && ! in_claude serena && ! in_cursor serena; then
      echo "    serena: どの客にも据わっておらぬ"; continue
    fi
    while read -r cl; do state_line "$t" "$cl"; done <<< "$CLIENTS"
  done
  # 鍵は在るか無いかだけ。実体は出さぬ
  if [ -n "${CONTEXT7_API_KEY:-}" ]; then info "context7 の鍵（env）: 在る"; else info "context7 の鍵（env）: 無い（無くとも据わる・動く）"; fi
  info "deepwiki は鍵を持たぬ（上流: free / no-authentication）"
}

if [ "$CHECK" = 1 ]; then do_check; exit 0; fi

# ── 何をするかを述べてから訊く（setup_task_cli.sh の作法） ──
plan_lines() {
  local t cl
  for t in "${PICK[@]}"; do
    case "$t" in
      serena)
        if [ "$UNINSTALL" = 1 ]; then echo "serena を外す（uv tool uninstall serena-agent）"; continue; fi
        have serena || echo "serena を uv で据える（uv tool install --no-python-downloads -p 3.13 serena-agent。python は降ろさぬ）"
        while read -r cl; do
          case "$cl" in
            claude) in_claude serena || echo "serena を claude へ繋ぐ（serena setup claude-code）" ;;
            codex)  in_codex  serena || echo "serena を codex へ繋ぐ（serena setup codex）" ;;
            cursor) in_cursor serena || echo "serena を cursor へ繋ぐ（$CURSOR_CFG へ --context ide で書き足す）" ;;
          esac
        done <<< "$CLIENTS" ;;
      context7|deepwiki)
        [ "$UNINSTALL" = 1 ] && { echo "$t の外しは扱わぬ（登録は各 CLI の設定ゆえ、手で除かれよ）"; continue; }
        local url; [ "$t" = context7 ] && url="$CTX7_URL" || url="$DEEPWIKI_URL"
        while read -r cl; do
          case "$cl" in
            claude) in_claude "$t" || echo "$t を claude へ繋ぐ（claude mcp add -s user -t http $t $url）" ;;
            codex)  in_codex  "$t" || echo "$t を codex へ繋ぐ（codex mcp add $t --url <url>・鍵は書かぬ）" ;;
            cursor) in_cursor "$t" || echo "$t を cursor へ繋ぐ（$CURSOR_CFG へ url を書き足す）" ;;
          esac
        done <<< "$CLIENTS" ;;
    esac
  done
}

PLAN=$(plan_lines)
if [ -z "$PLAN" ]; then ok "することが無い。みな据わっておる（--check で仔細）"; exit 0; fi
info "これから行うこと:"
while read -r l; do echo "      - $l"; done <<< "$PLAN"
if [ "$YES" != 1 ]; then
  printf '  続けてよいか [y/N]: '
  read -r a || a=""
  case "$a" in y|Y|yes) : ;; *) die "やめた。何も変えておらぬ" ;; esac
fi

# ── cursor の mcp.json へ一区画だけ書き足す（既に在れば呼ばれぬ） ──
#
# **不可分に置き換える。** 開いたまま書き戻すと、途中で落ちた時に人の設定が
# 半端な姿で残る。同じ dir へ仮の file を書き、flush と fsync を済ませ、
# 読み直して JSON として妥当なことを確かめてから os.replace で載せ替える。
# 既存の権（mode）は引き継ぎ、しくじった時は仮の file だけを消す。
cursor_add() { # <名> <json 断片（servers の値）>
  local name="$1" frag="$2"
  mkdir -p "$(dirname "$CURSOR_CFG")"
  python3 - "$CURSOR_CFG" "$name" "$frag" <<'PY' || return 1
import json, os, sys, tempfile
path, name, frag = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
# symlink は先へ解いてから置き換える。link の位置で os.replace すると
# link が普通の file に化け、先には何も届かぬ——束ねた設定が黙って割れる。
target = os.path.realpath(path)
tmp = None
try:
    cfg = {"mcpServers": {}}
    if os.path.exists(target):
        with open(target) as f: cfg = json.load(f)
    servers = cfg.setdefault('mcpServers', {})
    if name in servers:  # 二重に守る——呼び手も見ておるが、ここでも触らぬ
        sys.exit(0)
    servers[name] = frag
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target) or '.', prefix='.mcp.json.')
    if os.path.exists(target):
        os.chmod(tmp, os.stat(target).st_mode & 0o7777)
    with os.fdopen(fd, 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    with open(tmp) as f:
        json.load(f)  # 読み直して妥当な JSON であることを確かめる
    os.replace(tmp, target)
except SystemExit:
    raise
except BaseException as e:
    if tmp is not None:
        try: os.unlink(tmp)
        except OSError: pass
    # 生の悲鳴（Traceback）は出さぬ。一行で述べて非 0 で終う
    print(f'書けなんだ: {e}', file=sys.stderr)
    sys.exit(1)
PY
}

# ── codex は CLI に問い、CLI に書かせる ──
#
# config.toml を字面で読むと `[mcp_servers."context7"]` の引用符つきを
# 見逃し、二重に書いて TOML を壊す。在る無しは codex mcp get で問い、
# 足すのは codex mcp add --url で行う（上流の書 developers.openai.com/codex/mcp）。
# CLI が無ければ手で書かぬ——「据えられなんだ」と正直に報じる。
codex_add() { # <名> <url>
  "$CODEX_BIN" mcp add "$1" --url "$2" >/dev/null 2>&1
}

failed=0
for t in "${PICK[@]}"; do
  case "$t" in
    serena)
      if [ "$UNINSTALL" = 1 ]; then
        if have uv && uv tool list 2>/dev/null | grep -q '^serena-agent\b'; then
          uv tool uninstall serena-agent && ok "serena を外した（各 CLI の繋ぎは残る。要らねば手で除かれよ）" || { warn "serena を外せなんだ"; failed=1; }
        else info "serena は uv の棚に居らぬ"; fi
        continue
      fi
      if ! have serena; then
        # uv は入れぬ——人の Python 環境の要であり、仕度が黙って持ち込む物ではない
        have uv || { warn "uv が無い。serena は据えられぬ。入れ方: https://docs.astral.sh/uv/getting-started/installation/"; failed=1; continue; }
        # PyPI の配布は uv が数（hash）を検める。上流は署名を出しておらぬゆえ、
        # 身元の検めはできておらぬ——その旨を正直に述べる（黙って据えぬ）
        info "serena を据える（uv が数を検める。上流は署名を出しておらぬ——身元までは検められぬ）"
        # python は黙って降ろさぬ（--no-python-downloads・上流の旗）。
        uv tool install --no-python-downloads -p 3.13 serena-agent \
          || { warn "serena を据えられなんだ。置いておらぬ。python 3.13 が無いなら先に据えられよ（例: uv python install 3.13）"; failed=1; continue; }
        have serena || { warn "据えたはずの serena が道に無い（uv tool の道が PATH に在るか）"; failed=1; continue; }
        ok "serena を据えた（$(serena --version 2>/dev/null || echo '版は答えぬ')）"
      else
        ok "serena は据わっておる"
      fi
      [ -d "$HOME/.serena" ] || { serena init >/dev/null 2>&1 && ok "serena init を打った" || warn "serena init が通らなんだ"; }
      while read -r cl; do
        case "$cl" in
          claude)
            if in_claude serena; then ok "serena / claude: 据わっておる（触れぬ）"; else
              serena setup claude-code >/dev/null 2>&1 && ok "serena / claude: 繋いだ" || { warn "serena / claude: 繋げなんだ"; failed=1; }
            fi ;;
          codex)
            if in_codex serena; then ok "serena / codex: 据わっておる（触れぬ）"; else
              serena setup codex >/dev/null 2>&1 && ok "serena / codex: 繋いだ" || { warn "serena / codex: 繋げなんだ"; failed=1; }
            fi ;;
          cursor)
            if in_cursor serena; then ok "serena / cursor: 据わっておる（触れぬ）"; else
              # 上流の installer は cursor CLI を名指しせぬ。IDE 系の勧め（--context ide）に従い手で書く
              cursor_add serena '{"command":"serena","args":["start-mcp-server","--project-from-cwd","--context","ide"]}' \
                && ok "serena / cursor: 繋いだ（--context ide）" || { warn "serena / cursor: 繋げなんだ"; failed=1; }
            fi ;;
        esac
      done <<< "$CLIENTS"
      # 効き目は謳わぬ。上流自身の註だけを写す
      info "上流の註: Claude Code と Opus 系の近い更新で、Serena の道具への従いが著しく落ちる——"
      info "上流は claude を system-prompt の上書きつきで起こす手を勧めておる（serena の書を見よ）"
      ;;
    context7|deepwiki)
      [ "$UNINSTALL" = 1 ] && { info "$t の外しは扱わぬ"; continue; }
      url="$CTX7_URL"; [ "$t" = deepwiki ] && url="$DEEPWIKI_URL"
      while read -r cl; do
        case "$cl" in
          claude)
            if in_claude "$t"; then ok "$t / claude: 据わっておる（触れぬ）"; else
              have claude || { warn "$t / claude: claude CLI が無い。繋げなんだ"; failed=1; continue; }
              claude mcp add -s user -t http "$t" "$url" >/dev/null 2>&1 \
                && ok "$t / claude: 繋いだ（鍵なし）" || { warn "$t / claude: 繋げなんだ"; failed=1; }
            fi ;;
          codex)
            if ! have "$CODEX_BIN"; then warn "$t / codex: codex CLI が無い。据えられなんだ（手で config は書かぬ）"; failed=1
            elif in_codex "$t"; then ok "$t / codex: 据わっておる（触れぬ）"; else
              codex_add "$t" "$url" && ok "$t / codex: 繋いだ（鍵なし）" || { warn "$t / codex: 繋げなんだ"; failed=1; }
            fi ;;
          cursor)
            if in_cursor "$t"; then ok "$t / cursor: 据わっておる（触れぬ）"; else
              cursor_add "$t" "{\"url\":\"$url\"}" && ok "$t / cursor: 繋いだ（鍵なし）" || { warn "$t / cursor: 繋げなんだ"; failed=1; }
            fi ;;
        esac
      done <<< "$CLIENTS"
      if [ "$t" = context7 ]; then
        info "鍵は無くとも動く（上流: 鍵は rate limit を上げる推奨）。持つ者は各人の設定へ自分で足されよ"
      fi
      ;;
  esac
done

[ "$failed" = 0 ] || die "一部を据えられなんだ（上の ▲ を見よ）。据わった分は残しておる"
ok "仕度が済んだ。--check で据わり具合を確かめられる"
