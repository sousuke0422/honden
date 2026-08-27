#!/usr/bin/env bash
# cursor sessionStart → 名乗りと作法を注ぐ。
#
# claude の .claude/hooks/session-start.sh、codex の .codex/hooks/session-start.sh と
# 同じ役目。皮だけが違う——cursor は **JSON の additional_context** で注ぐ
# （codex は平文・実測で確かめ済み。同じ形ではない）。
#
# **試験用のままであった**（指示書を移した配下が見つけた・2026-08-28）。
# 中身が「試験環境の受け手作法・合言葉=山吹」で固定されており、本番の
# 名乗りを注いでおらなんだ。据えた当座の実験が、そのまま残っていた形である。
#
# 注入が効いておるかは合言葉で測れる: HONDEN_HOOK_PASSPHRASE を渡すと
# 末尾に付く。常には渡さぬ（毎回文脈を汚す）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HONDEN="$ROOT/bin/honden"
cat > /dev/null

AGENT_ID=""
if [ -n "${TMUX_PANE:-}" ]; then
  AGENT_ID=$(tmux display-message -t "$TMUX_PANE" -p '#{@agent_id}' 2>/dev/null || true)
fi
# 布陣の外（殿ご自身の cursor）では何も言わぬ。
[ -z "$AGENT_ID" ] && exit 0

UNREAD=""
if [ -x "$HONDEN" ]; then
  UNREAD=$("$HONDEN" inbox unread "$AGENT_ID" 2>/dev/null | grep -o 'unread=[0-9]*' || true)
fi

AGENT_ID="$AGENT_ID" UNREAD="${UNREAD:-（引けなんだ）}" PASS="${HONDEN_HOOK_PASSPHRASE:-}" python3 -c '
import json, os
a = os.environ["AGENT_ID"]
heavy = a in ("shogun", "karo", "gunshi")
body = f"""**そなたは {a} である。** tmux の pane から確定的に読み出した事実ゆえ、推し量る要は無い。

まず次を済ませよ。**済むまで inbox を処理するな。**
"""
if heavy:
    body += """
1. `honden brief` で己の指示書を読め（persona・禁じ手・運び方が出る）
2. 正本から今の様子を組み直せ: honden status / honden cmd list / honden inbox read / honden decisions
"""
else:
    body += """
1. `honden inbox read` — 己に届いておる報せを読む
2. 任があれば取り掛かる。無ければ待て
3. 他人の持ち場に触れる時は `honden claim check <場所>` で空きを問え
   （初手では `honden brief` を読まずともよい——文脈の倹約である）
"""
body += f"""
**受け手の作法**: `inbox_notice unread=N …` が届いたら `honden inbox read` で読み、
処理したものを `honden inbox ack --all` で既読にせよ。既読にできるのは己の分だけである。

**急ぎの報せ**は honden のほとんどの副命令の出力に「⚠ 急ぎの未読」として一行載る
（`inbox` 系と `nudge` には載らぬ）。作業の節目で honden を叩けば気づける。

いまの未読: {os.environ["UNREAD"]}
"""
p = os.environ.get("PASS")
if p:
    body += f"\n【合言葉={p}】この語は注入が効いておるかを測るためのものである。\n"
print(json.dumps({"additional_context": body}, ensure_ascii=False))
' 2>/dev/null || true
exit 0
