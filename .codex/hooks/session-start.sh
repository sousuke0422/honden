#!/usr/bin/env bash
# codex SessionStart / PostCompact → 名乗りと作法を注入する。
#
# claude の .claude/hooks/session-start.sh と同じ役目。皮だけが違う。
# codex は SessionStart（スレッド起動）と PostCompact（圧縮の後）を
# 別の出来事として持つゆえ、両方から呼ぶ——**圧縮で文脈が薄れた後こそ
# 名乗りを言い直す要がある**（殿の問い 2026-08-28）。
#
# codex のフックは stdin から JSON を受け、stdout の JSON で返す。
# 文脈への注入は additionalContext を使う。**exit 0 を守る**——
# ここで落ちると起動が黒穴になる。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HONDEN="$ROOT/bin/honden"
cat > /dev/null   # 入力は読み捨てる（名乗りは pane から引く）

AGENT_ID=""
if [ -n "${TMUX_PANE:-}" ]; then
  AGENT_ID=$(tmux display-message -t "$TMUX_PANE" -p '#{@agent_id}' 2>/dev/null || true)
fi
[ -z "$AGENT_ID" ] && exit 0

UNREAD=""
if [ -x "$HONDEN" ]; then
  UNREAD=$("$HONDEN" inbox unread "$AGENT_ID" 2>/dev/null | grep -o 'unread=[0-9]*' || true)
fi

AGENT_ID="$AGENT_ID" UNREAD="${UNREAD:-（引けなんだ）}" python3 -c '
import json, os
a = os.environ["AGENT_ID"]
heavy = a in ("shogun", "karo", "gunshi")
body = f"""**そなたは {a} である。** tmux の pane から確定的に読み出した事実ゆえ、推し量る要は無い。

まず次を済ませよ。**済むまで inbox を処理するな。**
"""
if heavy:
    body += """
1. 己の指示書を最後まで読め（persona・戦国口調・禁じ手の再確立）
2. 正本から今の様子を組み直せ: honden inbox read / honden cmd list / honden lease / honden decisions
"""
else:
    body += """
1. honden inbox read — 己に届いておる報せを読む
2. 任があれば取り掛かる。無ければ待て
3. 他人の持ち場に触れる時は honden claim check <場所> で空きを問え
"""
body += f"""
**受け手の作法**: `inbox_notice unread=N` が届いたら honden inbox read で読み、
処理したものを honden inbox ack --all で既読にせよ。
**急ぎの報せ**は honden のどの副命令の出力にも「⚠ 急ぎの未読」として一行載る。

いまの未読: {os.environ["UNREAD"]}
"""
print(json.dumps({"additionalContext": body}, ensure_ascii=False))
' 2>/dev/null || true
exit 0
