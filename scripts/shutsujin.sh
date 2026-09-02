#!/usr/bin/env bash
# 出陣の儀 — 本陣を立てる。
#
# 旧 shutsujin_departure.sh（1095 行）の芯を移した。骨は変えぬ:
#   将軍の陣（1 枚） + 働き手の陣（3×3 の 9 枚）
#   pane に @agent_id / @model_name を付け、縁に名と模型を出す
#   各 pane で CLI を起こす
# 配置はそのままにした。殿の手が覚えておる形ゆえ。
#
# **名だけは変えた。** 旧環境（multi-agent-shogun）と同じ `shogun` /
# `multiagent` を既定にしていたが、それでは並走できぬ——同じ名を取りに行き、
# 同じ pane を撃つ。殿の下知は「独立させる」（2026-09-01）。
# 手が覚えている名を捨てる代わりに、二つの陣が互いを掴まぬ。
#
# 変えたのは中身である:
#
#   顔ぶれ    cli_adapter.sh（bash+python+yaml）→ honden config get
#   合図      inbox_watcher.sh **を 9 本**（各 inotifywait+python 常駐）
#             → 芯（honden-watch）**1 本**。実測 RSS 2.1 MiB
#   正本      queue/*.yaml の束 → SQLite 一つ（退避も一つで済む）
#   門        **新しい**。出陣の前に honden guard selftest で
#             禁じ手の門が生きておるかを確かめる
#
# 撤収は `down`。**己が立てた陣だけ**を畳む——立てた折に付けた印（@honden）が
# この置き場を指す陣に限る。印の無い陣・よその置き場の陣は名が同じでも畳まぬ。
# 己が起こした物は己で片付けねば困る（殿・2026-09-02）。生の tmux kill-session を
# 打つ道は D006 が閉じたままで、畳む筋はこの一つに寄せる。
# **己で構えを取る。** 根の入口（shutsujin_departure.sh）が `set -euo pipefail`
# を敷いても、`exec bash` は SHELLOPTS を渡さぬ——中では errexit が off に
# なっておる（実測 2026-08-30・Issue #8）。入口に頼れば、半端な陣でも 0 で終わる。
#
# errexit（-e）は敷かぬ。この書は「既にある」「立っておらぬ」を warn で
# 流して進む作りゆえ、-e を入れると途中で黙って止まる。
# pipefail と nounset だけを取り、要所は die で明示的に落とす。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 我らの本体。**一箇所で決める。**
#
# 17 箇所で `$ROOT/bin/honden` と書いておった。道が散れば、いつか一つだけ
# 別の物を指す（芯の錠が `<正本>.watch.lock` と `<親>/watch.lock` に割れた
# のと同じ型・Issue #8）。加えて、試験が贋物へ差し替えられるようになる。
HONDEN_BIN="${HONDEN_BIN:-$ROOT/bin/honden}"
SETTINGS="${HONDEN_SETTINGS:-$ROOT/config/settings.yaml}"
DB="${HONDEN_DB:-$HOME/.honden/honden.db}"
# 芯まわりの道は honden に訊く。**shell 側で組み立てぬ**——
# 出陣と検めが各々で組み、名が食い違って「芯は常に死んでおる」と
# 出ておった（実測 2026-08-29）。正は src/status.ts の corePaths。
CORE_SIGNAL=""
CORE_LOCK=""
SESSION_SHOGUN="${HONDEN_SESSION_SHOGUN:-honden}"
SESSION_AGENTS="${HONDEN_SESSION_AGENTS:-honden-agents}"
VIEWER_PORT="${HONDEN_DASHBOARD_PORT:-8788}"
VIEWER_HOST="${HONDEN_DASHBOARD_HOST:-127.0.0.1}"
# 窓を立ててから叩くまでの落ち着きの間。試験では 0 にして待たぬ。
VIEWER_SETTLE="${HONDEN_VIEWER_SETTLE:-2}"

# 陣の bash に履歴を残させぬ。
#
# 殿が手で作業される時、配下の pane が打った命が ~/.bash_history に混ざって
# 邪魔になる（殿の申し出 2026-08-28）。pane は tmux の `-e` で環境を渡せるゆえ、
# `HISTFILE=/dev/null` を最初から握らせる。
#
# **`HISTSIZE=0` は効かぬ**——`.bashrc` が後から上書きする（実測）。
# 効くのは `HISTFILE` の方である。陽性対照つきで確かめた:
# この pane で打った命は履歴に残らず、普通の pane で打てば残る。
NO_HIST=(-e HISTFILE=/dev/null)

# tmux の的は **前方一致** で探される。`has-session -t shutsujin-probe` が
# `shutsujin-probe-shogun` に当たって「既にある」と誤判した（試しで実測）。
# 陣の有無を問う時は `=` を付けて厳密一致にすること。
c()   { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info(){ echo "  $(c '0;36' '│') $*"; }
ok()  { echo "  $(c '1;32' '✓') $*"; }
warn(){ echo "  $(c '1;33' '▲') $*"; }
die() { echo "  $(c '1;31' '✗') $*" >&2; exit 1; }

# **`… | grep -q` は pipefail の下で嘘をつく。**
#
# `grep -q` は見つけた瞬間に抜ける。書き手がまだ書いておれば SIGPIPE で 141 を
# 返し、`pipefail` がそれを拾う——**印が合うておるのに「無い」と答える**。
# 出るか出ぬかは走りの速さ次第ゆえ、気まぐれに見える。
#
# 初めての札 v0.1.0-rc.1 の門で、窓の生死がこれで割れた（CI で二度、形を変えて
# 現れ、手元では一度も出ぬ）。計器を計器で測る釘を置いて、ようやく場所が定まった。
#
# 一度受けてから照らす。**パイプを作らねば、この筋は消える。**
grepq()  { grep -qE  -- "$1" <<<"$2"; }
grepqi() { grep -qiE -- "$1" <<<"$2"; }

banner() {
  echo ""
  echo "$(c '1;33' '  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓')"
  echo "$(c '1;33' '  ┃') $(c '1;37' '🏯 honden')  〜 $(c '1;36' '戦国マルチエージェント統率システム') 〜   $(c '1;33' '┃')"
  echo "$(c '1;33' '  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛')"
  echo ""
}

# ── 出陣の前に検める ───────────────────────────────────────────────
#
# 古い binary で撃つと、直したはずの穴から撃つことになる。
# 一度これで試験の合図が本番の家老へ飛んだ（2026-08-27）。
freshness() {
  [ -x "$HONDEN_BIN" ] || die "bin/honden が無い。bun run build を先に"
  local stale
  stale=$(find "$ROOT/src" -name '*.ts' -newer "$HONDEN_BIN" 2>/dev/null | head -1)
  [ -n "$stale" ] && die "bin/honden が古い（$stale が新しい）。bun run build で焼き直されよ"
  [ -x "$ROOT/bin/honden-watch" ] || die "bin/honden-watch が無い。cd core/watch && cargo build --release"
  [ -x "$ROOT/bin/honden-parse" ] || die "bin/honden-parse が無い。cd core/guard && cargo build --release && cp target/release/honden-parse ../../bin/"
  stale=$(find "$ROOT/core/guard/src" -name '*.rs' -newer "$ROOT/bin/honden-parse" 2>/dev/null | head -1)
  [ -n "$stale" ] && die "bin/honden-parse が古い（$stale が新しい）。cargo build --release で焼き直されよ"
  stale=$(find "$ROOT/core/watch/src" -name '*.rs' -newer "$ROOT/bin/honden-watch" 2>/dev/null | head -1)
  [ -n "$stale" ] && die "bin/honden-watch が古い（$stale が新しい）。cargo build --release で焼き直されよ"
  return 0
}

# `honden` が道（PATH）に在るか。
#
# 指示書は一貫して `honden brief` / `honden inbox read` と**名で**書いておる。
# 道に無ければ、その全ての行がそのままでは通らぬ——一巡試験で足軽が
# 叩き方を探して彷徨った（2026-08-28）。**探索で凌げてしまうのが厄介**で、
# 凌げた時は誰も気づかぬ。
#
# `-e PATH=…` で pane へ渡す手は**効かぬ**（`.bashrc` が上書きする・実測）。
# `~/.local/bin` へ繋ぐのが筋である（cursor-agent も codex も其処に居る）。
path_check() {
  if command -v honden >/dev/null 2>&1; then
    ok "honden は道に在る（$(command -v honden)）"
  else
    warn "honden が道に無い。指示書の命令行がそのままでは通らぬ。繋がれよ:"
    echo "      ln -sfn '$HONDEN_BIN' ~/.local/bin/honden"
  fi
}

# 禁じ手の門が生きておるか。**据えただけでは効かぬ**ゆえ、出陣のたびに叩く。
gate() {
  local out
  out=$("$HONDEN_BIN" guard selftest --root "$ROOT" 2>&1)
  echo "$out" | sed 's/^/  /'
  if grepq '効いておらぬ' "$out"; then
    warn "門が効いておらぬまま出陣する。直すまで守りは無いと思え"
  fi
}

roster_of() {
  HONDEN_DB="$DB" "$HONDEN_BIN" roster 2>/dev/null | awk '{print $1}' | grep -v '^$'
}

cli_of()   { HONDEN_DB="$DB" "$HONDEN_BIN" config get "cli.agents.$1.type"  2>/dev/null; }
model_of() { HONDEN_DB="$DB" "$HONDEN_BIN" config get "cli.agents.$1.model" 2>/dev/null; }

# 一体を起こす命。旧 lib/cli_adapter.sh の build_cli_command を移した。
launch_cmd() {
  local agent="$1" cli model
  cli=$(cli_of "$agent"); model=$(model_of "$agent")
  case "$cli" in
    claude)   echo "claude${model:+ --model $model} --dangerously-skip-permissions" ;;
    cursor)   echo "cursor-agent --yolo${model:+ --model $model}" ;;
    codex)    echo "codex${model:+ --model $model} --search --dangerously-bypass-approvals-and-sandbox --no-alt-screen" ;;
    opencode) echo "opencode${model:+ --model $model}" ;;
    *)        echo "" ;;
  esac
}

# 起こす命を隔離の構えで包む。既定（isolation 無し）は素通し。
#
# **die をこの中に置いてはならぬ。** 呼び手は `$( )` で受けるゆえ、中の die は
# 子 shell を終えるだけで親は進む——包みに失敗したのに status 0 で出陣が
# 続いた（bats が釣った・2026-09-02）。失敗は戻り値で返し、呼び手が die する。
wrap_launch() {
  local wrapped rc
  wrapped=$(HONDEN_DB="$DB" "$HONDEN_BIN" isolate wrap --cmd "$1" ${2:+--cli "$2"}); rc=$?
  [ "$rc" -ne 0 ] && return 1
  # 贋の honden（試験）が空を返す時は包まず素通し。実物は none でも命を返す
  [ -n "$wrapped" ] && echo "$wrapped" || echo "$1"
}

label_of() {
  case "$1" in
    shogun) echo "将軍" ;; karo) echo "家老" ;; gunshi) echo "軍師" ;;
    ashigaru*) echo "足${1#ashigaru}" ;; *) echo "$1" ;;
  esac
}

up() {
  banner
  freshness
  ok "binary は新しい"
  CORE_SIGNAL=$(HONDEN_DB="$DB" "$HONDEN_BIN" paths signal)
  CORE_LOCK=$(HONDEN_DB="$DB" "$HONDEN_BIN" paths lock)

  # 出陣のたびに写しを一枚焼く。名簿の入れ替えは正本を書き換えるゆえ、その前に。
  if [ -f "$DB" ]; then
    HONDEN_DB="$DB" "$HONDEN_BIN" backup >/dev/null 2>&1 \
      && ok "正本の写しを焼いた（~/.honden/backups）" \
      || warn "写しを焼けなんだ。正本が壊れた時の戻り先が無いまま進む"
  fi

  info "名簿を入れ替える（$SETTINGS）"
  HONDEN_DB="$DB" "$HONDEN_BIN" roster sync --settings "$SETTINGS" >/dev/null 2>&1 \
    || die "名簿を入れ替えられぬ。$SETTINGS を検められよ"

  local agents=() a
  while read -r a; do [ -n "$a" ] && agents+=("$a"); done < <(roster_of)
  [ ${#agents[@]} -gt 0 ] || die "名簿が空である"

  # 差配役を先に、働く者を後に。旧環境の並び（家老→足軽→軍師）に寄せる。
  local order=() rest=()
  for a in "${agents[@]}"; do
    case "$a" in karo) order+=("$a") ;; shogun|gunshi) ;; *) rest+=("$a") ;; esac
  done
  order+=("${rest[@]}")
  for a in "${agents[@]}"; do [ "$a" = gunshi ] && order+=("$a"); done
  ok "顔ぶれ ${#order[@]} 体（+ 将軍）"

  # ── 本陣（将軍）──
  #
  # **立てた陣にだけ召喚する。** 既にある陣へ命を打ち込むと、働いておる者の
  # 入力欄へ `claude --dangerously-skip-permissions` が流れ込む——手が止まり、
  # 途中の仕事が壊れる。出陣を二度打った時に起きる（敵対レビュー critical・
  # 2026-08-29）。「既にある」と警めながら、その後そのまま打っておった。
  #
  # **己の陣なら畳んで立て直す。** 旧環境の出陣は引数無しで打てば常に
  # 撤収してから立てた——その手癖を引き継ぐ（殿・2026-09-02）。
  # ただし旧は名だけで畳んだ。ここは印（@honden）で己の物と判じた時だけ畳み、
  # よその陣なら触らずに召喚も行わぬ。
  local made_shogun=0 made_agents=0
  if tmux has-session -t "=$SESSION_SHOGUN" 2>/dev/null && ! { info "$SESSION_SHOGUN は立っておる。畳んで立て直す"; fold "$SESSION_SHOGUN"; }; then
    warn "$SESSION_SHOGUN は既にあり、我らの物ではない。召喚は行わぬ"
  else
    made_shogun=1
    tmux new-session -d -s "$SESSION_SHOGUN" -n main -c "$ROOT" "${NO_HIST[@]}"
    tmux set-option -t "$SESSION_SHOGUN" @honden "$ROOT"
    tmux set-option -p -t "$SESSION_SHOGUN:main" @agent_id shogun
    tmux set-option -p -t "$SESSION_SHOGUN:main" @agent_cli "$(cli_of shogun)"
    tmux set-option -p -t "$SESSION_SHOGUN:main" @model_name "$(model_of shogun)"
    ok "本陣を立てた（将軍 / $(cli_of shogun) / $(model_of shogun)）"
  fi

  # ── 陣（家老・足軽・軍師）──
  if tmux has-session -t "=$SESSION_AGENTS" 2>/dev/null && ! { info "$SESSION_AGENTS は立っておる。畳んで立て直す"; fold "$SESSION_AGENTS"; }; then
    warn "$SESSION_AGENTS は既にあり、我らの物ではない。召喚は行わぬ"
  else
    made_agents=1
    tmux new-session -d -s "$SESSION_AGENTS" -n agents -c "$ROOT" "${NO_HIST[@]}"
    # 我らの陣である印。**接ぎ木の前に必ず確かめる。**
    # `multiagent` は世に一つではない——よその陣へ窓を接げば、書に記した
    # 撤収の手（tmux kill-session -t multiagent）が他人の陣を畳む
    # （敵対レビュー critical・2026-08-29）。
    tmux set-option -t "$SESSION_AGENTS" @honden "$ROOT"
    local i
    for ((i = 1; i < ${#order[@]}; i++)); do
      tmux split-window -t "$SESSION_AGENTS:agents" -c "$ROOT" "${NO_HIST[@]}"
      tmux select-layout -t "$SESSION_AGENTS:agents" tiled >/dev/null
    done

    # @agent_id を付ける。**付けた後に読み返して確かめる**——
    # 番号のずれで隣へ撃った事故が旧環境にある（2026-06-19）。
    local ids=() pid
    while read -r pid; do ids+=("$pid"); done < <(
      tmux list-panes -t "$SESSION_AGENTS:agents" -F '#{pane_index} #{pane_id}' | sort -n | awk '{print $2}'
    )
    for ((i = 0; i < ${#order[@]} && i < ${#ids[@]}; i++)); do
      tmux set-option -p -t "${ids[$i]}" @agent_id "${order[$i]}"
      tmux set-option -p -t "${ids[$i]}" @agent_cli "$(cli_of "${order[$i]}")"
      tmux set-option -p -t "${ids[$i]}" @model_name "$(model_of "${order[$i]}")"
      tmux set-option -p -t "${ids[$i]}" @current_task ""
      tmux select-pane -t "${ids[$i]}" -T "$(label_of "${order[$i]}")"
      local got
      got=$(tmux display-message -t "${ids[$i]}" -p '#{@agent_id}')
      [ "$got" = "${order[$i]}" ] || die "名乗りが付かぬ: ${ids[$i]} に ${order[$i]} を付けたが $got と読める"
    done
    tmux set-option -t "$SESSION_AGENTS" -w pane-border-status top
    tmux set-option -t "$SESSION_AGENTS" -w pane-border-format \
      '#{?pane_active,#[reverse],}#[bold]#{@agent_id}#[default] (#{@model_name}) #{@current_task}'
    ok "陣を立てた（${#order[@]} 枚・名乗りは読み返して確かめた）"
  fi

  # ── 門と道を検める ──
  echo ""
  path_check
  gate
  echo ""

  # ── 各々を起こす ──
  local cmd
  if [ "$made_shogun" = 0 ] && [ "$made_agents" = 0 ]; then
    info "陣は既に立っておる。召喚は行わぬ（働いておる者の手を止めぬため）"
  else
    info "各々を召喚する"
  fi
  cmd=$(launch_cmd shogun)
  if [ -n "$cmd" ]; then
    cmd=$(wrap_launch "$cmd" "$(cli_of shogun)") || die "隔離の包みに失敗した。裸では起こさぬ（理由は上の報せ）"
  fi
  if [ "$made_shogun" = 1 ] && [ -n "$cmd" ]; then
    tmux send-keys -t "$SESSION_SHOGUN:main" "$cmd"; sleep 0.3
    tmux send-keys -t "$SESSION_SHOGUN:main" Enter
    info "将軍 … $(cli_of shogun)"
  fi
  local ids=() pid
  while read -r pid; do ids+=("$pid"); done < <(
    tmux list-panes -t "$SESSION_AGENTS:agents" -F '#{pane_index} #{pane_id}' | sort -n | awk '{print $2}'
  )
  local i
  for ((i = 0; made_agents == 1 && i < ${#order[@]} && i < ${#ids[@]}; i++)); do
    cmd=$(launch_cmd "${order[$i]}")
    [ -n "$cmd" ] || { warn "${order[$i]}: 知らぬ CLI ゆえ起こさぬ"; continue; }
    cmd=$(wrap_launch "$cmd" "$(cli_of "${order[$i]}")") || die "隔離の包みに失敗した。裸では起こさぬ（理由は上の報せ）"
    tmux send-keys -t "${ids[$i]}" "$cmd"; sleep 0.3
    tmux send-keys -t "${ids[$i]}" Enter
    info "$(label_of "${order[$i]}") … $(cli_of "${order[$i]}") / $(model_of "${order[$i]}")"
    sleep 1
  done

  # ── 芯を起こす ──
  #
  # 旧環境はここで inbox_watcher.sh を **9 本** 立てた（各々が
  # inotifywait と python を抱えて常駐する）。honden は 1 本で足りる。
  echo ""
  # 合図の器を先に作る。芯は **signal を見張る**（正本を直に見張ると
  # 自分の書き込みで自分が起きる輪ができる）。器が無ければ芯は
  # 「見張れる先が一つも無い」と言って即座に死ぬ——窓ごと消えるゆえ、
  # 起こしたつもりで死んでおることに気づけぬ（試しで実測）。
  : > "$CORE_SIGNAL" 2>/dev/null || true

  # 既に動いておるかは **窓の有無** で見る。command line への pgrep は
  # 己の command line にも当たる——旧 watcher の自己検知が隣を掴んだのと
  # 同じ型で、移植でそのまま踏んだ（試しで実測）。
  # 二重起動そのものは芯が flock で防ぐゆえ、ここは目安でよい。
  if ! ours "$SESSION_AGENTS"; then
    warn "$SESSION_AGENTS は我らの陣ではない（@honden の印が無い）。芯は接がぬ"
  elif grepq '^core$' "$(tmux list-windows -t "=$SESSION_AGENTS" -F '#{window_name}' 2>/dev/null || true)"; then
    warn "芯の窓は既にある"
  else
    # 芯は落ちても立ち直る。exec で置き換えず、輪の中で回す——
    # 落ちた芯は誰も起こしてくれぬ（合図が黙って止まる）ことを一巡試験で見た。
    # 二重起動は芯自身の flock が防ぐゆえ、輪が二重でも害は無い。
    tmux new-window -d -t "=$SESSION_AGENTS" -n core -c "$ROOT" \
      "while true; do HONDEN_DB='$DB' HONDEN_TMUX_SESSION='$SESSION_AGENTS,$SESSION_SHOGUN' '$ROOT/bin/honden-watch' \
         --path '$CORE_SIGNAL' --lock '$CORE_LOCK' -- '$HONDEN_BIN' nudge; \
         echo \"[\$(date -Is)] 芯が落ちた。3 秒後に立て直す\"; sleep 3; done"
    sleep 1
    if grepq '^core$' "$(tmux list-windows -t "=$SESSION_AGENTS" -F '#{window_name}' 2>/dev/null || true)"; then
      ok "芯を起こした（旧環境の watcher 9 本ぶん）"
    else
      warn "芯を起こしたが窓が消えた。合図が届かぬ——手で確かめられよ:"
      echo "      HONDEN_DB='$DB' '$ROOT/bin/honden-watch' --path '$CORE_SIGNAL' --lock '$CORE_LOCK' -- "$HONDEN_BIN" nudge"
    fi
  fi

  viewer
  earpiece

  echo ""
  echo "  $(c '1;36' '「「「 はっ！！ 出陣いたす！！ 」」」')"
  echo ""
  info "本陣: tmux attach -t $SESSION_SHOGUN"
  info "陣  : tmux attach -t $SESSION_AGENTS"
  info "戦況: http://$VIEWER_HOST:$VIEWER_PORT"
  info "様子: bash shutsujin_departure.sh status"
  echo ""
}

# 携帯からの文を聴く耳。**設定が無ければ立てぬ。**
#
# 旧環境は shutsujin が ntfy_listener.sh を必ず立てておった。ここでは
# topic が設定されておる時だけ立てる——無いまま立てれば、繋がらぬ curl を
# 延々と張り直す窓が残り、**「立っておる」が「効いておる」に見える**。
#
# 落ちても立ち直る形は芯と同じ。ただし芯と違い、これは**無くとも布陣は
# 回る**ゆえ、立たなんだ時も出陣は止めぬ。
earpiece() {
  local topic
  topic=$(HONDEN_DB="$DB" "$HONDEN_BIN" config get notify.ntfy.topic 2>/dev/null | tr -d '[:space:]')
  [ -z "$topic" ] && return 0

  if ! ours "$SESSION_AGENTS"; then
    warn "$SESSION_AGENTS は我らの陣ではない（@honden の印が無い）。耳は接がぬ"
    return 0
  fi
  if grepq '^ntfy$' "$(tmux list-windows -t "=$SESSION_AGENTS" -F '#{window_name}' 2>/dev/null || true)"; then
    warn "耳の窓は既にある"
    return 0
  fi

  local qdb qhonden
  qdb=$(printf '%q' "$DB"); qhonden=$(printf '%q' "$HONDEN_BIN")
  tmux new-window -d -t "=$SESSION_AGENTS" -n ntfy -c "$ROOT" \
    "while true; do HONDEN_DB=$qdb $qhonden ntfy listen; \
       echo \"[\$(date -Is)] 耳が落ちた。5 秒後に張り直す\"; sleep 5; done"
  sleep 1
  if grepq '^ntfy$' "$(tmux list-windows -t "=$SESSION_AGENTS" -F '#{window_name}' 2>/dev/null || true)"; then
    ok "携帯からの耳を立てた（topic は設定に在り）"
  else
    warn "耳を立てたが窓が消えた。携帯からの文は届かぬ——手で確かめられよ:"
    echo "      HONDEN_DB=$qdb $qhonden ntfy listen"
  fi
}

# その陣は我らのものか。立てた折に付けた印（@honden）で見る。
#
# 名だけで判ずると、同じ名のよその陣へ窓を接ぐ。接いだ後で「撤収は
# tmux kill-session -t multiagent」と案内すれば、他人の陣ごと畳ませてしまう。
ours() {
  # **`show-options -t "=名"` は tmux 3.7b で黙って空を返す**（`=` 無しなら
  # 返る）。has-session / kill-session は `=` で正しく効くゆえ、印を読む所
  # だけが空になり、立てた直後の己の陣を「我らの物ではない」と言うた
  # （実戦で踏んだ・2026-09-02。贋の tmux で試しておったゆえ釣れなんだ）。
  #
  # `=` を外せば前方一致になり、`honden` が `honden-agents` を掴みうる。
  # ゆえに一覧を引いて**名の完全一致**で取る——芯（src/pane.ts）と同じ手。
  local mark
  mark=$(tmux list-sessions -F '#{session_name}'$'\t''#{@honden}' 2>/dev/null \
    | awk -F'\t' -v n="$1" '$1 == n { print $2; exit }')
  [ -n "$mark" ] && [ "$mark" = "$ROOT" ]
}

# 撤収。己が立てた陣だけを畳む。
#
# 芯・耳・窓は陣の中の窓で回っておるゆえ、陣が消えれば共に終わる
# （SIGHUP）。陣の外で回る迷い子（status の strays）はここでは触らぬ——
# 誰が起こしたか判ぜぬ物を撃つのは honden-kill の領分でもない。
#
# 順は働き手の陣が先。将軍の陣を先に畳むと、働き手の報せが宛先を失って
# 芯が空撃ちを重ねる。
down() {
  info "撤収"
  local n
  for n in "$SESSION_AGENTS" "$SESSION_SHOGUN"; do
    if ! tmux has-session -t "=$n" 2>/dev/null; then
      ok "$n は立っておらぬ"
      continue
    fi
    fold "$n" || true
  done
}

# 一つの陣を畳む。**己の物でなければ畳まず 1 を返す。**
# 出陣（立て直し）と撤収の両方がここを通る。畳む筋は一つに寄せる。
fold() {
  local n="$1"
  if ! ours "$n"; then
    warn "$n は我らの陣ではない（@honden の印が $ROOT を指さぬ）。畳まぬ"
    echo "      名が同じでも、印の無い陣・よその置き場の陣には手を出さぬ。"
    echo "      人の手で畳むなら: tmux kill-session -t $n"
    return 1
  fi
  if tmux kill-session -t "=$n" 2>/dev/null; then
    ok "$n を畳んだ"
  else
    warn "$n を畳めなんだ（tmux が拒んだ）"
    return 1
  fi
}

# 我らの戦況の窓が、その口で応えておるか。
#
# 見分けは**印**で行う（配信が返す X-Honden）。「口が塞がっておる」でも
# 「窓という名の window がある」でもない——どちらもよその者で成り立つ。
# 8787 に OpenAI の中継が座っておった一件がまさにそれである。
#
# `--noproxy` を必ず付ける。この機は http_proxy を持っており、**己の内への
# 問い合わせまで中継へ回される**（将軍自身が検分中に踏んだ・2026-08-29）。
viewer_alive() {
  local head
  head=$(curl -sf --noproxy '*' -m 2 -o /dev/null -D - "http://$1:$2/api/version" 2>/dev/null) || return 1
  grepqi '^x-honden:' "$head"
}

# 戦況の窓。出陣に含めるが、単体でも立て直せる（`shutsujin_departure.sh viewer`）。
#
# 旧環境では dashboard-viewer.py を殿が手で起こしておった。honden では
# 出陣に含める（殿の下知 2026-08-29）。芯と同じく輪の中で回して立ち直らせる。
viewer() {
  # **外へ開いておるなら、まず断る。** 窓の中（tmux の別窓）へ出しても誰も
  # 読まぬ——出陣を打った者の目の前でなければ、警めは届かぬ（Issue #8）。
  #
  # 立てる時だけでなく**既に立っておる時も言う**。危ういのは「今開いたか」
  # ではなく「開いておるか」であり、二度目に黙れば忘れられる。
  if [ "$VIEWER_HOST" != "127.0.0.1" ]; then
    warn "戦況を外へ開いておる（$VIEWER_HOST）。司令・裁可・陣容が見える範囲を確かめられよ"
  fi

  # 陣が無ければ窓は開けぬ。tmux の生の悲鳴を出さず、先に言う。
  if ! tmux has-session -t "=$SESSION_AGENTS" 2>/dev/null; then
    warn "$SESSION_AGENTS が立っておらぬ。先に出陣されよ（bash shutsujin_departure.sh）"
    return 0
  fi
  if ! ours "$SESSION_AGENTS"; then
    warn "$SESSION_AGENTS は我らの陣ではない（@honden の印が無い）。窓は接がぬ:"
    echo "      よその陣へ接ぐと、撤収の手が他人の陣を畳む。"
    echo "      別の名で立てられよ: HONDEN_SESSION_AGENTS=<名> bash shutsujin_departure.sh"
    return 0
  fi

  # 既に我らが配っておるなら、それでよい。
  if viewer_alive "$VIEWER_HOST" "$VIEWER_PORT"; then
    ok "戦況の窓は既に応えておる（http://$VIEWER_HOST:$VIEWER_PORT）"
    return 0
  fi

  # 口が塞がっておるのに我らが応えぬ——**よその者が座っておる**。
  # 二本目を立てても輪の中で失敗を刷り続けるだけゆえ、立てぬ。
  if grepq "[.:]$VIEWER_PORT[[:space:]]" "$(ss -ltn 2>/dev/null || true)"; then
    warn "口 $VIEWER_PORT によその者が座っておる。別の口で開かれよ:"
    echo "      HONDEN_DASHBOARD_PORT=<番号> bash shutsujin_departure.sh viewer"
    return 0
  fi

  if grepq '^viewer$' "$(tmux list-windows -t "=$SESSION_AGENTS" -F '#{window_name}' 2>/dev/null || true)"; then
    warn "viewer 窓はあるが、口 $VIEWER_PORT では応えぬ。別の口で配っておるか、倒れておる:"
    echo "      tmux attach -t $SESSION_AGENTS \\; select-window -t viewer   # 中を見る"
    echo "      （窓を畳んで立て直すのは人の手で。D006 によりこの書は畳めぬ）"
    return 0
  fi

  # 輪は**諦める**。永遠に立て直すと、直らぬ失敗を 3 秒ごとに刷り続ける。
  # **道は %q で包む。** 単引用符で括ると、道に ' があった時に破れる
  # （Issue #8）。printf %q は shell が読み戻せる形にしてくれる。
  local qdb qhonden qport qhost
  qdb=$(printf '%q' "$DB")
  qhonden=$(printf '%q' "$HONDEN_BIN")
  qport=$(printf '%q' "$VIEWER_PORT")
  qhost=$(printf '%q' "$VIEWER_HOST")
  if ! tmux new-window -d -t "=$SESSION_AGENTS" -n viewer -c "$ROOT" \
    "n=0; while [ \$n -lt 5 ]; do HONDEN_DB=$qdb $qhonden dashboard --serve \
       --port $qport --host $qhost && break; \
       n=\$((n+1)); echo \"[\$(date -Is)] 戦況の窓が落ちた（\$n/5）。3 秒後に立て直す\"; sleep 3; done; \
     if [ \$n -ge 5 ]; then echo '五度倒れたゆえ諦めた。この窓は残す——何があったか読まれよ。'; \
     else echo '止めよとの合図を受けた。窓は残す（立て直すなら shutsujin_departure.sh viewer）。'; fi; exec bash"; then
    warn "窓を開けなんだ（tmux が受け付けぬ）"
    return 0
  fi

  # **一度きりで判ぜぬ。** 冷えた /mnt/c では起き上がりに数秒かかり、
  # 一度の下見で偽の「応えぬ」を出す（Issue #8）。間を置いて幾度か問う。
  local alive=0 i
  for i in 1 2 3 4 5; do
    if viewer_alive "$VIEWER_HOST" "$VIEWER_PORT"; then alive=1; break; fi
    [ "$VIEWER_SETTLE" = 0 ] && break   # 試験は待たぬ
    sleep 1
  done
  if [ "$alive" = 1 ]; then
    ok "戦況の窓を開いた（http://$VIEWER_HOST:$VIEWER_PORT）"
  else
    warn "戦況の窓を立てたが応えぬ。中を見られよ:"
    echo "      tmux attach -t $SESSION_AGENTS \\; select-window -t viewer"
  fi
}

status() {
  echo "  本陣・陣"
  for s in "$SESSION_SHOGUN" "$SESSION_AGENTS"; do
    tmux has-session -t "=$s" 2>/dev/null \
      && tmux list-panes -s -t "$s" -F "    $s:#{window_name}.#{pane_index} #{pane_id} @agent_id=#{@agent_id} #{pane_current_command}" \
      || echo "    $s: 立っておらぬ"
  done
  echo ""
  echo "  芯"
  # **我らの芯だけ数える。** `honden-watch` の名で数えると、他所の陣
  # （試験環境・別の正本）の芯まで並ぶ。見張る先で絞る。
  #
  # `grep | awk || echo` は**死んだ枝**であった——awk が必ず 0 で終わるゆえ
  # 「動いておらぬ」へ辿り着けぬ（敵対レビュー・2026-08-29）。受けてから数える。
  local core
  local sig
  # 逃げ道は置かぬ。道を自前で組めば、また食い違う。
  sig=$(HONDEN_DB="$DB" "$HONDEN_BIN" paths signal) || {
    echo "    道が引けぬ（bin/honden が答えぬ）"; sig=""
  }
  core=$(ps -eo pid,rss,args | grep '[b]in/honden-watch' | grep -F -- "$sig" || true)
  if [ -n "$core" ]; then
    echo "$core" | awk '{printf "    pid=%s RSS %.1f MiB\n", $1, $2/1024}'
  else
    echo "    動いておらぬ（見張る先: $sig）"
  fi
  echo ""
  echo "  戦況の窓"
  if viewer_alive "$VIEWER_HOST" "$VIEWER_PORT"; then
    echo "    応えておる — http://$VIEWER_HOST:$VIEWER_PORT"
  elif grepq "[.:]$VIEWER_PORT[[:space:]]" "$(ss -ltn 2>/dev/null || true)"; then
    echo "    口 $VIEWER_PORT は塞がっておるが、我らではない（よその者）"
  else
    echo "    応えぬ（口 $VIEWER_PORT）"
  fi

  echo ""
  "$HONDEN_BIN" status 2>&1 | sed 's/^/  /'
  echo ""
  "$HONDEN_BIN" guard selftest --root "$ROOT" 2>&1 | sed 's/^/  /'
}

case "${1:-up}" in
  up)     up ;;
  status) status ;;
  gate)   gate ;;
  viewer) viewer ;;
  earpiece) earpiece ;;
  down)   down ;;
  *)      echo "使い方: shutsujin_departure.sh [up|status|gate|viewer|earpiece|down]"
          echo "  撤収は down（己が立てた陣だけを畳む）"; exit 1 ;;
esac
