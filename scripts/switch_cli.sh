#!/usr/bin/env bash
# 配置換え — 一体の CLI と模型を差し替える。
#
# 旧 scripts/switch_cli.sh（521 行）の芯を移した。
#
#   使い方:
#     bash scripts/switch_cli.sh <名> [--type <CLI>] [--model <模型>] [--dry-run]
#
#   例:
#     bash scripts/switch_cli.sh ashigaru3 --type claude --model claude-fable-5
#     bash scripts/switch_cli.sh karo --model claude-opus-5   # 模型だけ替える
#     bash scripts/switch_cli.sh ashigaru3                    # 今の設定で立て直す
#
# 変えたもの:
#   顔ぶれ  cli_adapter.sh の build_cli_command → shutsujin.sh と同じ launch_cmd
#   名乗り  編成順からの逆引き → **pane の @agent_id を直に引く**
#           （旧は settings.yaml の並びから pane 番号を割り出しており、
#            並びが狂うと隣を掴んだ。実際に誤配信事故が起きておる・2026-06-19）
#   正本    settings.yaml を書き換えた後、honden roster sync で正本へ移す
#
# 変えなかったもの: **CLI ごとの抜け方**。ここは実測の塊であり、写す値打ちがある。
#   codex   Escape → Ctrl-C → /exit   （示唆の窓を退けてから）
#   cursor  **/quit**（/exit ではない）
#   claude  /exit
#   その他  /exit
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="${HONDEN_SETTINGS:-$ROOT/config/settings.yaml}"
DB="${HONDEN_DB:-$HOME/.honden/honden.db}"
HONDEN="$ROOT/bin/honden"

c()   { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info(){ echo "  $(c '0;36' '│') $*"; }
ok()  { echo "  $(c '1;32' '✓') $*"; }
warn(){ echo "  $(c '1;33' '▲') $*"; }
die() { echo "  $(c '1;31' '✗') $*" >&2; exit 1; }

AGENT=""; NEW_TYPE=""; NEW_MODEL=""; DRY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --type)  NEW_TYPE="${2:-}"; shift 2 ;;
    --model) NEW_MODEL="${2:-}"; shift 2 ;;
    --dry-run) DRY=true; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) AGENT="$1"; shift ;;
  esac
done
[ -n "$AGENT" ] || die "誰を替えるのか渡されよ。例: switch_cli.sh ashigaru3 --type claude"
[ -x "$HONDEN" ] || die "bin/honden が無い。bun run build を先に"

# ── pane を探す。名乗りで引く（番号で数えぬ）──
#
# 旧は settings.yaml の並びから pane 番号を割り出していた。並びが狂えば
# 隣を掴む——それで誤配信事故が起きた。名乗りは pane が持っておるゆえ、
# 直に問う。
PANE=$(tmux list-panes -a -F '#{pane_id} #{@agent_id}' 2>/dev/null | awk -v a="$AGENT" '$2==a{print $1; exit}')
[ -n "$PANE" ] || die "$AGENT の pane が見つからぬ。布陣に居らぬか、@agent_id が付いておらぬ"

CUR_TYPE=$(tmux show-options -p -t "$PANE" -v @agent_cli 2>/dev/null | tr -d '[:space:]')
[ -n "$CUR_TYPE" ] || CUR_TYPE=$(HONDEN_DB="$DB" "$HONDEN" config get "cli.agents.$AGENT.type" 2>/dev/null)
CUR_MODEL=$(HONDEN_DB="$DB" "$HONDEN" config get "cli.agents.$AGENT.model" 2>/dev/null)

TYPE="${NEW_TYPE:-$CUR_TYPE}"
MODEL="${NEW_MODEL:-$CUR_MODEL}"
[ -n "$TYPE" ] || die "$AGENT の CLI が分からぬ。--type を渡されよ"

info "$AGENT ($PANE): ${CUR_TYPE}/${CUR_MODEL} → ${TYPE}/${MODEL}"

launch_cmd() {
  case "$TYPE" in
    claude)   echo "claude${MODEL:+ --model $MODEL} --dangerously-skip-permissions" ;;
    cursor)   echo "cursor-agent --yolo${MODEL:+ --model $MODEL}" ;;
    codex)    echo "codex${MODEL:+ --model $MODEL} --search --dangerously-bypass-approvals-and-sandbox --no-alt-screen" ;;
    opencode) echo "opencode${MODEL:+ --model $MODEL}" ;;
    *)        echo "" ;;
  esac
}
CMD=$(launch_cmd)
[ -n "$CMD" ] || die "知らぬ CLI である: $TYPE"

if [ "$DRY" = true ]; then
  info "打つ命: $CMD"
  info "--dry-run ゆえ何もせぬ"
  exit 0
fi

# ── settings.yaml を書き換える ──
#
# 正本（DB）を直に書かぬ。settings.yaml が名簿の出所であり、
# そこを直さねば次の出陣で元へ戻る。**書いた後に必ず正本へ移す。**
if [ -n "$NEW_TYPE" ] || [ -n "$NEW_MODEL" ]; then
  AGENT="$AGENT" TYPE="$TYPE" MODEL="$MODEL" SETTINGS="$SETTINGS" python3 - <<'PY' || die "settings.yaml を書き換えられぬ"
import os, re, pathlib, datetime
p = pathlib.Path(os.environ['SETTINGS'])
s = p.read_text()
agent, typ, model = os.environ['AGENT'], os.environ['TYPE'], os.environ['MODEL']
stamp = datetime.date.today().isoformat()

# その者の節だけを、行ごとに差し替える。
# yaml.dump で丸ごと書き直すと**註が消える**（旧版はそれで註を失っていた）。
lines = s.split('\n')
out, inside, done = [], False, False
for l in lines:
    if re.match(rf'^    {re.escape(agent)}:\s*$', l):
        inside = True; out.append(l); continue
    if inside and re.match(r'^    \w', l):   # 次の者の節
        inside = False
    if inside and re.match(r'^      type:', l):
        out.append(f'      type: {typ}  # {stamp}: switch_cli.sh'); done = True; continue
    if inside and re.match(r'^      model:', l):
        out.append(f'      model: {model}  # {stamp}: switch_cli.sh'); done = True; continue
    out.append(l)
if not done:
    raise SystemExit(f'{agent} の節が見つからぬ')
p.write_text('\n'.join(out))
print(f'  settings.yaml: {agent} → {typ}/{model}')
PY
  HONDEN_DB="$DB" "$HONDEN" roster sync --settings "$SETTINGS" >/dev/null 2>&1 \
    && ok "正本へ移した" || warn "正本へ移せなんだ。honden roster sync を手で叩かれよ"
fi

# ── 今の CLI を抜けさせる ──
#
# ここは実測の塊ゆえ旧のまま写した。cursor が /quit なのが罠である。
case "$CUR_TYPE" in
  codex)
    tmux send-keys -t "$PANE" Escape 2>/dev/null || true; sleep 0.3
    tmux send-keys -t "$PANE" C-c 2>/dev/null || true;    sleep 0.5
    tmux send-keys -t "$PANE" "/exit" 2>/dev/null || true; sleep 0.3
    tmux send-keys -t "$PANE" Enter 2>/dev/null || true ;;
  cursor)
    tmux send-keys -t "$PANE" "/quit" 2>/dev/null || true; sleep 0.3
    tmux send-keys -t "$PANE" Enter 2>/dev/null || true ;;
  copilot | kimi)
    tmux send-keys -t "$PANE" C-c 2>/dev/null || true;    sleep 0.5
    tmux send-keys -t "$PANE" "/exit" 2>/dev/null || true; sleep 0.3
    tmux send-keys -t "$PANE" Enter 2>/dev/null || true ;;
  *)
    tmux send-keys -t "$PANE" "/exit" 2>/dev/null || true; sleep 0.3
    tmux send-keys -t "$PANE" Enter 2>/dev/null || true ;;
esac
info "抜けさせた（$CUR_TYPE）"

# ── シェルが戻るのを待つ ──
waited=0
while [ "$waited" -lt 15 ]; do
  sleep 1; waited=$((waited + 1))
  # `… | grep -q` は pipefail の下で嘘をつく（grep -q が先に抜け、書き手が
  # SIGPIPE で 141 を返す）。受けてから照らす。
  tail3=$(tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -v '^$' | tail -3 || true)
  if grep -qE -- '[\$%#❯►] *$' <<<"$tail3"; then
    ok "シェルが戻った（${waited}秒）"
    break
  fi
done
if [ "$waited" -ge 15 ]; then
  # **抜けきらぬまま次を打つと、前の CLI の入力欄に命が刺さる。**
  # 打たずに止める——手で確かめるほうが安い。
  die "シェルが戻らぬ。pane を見て手で抜けさせられよ: tmux attach -t ${PANE}"
fi

# ── 新しいのを起こす ──
tmux set-option -p -t "$PANE" @agent_cli "$TYPE"
tmux set-option -p -t "$PANE" @model_name "$MODEL"
tmux send-keys -t "$PANE" "$CMD"; sleep 0.3
tmux send-keys -t "$PANE" Enter
ok "$AGENT を ${TYPE}/${MODEL} で起こした"

# 門は CLI ごとに据わりが違う。替えた後は必ず検める。
echo ""
"$HONDEN" guard selftest --root "$ROOT" 2>&1 | sed 's/^/  /'
echo ""
info "新しい CLI では hook の信頼が要る場合がある（codex は /hooks で与えよ）"
