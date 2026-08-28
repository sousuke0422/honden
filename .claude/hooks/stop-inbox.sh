#!/usr/bin/env bash
# Stop hook — 手を止める前に、未読が残っておらぬかを検める。
#
# 旧 scripts/stop_hook_inbox.sh の移植。**現行 CLAUDE.md の
# 「MANDATORY Post-Task Inbox Check」を機械にしたもの**である——
# 「任を終えたら idle になる前に inbox を検めよ。これは任意ではない」と
# 書いておいても守られぬ日が来る。ここで機械が止める。
#
# 効き目は作法の徹底だけではない。**合図に頼る度合いが下がる**:
# 手を止めようとした時に自分で未読を拾うなら、外から起こす要が減る。
# 現行 CLAUDE.md が「優先度1: agent self-watch」と呼ぶものの実体である。
#
# 旧版から削ったもの:
#   - idle フラグの世話（honden の合図は pane を写して busy を見る）
#   - inotifywait での待ち伏せ（芯が合図を配る。ここで待つと二重になる）
#   - 最後の一言を読んで家老へ自動で報せる件（**移さぬ**——文面の紋様で
#     「完了」を判ずるのは危うい。報告は agent が honden report submit で
#     出すのが筋であり、hook が代わりに騙るべきではない）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HONDEN="$ROOT/bin/honden"

INPUT=$(cat 2>/dev/null || echo '{}')

AGENT_ID="${__STOP_HOOK_AGENT_ID:-}"
if [ -z "$AGENT_ID" ] && [ -n "${TMUX_PANE:-}" ]; then
  AGENT_ID=$(tmux display-message -t "$TMUX_PANE" -p '#{@agent_id}' 2>/dev/null || true)
fi
# 名乗りが引けねば黙って通す。個人の Claude Code を妨げぬ。
[ -z "$AGENT_ID" ] && exit 0
[ -n "${HONDEN_HOOK_LOG:-}" ] && echo "[$(date -Is)] $AGENT_ID stop-hook fired" >> "$HONDEN_HOOK_LOG" 2>/dev/null || true

# 将軍の pane は殿との対話の場である。止めてはならぬ。
[ "$AGENT_ID" = "shogun" ] && exit 0

# 輪を断つ。既に一度止めた後なら、今度は通す。
#
# これが無いと block → 再び Stop → block … と回り続け、agent が
# 永久に手を止められなくなる。**一度で足りる**——二度目は素通しにし、
# それでも未読が残るなら段梯子（L1/L2/L3）が拾う。
if echo "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

[ -x "$HONDEN" ] || exit 0

SUMMARY=$("$HONDEN" inbox unread "$AGENT_ID" 2>/dev/null || true)
COUNT=$(echo "$SUMMARY" | grep -o 'unread=[0-9]*' | head -1 | cut -d= -f2)
[ -z "${COUNT:-}" ] && exit 0
[ "$COUNT" -eq 0 ] 2>/dev/null && exit 0

# 未読あり。止めるのを断り、何が来ておるかを添えて差し戻す。
# 本文は渡さぬ——**読むのは agent の仕事**である（既読の印を付けるのも）。
[ -n "${HONDEN_HOOK_LOG:-}" ] && echo "[$(date -Is)] $AGENT_ID BLOCK (unread=$COUNT)" >> "$HONDEN_HOOK_LOG" 2>/dev/null || true
REASON="未読が ${COUNT} 件残っておる（${SUMMARY# *}）。honden inbox read で読み、処理したものを honden inbox ack --all で既読にしてから手を止めよ。"
R="$REASON" python3 -c "
import json, os
print(json.dumps({'decision': 'block', 'reason': os.environ['R']}, ensure_ascii=False))
" 2>/dev/null || printf '{\"decision\":\"block\",\"reason\":\"未読が %s 件残っておる。honden inbox read で読まれよ。\"}\n' "$COUNT"
exit 0
