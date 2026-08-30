#!/usr/bin/env bats
# 合図の射程——**本物の tmux で**確かめる。
#
# 将軍へ合図が届いておらなんだ穴（2026-08-29）は、二つの理由で試験を素通りした。
#
#   一、`test/nudge.test.ts` は pane の一覧を**手で注入**する。本物の
#       `panes()` を通らぬゆえ、tmux の絞り込みは一度も試されておらなんだ。
#   二、`scripts/testenv.sh` は将軍を**働き手と同じ陣**へ置く。本番は
#       二つの陣に分かれておるゆえ、その差の中にある穴は再現されぬ。
#
# **試験環境が本番と形が違えば、その差の中にある穴は永遠に見えぬ。**
# ここでは本番と同じ二陣構成を本物の tmux で作り、射程を測る。
#
# 陣は自ら畳む。各ペインに有限の命（sleep）を持たせてあるゆえ、命が尽きれば
# 窓が閉じ、陣が消え、server も落ちる——D006 により畳む手を持たぬゆえ、
# **畳まずに済む形**で作る。

load helpers

SOCK=hondenpanes
LIVE=25          # 陣の寿命（秒）。測り終える前に消えては困る

# 陣は**一度だけ**立て、全ての試験で分かち合う。試験ごとに立て直すと
# 前の陣がまだ生きており「同じ名の陣がある」で落ちる（実測）。
setup_file() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  export ROOT
  raise
}

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
}

# 本番と同じ形の陣を、使い捨ての socket に立てる。
# agents 陣に働き手、shogun 陣に将軍——これが本番の形である。
raise() {
  tmux -L "$SOCK" new-session -d -s agents -n agents "sleep $LIVE"
  tmux -L "$SOCK" set-option -p -t agents:agents @agent_id karo
  tmux -L "$SOCK" split-window -t agents:agents "sleep $LIVE"
  tmux -L "$SOCK" set-option -p -t agents:agents.1 @agent_id ashigaru1
  tmux -L "$SOCK" new-session -d -s shogun -n main "sleep $LIVE"
  tmux -L "$SOCK" set-option -p -t shogun:main @agent_id shogun
}

# その射程で誰が見えるか。honden 本体と同じ引き方をする。
seen() {
  local scope="$1" out=""
  for t in ${scope//,/ }; do
    out+=$(tmux -L "$SOCK" list-panes -s -t "$t" -F '#{@agent_id}' 2>/dev/null)
    out+=$'\n'
  done
  echo "$out" | grep -v '^$' | sort | tr '\n' ' '
}

@test "働き手の陣だけを射程にすると、将軍が落ちる（穴の再現）" {
  run seen agents
  assert_success
  assert_output --partial "ashigaru1"
  assert_output --partial "karo"
  # **これが穴であった。** 直訴も夜間の escalation も将軍宛ゆえ、届かなんだ。
  refute_output --partial "shogun"
}

@test "両方の陣を射程にすると、将軍まで届く" {
  run seen "agents,shogun"
  assert_success
  assert_output --partial "shogun"
  assert_output --partial "karo"
  assert_output --partial "ashigaru1"
}

@test "射程は効いておる（よその陣の者を拾わぬ）" {
  # 将軍の陣だけを見れば、働き手は見えぬ。絞りが働いておる証。
  run seen shogun
  assert_output --partial "shogun"
  refute_output --partial "ashigaru1"
}

@test "出陣は両方の陣を芯へ渡す" {
  # 上の測定が示した通り、片方だけでは将軍が落ちる。
  run grep -c "HONDEN_TMUX_SESSION='\$SESSION_AGENTS,\$SESSION_SHOGUN'" "$ROOT/scripts/shutsujin.sh"
  assert_output "1"
}

@test "試験の陣は本番と同じ二陣構成になっておる" {
  # 形が違えば、その差の中にある穴は見えぬ。将軍は別の陣に住むこと。
  run grep -c 'SESSION_SHOGUN=' "$ROOT/scripts/testenv.sh"
  assert_success
  refute_output "0"
  # 将軍が働き手の一覧に混ざっておらぬこと
  run bash -c "grep -E '^AGENTS=' '$ROOT/scripts/testenv.sh'"
  refute_output --partial "shogun"
  # 芯の射程が両陣であること
  run bash -c "grep -q 'HONDEN_TMUX_SESSION=.\$SESSION,\$SESSION_SHOGUN' '$ROOT/scripts/testenv.sh' && echo ok"
  assert_output "ok"
}

@test "本体も系譜を名乗りの根にしておる（環境変数では騙れぬ）" {
  # 殿の裁可（2026-08-29・Issue #7）。配線を外せば環境変数で役職を騙れる。
  run bash -c "grep -q 'anchor: () => anchorFrom(realProbe())' '$ROOT/src/main.ts' && echo ok"
  assert_output "ok"
}

@test "芯が拾う道に報せが乗っておる（誰も notify を叩かずに鳴る）" {
  # 建てただけで鳴らねば、層は飾りである。本番で一度も鳴っておらなんだ
  # （実測 2026-08-30）ゆえ、合図の道へ乗せた（殿の裁可・「い」の道）。
  run bash -c "grep -q 'notifyAfterNudge(dbPath)' '$ROOT/src/main.ts' && echo ok"
  assert_output "ok"
}

@test "報せの躓きで合図を止めぬ（合図が本務ゆえ）" {
  # notifyAfterNudge は掴んで黙る。掴まねば、通知の道具が無い機で
  # **配下が起こされなくなる**。
  run bash -c "grep -A2 'catch {' '$ROOT/src/main.ts' | grep -c '報せは本務ではない'"
  refute_output "0"
}

@test "素振りでは撃たぬ" {
  run bash -c "grep -q 'if (!dryRun) notifyAfterNudge' '$ROOT/src/main.ts' && echo ok"
  assert_output "ok"
}
