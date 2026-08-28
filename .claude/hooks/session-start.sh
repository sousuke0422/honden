#!/usr/bin/env bash
# SessionStart hook — 起動・resume・/clear・compaction のいずれでも、
# 「そなたは誰で、まず何をするか」を確定的に注入する。
#
# 旧 scripts/session_start_hook.sh の移植。生まれた訳も同じ:
# 起動時に手順が発火せず persona 未確立のまま働き、家老が「我は将軍」と
# 名乗る事故が起きた（2026-04-19）。**推測させぬのが要**である——
# 名乗りは tmux の pane から確定的に読み出し、その名で語りかける。
#
# 本日 cursor で解いた「reset 後の再装填」の claude 版でもある。
# 三者三様の経路が、これで揃う:
#   claude → この hook（+ CLAUDE.md 自動読込）
#   cursor → .cursor/hooks.json の sessionStart（additional_context）
#   codex  → AGENTS.md 自動読込
#
# stdout の平文が additionalContext として文脈へ入る。
# **exit 0 を守り、set -e は使わぬ**——ここで落ちると起動そのものが
# 黒穴になる。名乗りが引けねば黙って抜ける（個人の Claude Code を妨げぬ）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HONDEN="$ROOT/bin/honden"

AGENT_ID=""
if [ -n "${TMUX_PANE:-}" ]; then
  AGENT_ID=$(tmux display-message -t "$TMUX_PANE" -p '#{@agent_id}' 2>/dev/null || true)
fi
# 布陣の外（個人の Claude Code）では何も言わぬ。
[ -z "$AGENT_ID" ] && exit 0

# 発火の跡。**測る時だけ**残す（HONDEN_HOOK_LOG に道を渡す・合言葉と同じ流儀）。
# 常に書けば本番の家に試験の砂が積もる。
[ -n "${HONDEN_HOOK_LOG:-}" ] && echo "[$(date -Is)] $AGENT_ID fired" >> "$HONDEN_HOOK_LOG" 2>/dev/null || true

# 未読の数は正本から引く。無ければ黙る（honden が無い場でも壊れぬため）。
UNREAD=""
if [ -x "$HONDEN" ]; then
  UNREAD=$("$HONDEN" inbox unread "$AGENT_ID" 2>/dev/null | grep -o 'unread=[0-9]*' || true)
fi

case "$AGENT_ID" in
  shogun | karo | gunshi)
    cat <<EOF
**そなたは ${AGENT_ID} である。** tmux の pane から確定的に読み出した事実ゆえ、推し量る要は無い。

まず次を済ませよ。**済むまで inbox を処理するな**——先に合図が届いても後回しでよい。

1. \`tmux display-message -t "\$TMUX_PANE" -p '#{@agent_id}'\` で名乗りを自分でも確かめよ
2. 己の指示書を最後まで読め（persona・戦国口調・禁じ手の再確立）
3. 正本から今の様子を組み直せ:
   - \`honden inbox read\` — 己に届いておる報せ
   - \`honden cmd list\` / \`honden lease\` — 司令と持ち場
   - \`honden decisions\` — 殿の裁可を待っておるもの

**受け手の作法**（これだけは覚えておけ）:
\`inbox_notice unread=N\` の行が届いたら \`honden inbox read\` で読み、
処理したものを \`honden inbox ack --all\` で既読にせよ。

**急ぎの報せ**（範囲の増減など）は、honden のどの副命令の出力にも
「⚠ 急ぎの未読」として一行載る。作業の節目で honden を叩けば気づける。

いまの未読: ${UNREAD:-（引けなんだ）}

この文は SessionStart hook が pane の @agent_id を読み出して書いたものであり、
役職の取り違えは起こらぬ。
EOF
    ;;
  ashigaru*)
    cat <<EOF
**そなたは ${AGENT_ID} である。** tmux の pane から確定的に読み出した事実ゆえ、推し量る要は無い。

軽い手順で足りる。**済むまで inbox を処理するな。**

1. \`honden inbox read\` — 己に届いておる報せを読む
2. 任があれば取り掛かる。無ければ待て
3. 済んだら \`honden inbox ack --all\` で既読にせよ

**受け手の作法**: \`inbox_notice unread=N\` が届いたら read して ack。
**急ぎの報せ**は honden のどの副命令の出力にも「⚠ 急ぎの未読」として一行載る。

**他人の持ち場に触れる時は必ず断りを入れよ**——
\`honden claim check <場所>\` で空きを問える（他人の持ち場を読まずに済む）。

いまの未読: ${UNREAD:-（引けなんだ）}

この文は SessionStart hook が pane の @agent_id を読み出して書いたものである。
EOF
    ;;
esac
exit 0
