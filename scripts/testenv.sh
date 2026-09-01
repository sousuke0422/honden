#!/usr/bin/env bash
# ============================================================
# honden の試験環境。tmux で布陣を起こし、配達層を通しで検める。
#
#   scripts/testenv.sh up      布陣を起こす（既にあれば断る）
#   scripts/testenv.sh down    布陣を畳む（人が打つ。agent は D006 ゆえ打たぬ）
#   scripts/testenv.sh status  いまの様子
#   scripts/testenv.sh smoke   external-to-honden 経路の疎通試験
#
# ## 本番と混ざらぬための三つの壁
#
#   一、セッション名が違う（honden-test。本番は multiagent / shogun）
#   二、正本が違う（~/.honden-test/。9p を避け ext4 に置く）
#   三、HONDEN_TMUX_SESSION で pane の世界を絞る。
#       試験の karo と本番の karo は同名ゆえ、絞らねば
#       **試験の合図が本番の pane へ飛ぶ**（src/pane.ts の註）
#
# ## Zellij への申し送り
#
# この script の tmux 触りは次の種類のみ。移る時はここが対応表の対象。
#   has-session / new-session / split-window / select-layout /
#   set-option -p @agent_id / list-panes / new-window / kill-session
# ============================================================
set -euo pipefail

# 注: `… | grep -q` は pipefail の下で嘘をつく（grep -q が先に抜け、書き手が
# SIGPIPE で 141 を返す）。この書では受けてから照らす形に統一してある。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="${HONDEN_TEST_SESSION:-honden-test}"
# **本番と同じ二陣構成にする。** 将軍は別の陣に住む。
#
# かつては全員を一つの陣へ入れておった。そのため「芯の射程が働き手の陣だけで、
# 将軍へ合図が届かぬ」穴が試験を素通りした（2026-08-29）。
# **試験環境が本番と形が違えば、その差の中にある穴は永遠に見えぬ。**
SESSION_SHOGUN="${HONDEN_TEST_SESSION_SHOGUN:-$SESSION-shogun}"
TESTHOME="${HONDEN_TEST_HOME:-$HOME/.honden-test}"
DB="$TESTHOME/honden.db"
RECV="$TESTHOME/received"

# 陣の bash に履歴を残させぬ（殿の申し出 2026-08-28）。
# 手で作業される時、配下の打った命が ~/.bash_history に混ざって邪魔になる。
# `HISTSIZE=0` は .bashrc に上書きされて効かぬ——効くのは HISTFILE の方である。
NO_HIST=(-e HISTFILE=/dev/null)

# 試験の陣に居ることを、**pane の環境で教える**。
#
# 一巡試験が釣った穴（2026-08-28）: 足軽の codex が `honden inbox read` を叩いても
# 「未読任なし」と答えた。**本番の正本を見ておった**——`HONDEN_DB` が pane に無く、
# 既定（~/.honden/honden.db）へ行っていた。芯にだけ渡し、働く者へ渡しておらなんだ。
#
# 足軽が「自分は試験の陣に居る」と知る術は無い。**知らせるのは環境の役目**であり、
# 指示書に「試験なら --db を付けよ」と書いて覚えさせる筋ではない
# （書けば、付け忘れた時に黙って本番を触る）。
PANE_ENV=(-e "HONDEN_DB=$DB" -e "HONDEN_TMUX_SESSION=$SESSION,$SESSION_SHOGUN")
AGENTS=(karo gunshi ashigaru1 ashigaru2)   # fixtures/test-env/settings.yaml と揃える
SHOGUN=shogun                             # 別の陣に住む（本番と同じ形）

H_OUT() { env -u TMUX_PANE HONDEN_DB="$DB" "$ROOT/bin/honden" "$@"; }  # 布陣の外として

die() { echo "  ✗ $*" >&2; exit 1; }

# 焼き物が源より古くないか。
#
# 古い bin で試験すると、**塞いだはずの穴が開いたまま試験が走る**。
# 実際に起きた（2026-08-27）: pane のセッション絞りを src へ入れた後、
# 焼き直さずに芯を起こし、手が絞りの無い旧 bin で走って
# **本番の karo pane へ試験の合図を二発撃った**。旧 bin の芯は未読が残る限り
# 60 秒ごとに再送するゆえ、焼き忘れは一発では済まぬ。
freshness() {
  local stale
  stale=$(find "$ROOT/src" -name '*.ts' -newer "$ROOT/bin/honden" 2>/dev/null | head -1)
  [ -n "$stale" ] && die "bin/honden が古い（$stale が新しい）。bun run build で焼き直されよ"
  stale=$(find "$ROOT/core/watch/src" -name '*.rs' -newer "$ROOT/bin/honden-watch" 2>/dev/null | head -1)
  [ -n "$stale" ] && die "bin/honden-watch が古い（$stale が新しい）。cargo build --release で焼き直されよ"
  return 0
}

up() {
  freshness
  [ -x "$ROOT/bin/honden" ] || die "bin/honden が無い。bun run build で焼かれよ"
  [ -x "$ROOT/bin/honden-watch" ] || die "bin/honden-watch が無い。cd core/watch && cargo build --release"
  # 二陣とも見る。片方だけ検めると、残った片割れに新しい陣を接いでしまう。
  for x in "$SESSION" "$SESSION_SHOGUN"; do
    if tmux has-session -t "=$x" 2>/dev/null; then
      die "セッション $x が既に居る。down してから up されよ（黙って作り直しはせぬ）"
    fi
  done

  echo "── 正本を新しく ──"
  rm -rf "$TESTHOME"
  mkdir -p "$TESTHOME" "$RECV"
  H_OUT roster sync --settings "$ROOT/fixtures/test-env/settings.yaml" | tail -2
  touch "$(HONDEN_DB="$DB" "$ROOT/bin/honden" paths signal)"   # 芯の見張る先。先に無いと芯が開けぬ

  echo "── 布陣を起こす ──"
  # HONDEN_TEST_REAL に名を書くと、その pane には受け手でなく**本物の CLI** が座る。
  # 例: HONDEN_TEST_REAL=ashigaru2 scripts/testenv.sh up
  # 起動列は honden 自身の口（config get）から引く——shutsujin と同じく
  # settings が正で、script に CLI の名を焼き込まない。
  local REAL="${HONDEN_TEST_REAL:-}"
  pane_cmd() {
    local a="$1"
    if [ "$a" = "$REAL" ]; then
      local ctype cmodel
      ctype=$(H_OUT config get "cli.agents.$a.type" 2>/dev/null || echo "")
      cmodel=$(H_OUT config get "cli.agents.$a.model" 2>/dev/null || echo "")
      case "$ctype" in
        cursor)
          echo "cd '$ROOT' && exec cursor-agent --yolo${cmodel:+ --model $cmodel}" ;;
        claude)
          echo "cd '$ROOT' && exec claude --dangerously-skip-permissions${cmodel:+ --model $cmodel}" ;;
        *)
          echo "exec bash '$ROOT/scripts/testenv/recv.sh' '$a' '$RECV/$a.log'" ;;  # 知らぬ CLI は受け手
      esac
    else
      echo "exec bash '$ROOT/scripts/testenv/recv.sh' '$a' '$RECV/$a.log'"
    fi
  }
  # 将軍の陣（本番の `shogun` セッションに当たる）
  tmux new-session -d -s "$SESSION_SHOGUN" -n main "${NO_HIST[@]}" "${PANE_ENV[@]}" "$(pane_cmd "$SHOGUN")"
  tmux set-option -p -t "$SESSION_SHOGUN:main" @agent_id "$SHOGUN"

  # 働き手の陣（本番の `multiagent` に当たる）
  tmux new-session -d -s "$SESSION" -n agents "${NO_HIST[@]}" "${PANE_ENV[@]}" "$(pane_cmd "${AGENTS[0]}")"
  for a in "${AGENTS[@]:1}"; do
    tmux split-window -t "$SESSION:agents" "${NO_HIST[@]}" "${PANE_ENV[@]}" "$(pane_cmd "$a")"
    tmux select-layout -t "$SESSION:agents" tiled >/dev/null
  done

  # @agent_id を付ける。pane_index 順 = 作成順として付け、
  # 付けた後に**読み戻して**検める。付けっぱなしは信じない。
  local i=0
  while IFS=$'\t' read -r pid _; do
    tmux set-option -p -t "$pid" @agent_id "${AGENTS[$i]}"
    i=$((i+1))
  done < <(tmux list-panes -t "$SESSION:agents" -F $'#{pane_id}\t#{pane_index}' | sort -t$'\t' -k2 -n)

  echo "── 付いた名を読み戻す ──"
  tmux list-panes -t "$SESSION_SHOGUN:main" -F '  #{pane_id} #{@agent_id}'
  tmux list-panes -t "$SESSION:agents" -F '  #{pane_id} #{@agent_id}'

  echo "── 芯を起こす ──"
  # 芯は落ちても立ち直る（輪の中で回す・二重起動は flock が防ぐ）。
  local CORE_SIGNAL CORE_LOCK
  CORE_SIGNAL=$(HONDEN_DB="$DB" "$ROOT/bin/honden" paths signal)
  CORE_LOCK=$(HONDEN_DB="$DB" "$ROOT/bin/honden" paths lock)
  tmux new-window -t "$SESSION" -n core \
      "while true; do HONDEN_DB='$DB' HONDEN_TMUX_SESSION='$SESSION,$SESSION_SHOGUN' '$ROOT/bin/honden-watch' \
         --path '$CORE_SIGNAL' --lock '$CORE_LOCK' --debounce-ms 300 \
         -- '$ROOT/bin/honden' nudge; echo '芯が落ちた。3 秒後に立て直す'; sleep 3; done"
  sleep 1
  status
}

down() {
  # 畳むのは人の操作。agent には D006（kill 系の禁）があるゆえ、
  # この副命令は殿か人手で打つこと。
  for x in "$SESSION" "$SESSION_SHOGUN"; do
    tmux kill-session -t "$x" 2>/dev/null && echo "  $x を畳んだ" || echo "  $x は居らぬ"
  done
}

status() {
  echo "── セッション ──"
  if tmux has-session -t "$SESSION_SHOGUN" 2>/dev/null; then
    tmux list-panes -s -t "$SESSION_SHOGUN" -F "  $SESSION_SHOGUN:#{window_name}.#{pane_index} #{pane_id} @agent_id=#{@agent_id} #{pane_current_command}"
  fi
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux list-panes -s -t "$SESSION" -F '  #{window_name}.#{pane_index} #{pane_id} @agent_id=#{@agent_id} #{pane_current_command}'
  else
    echo "  居らぬ"
  fi
  echo "── 正本 ──"
  if [ -f "$DB" ]; then
    HONDEN_TMUX_SESSION="$SESSION" H_OUT roster 2>/dev/null | head -8
  else
    echo "  正本が無い"
  fi
}

smoke() {
  tmux has-session -t "$SESSION" 2>/dev/null || die "布陣が居らぬ。先に up されよ"
  freshness
  local stamp="smoke-$(date +%s)"
  # ログは累積する。送る**前**の行数を覚え、それより後に現れた行だけを見る。
  # 見ぬと、前回の smoke の跡で偽陽性になる。
  local before_lines
  before_lines=$(wc -l < "$RECV/karo.log" 2>/dev/null || echo 0)
  echo "── 布陣の外から karo へ送る ──"
  H_OUT inbox write --to karo --type report_received --from testenv_smoke \
    --body "疎通試験 $stamp" | grep -E '→|合図' | sed 's/^/  /'

  echo "── karo の受け手に inbox_notice が届くのを待つ（最大 20 秒） ──"
  local waited=0
  while [ $waited -lt 40 ]; do
    if grep -q -- 'inbox_notice' <<<"$(tail -n "+$((before_lines + 1))" "$RECV/karo.log" 2>/dev/null || true)"; then
      echo "  ✓ 届いた（この smoke で新しく現れた行）:"
      tail -n "+$((before_lines + 1))" "$RECV/karo.log" | grep 'inbox_notice' | tail -1 | sed 's/^/    /'
      echo "── 正本側の未読 ──"
      HONDEN_TMUX_SESSION="$SESSION" H_OUT inbox unread karo | sed 's/^/  /'
      return 0
    fi
    sleep 0.5; waited=$((waited+1))
  done
  echo "  ✗ 20 秒待ったが届かぬ。芯の窓（$SESSION:core）と received/ を検められよ"
  tail -3 "$RECV/karo.log" 2>/dev/null | sed 's/^/    karo.log: /'
  return 1
}

# ============================================================
# to-shogun 経路（旧 inbox_write.sh / inbox_watcher.sh）の試験
#
# 本番リポジトリから**最小のファイル集合をコピー**して別 root に据える。
# ディレクトリごとの symlink は禁物——SCRIPT_DIR の解決が実体側へ落ちた
# 瞬間、**本番の queue へ黙って書く**。コピーなら構造的に起きぬ。
# .venv だけは symlink でよい（読むだけで、書き込み先に効かぬ）。
# ============================================================
SHOGUN_SRC="${HONDEN_SHOGUN_SRC:-$HOME/work/multi-agent-shogun}"
COMPAT="$TESTHOME/shogun-compat"

up_shogun() {
  tmux has-session -t "$SESSION" 2>/dev/null || die "先に up されよ（pane を使い回すゆえ）"
  [ -d "$SHOGUN_SRC/scripts" ] || die "shogun 側が見つからぬ: $SHOGUN_SRC"

  echo "── 最小集合をコピー ──"
  mkdir -p "$COMPAT/scripts" "$COMPAT/lib" "$COMPAT/config" \
           "$COMPAT/queue/inbox" "$COMPAT/queue/tasks" "$COMPAT/queue/metrics" "$COMPAT/flags"
  cp "$SHOGUN_SRC/scripts/inbox_write.sh"   "$COMPAT/scripts/"
  cp "$SHOGUN_SRC/scripts/inbox_watcher.sh" "$COMPAT/scripts/"
  cp "$SHOGUN_SRC/lib/cli_adapter.sh"       "$COMPAT/lib/"
  cp "$SHOGUN_SRC/lib/agent_status.sh"      "$COMPAT/lib/"
  ln -sfn "$SHOGUN_SRC/.venv" "$COMPAT/.venv"   # 読むだけゆえ symlink 可
  # agent 名は本番と**被らせない**（testkaro）。
  #
  # watcher の self-watch 検知は `pgrep -f "inotifywait.*inbox/<agent>.yaml"` で
  # **path を見ない**。本番の watcher が inbox/karo.yaml を見張っておる機で
  # 試験の agent も karo だと、本番の inotifywait を「karo の self-watch」と
  # 誤認して nudge を永遠に SKIP する（実測 2026-08-27。ASW_PHASE でも切れぬ）。
  # 名を分ければ pgrep のパターンが交わらぬ。
  cat > "$COMPAT/config/settings.yaml" <<'YAML'
# 試験用の最小 settings。cli_adapter の get_cli_type だけが読む。
language: ja
cli:
  default: claude
  agents:
    testkaro: { type: claude }
YAML

  echo "── 分離の検め（コピーの SCRIPT_DIR が試験側を指すか） ──"
  local probe
  probe=$(bash -c 'cd / && source /dev/stdin <<EOF
SCRIPT_DIR="\$(cd "\$(dirname "'"$COMPAT"'/scripts/inbox_write.sh")/.." && pwd)"
echo "\$SCRIPT_DIR"
EOF')
  [ "$probe" = "$COMPAT" ] || die "SCRIPT_DIR が試験側を指さぬ: $probe"
  echo "  ✓ SCRIPT_DIR=$probe"

  echo "── watcher を起こす（karo 分・試験 pane 宛て） ──"
  local karo_pane
  karo_pane=$(tmux list-panes -t "$SESSION:agents" -F '#{pane_id} #{@agent_id}' | awk '$2=="karo"{print $1}')
  [ -n "$karo_pane" ] && echo "  karo の pane: $karo_pane" || die "karo の pane が見つからぬ"
  # ASW_PHASE=1: self-watch 前提の nudge 抑止を使わぬ。
  #
  # 抑止の検知は `pgrep -f "inotifywait.*inbox/karo.yaml"` で、**path を見ない**。
  # 本番の watcher が隣で走っておる機では、本番の inotifywait を
  # 「karo の self-watch」と誤認して nudge を永遠に SKIP する（実測 2026-08-27）。
  # これは旧配達層の粗さそのもので、honden の docs/decisions.md 配達層要件に足す。
  #
  # remain-on-exit: watcher が死ぬと窓ごと消えて死因が読めぬ。遺骸を残す。
  tmux new-window -t "$SESSION" -n compat \
    "cd '$COMPAT' && IDLE_FLAG_DIR='$COMPAT/flags' ASW_PHASE=1 exec bash scripts/inbox_watcher.sh testkaro '$karo_pane' claude"
  tmux set-option -t "$SESSION:compat" remain-on-exit on 2>/dev/null || true
  # claude の busy 判定は idle flag を見る。試験の受け手は常に暇ゆえ、旗を立てる
  touch "$COMPAT/flags/shogun_idle_testkaro"
  sleep 1
  tmux list-panes -t "$SESSION:compat" -F '  compat: #{pane_current_command}' 2>/dev/null || true
}

smoke_shogun() {
  [ -d "$COMPAT/queue/inbox" ] || die "先に up-shogun されよ"
  local stamp="smoke-shogun-$(date +%s)"
  local before_lines
  before_lines=$(wc -l < "$RECV/karo.log" 2>/dev/null || echo 0)

  echo "── 旧経路（inbox_write.sh）で karo へ送る ──"
  ( cd "$COMPAT" && bash scripts/inbox_write.sh testkaro "疎通試験 $stamp" report_received testenv_smoke ) \
    | tail -2 | sed 's/^/  /'

  echo "── 正本（YAML）へ書かれたか読み戻す ──"
  grep -q "$stamp" "$COMPAT/queue/inbox/testkaro.yaml" \
    && echo "  ✓ queue/inbox/testkaro.yaml に $stamp が在る" \
    || { echo "  ✗ 書かれておらぬ"; return 1; }

  echo "── 本番の queue に漏れておらぬか ──"
  grep -qr "$stamp" "$SHOGUN_SRC/queue/inbox/" 2>/dev/null \
    && { echo "  ✗ 本番へ漏れた！"; return 1; } \
    || echo "  ✓ 本番の queue には無い（分離が効いておる）"

  echo "── watcher の nudge（inboxN）が karo の受け手へ届くのを待つ（最大 40 秒） ──"
  local waited=0
  while [ $waited -lt 80 ]; do
    if grep -qE -- 'inbox[0-9]+' <<<"$(tail -n "+$((before_lines + 1))" "$RECV/karo.log" 2>/dev/null || true)"; then
      echo "  ✓ 届いた:"
      tail -n "+$((before_lines + 1))" "$RECV/karo.log" | grep -E 'inbox[0-9]+' | tail -1 | sed 's/^/    /'
      return 0
    fi
    sleep 0.5; waited=$((waited+1))
  done
  echo "  ✗ 40 秒待ったが届かぬ。compat 窓と flags を検められよ"
  tmux capture-pane -t "$SESSION:compat" -p 2>/dev/null | grep -v '^\s*$' | tail -5 | sed 's/^/    compat: /'
  return 1
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  smoke) smoke ;;
  up-shogun) up_shogun ;;
  smoke-shogun) smoke_shogun ;;
  *) echo "使い方: $0 up|down|status|smoke|up-shogun|smoke-shogun"; exit 2 ;;
esac
