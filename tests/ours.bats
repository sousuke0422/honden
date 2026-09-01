#!/usr/bin/env bats
# 「我らの陣か」の判じを、**本物の tmux** で検める。
#
# 贋の tmux では釣れなんだ穴がある——`show-options -t "=名"` は 3.7b で黙って
# 空を返し、立てた直後の己の陣を「我らの物ではない」と言うた（2026-09-02）。
# 贋物は書き手の思い込みをそのまま答える。判じの芯は本物で踏む。
#
# 出陣の書は `tmux` を裸で呼ぶゆえ、道の先頭に `-L` を差し込む包みを置き、
# 使い捨ての socket へ向ける。

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  command -v tmux >/dev/null || skip "tmux が無い"
  SOCK="hondenours-${BATS_RUN_TMPDIR##*/}-$$"
  WRAP="$BATS_TEST_TMPDIR/wrap"; mkdir -p "$WRAP"
  printf '#!/usr/bin/env bash\nexec /usr/bin/tmux -L "%s" "$@"\n' "$SOCK" > "$WRAP/tmux"
  chmod +x "$WRAP/tmux"
  export PATH="$WRAP:$PATH"
  export HONDEN_DB="$BATS_TEST_TMPDIR/h.db"
  # 名の前方一致を釣るため、既定の二つに加えて似た名の陣も立てる
  tmux new-session -d -s honden -n main "sleep 30"
  tmux new-session -d -s honden-agents -n agents "sleep 30"
  tmux new-session -d -s honden-agents-2 -n agents "sleep 30"
}

teardown() {
  /usr/bin/tmux -L "$SOCK" kill-server 2>/dev/null || true
}

alive() { /usr/bin/tmux -L "$SOCK" has-session -t "=$1" 2>/dev/null; }

@test "己の置き場を指す印の陣だけを畳む。似た名・印無しは残す" {
  tmux set-option -t honden        @honden "$ROOT"
  tmux set-option -t honden-agents @honden "$ROOT"
  # honden-agents-2 には印を付けぬ
  run bash "$ROOT/shutsujin_departure.sh" down
  [ "$status" -eq 0 ]
  [[ "$output" == *"honden-agents を畳んだ"* ]]
  [[ "$output" == *"honden を畳んだ"* ]]
  ! alive honden
  ! alive honden-agents
  alive honden-agents-2
}

@test "**陰性対照** — 印が別の置き場を指せば、名が同じでも畳まぬ" {
  tmux set-option -t honden        @honden "/elsewhere"
  tmux set-option -t honden-agents @honden "/elsewhere"
  run bash "$ROOT/shutsujin_departure.sh" down
  [[ "$output" == *"我らの陣ではない"* ]]
  alive honden
  alive honden-agents
}

@test "印が無ければ畳まぬ（立てた直後に印を読めぬ穴は、ここで鳴る）" {
  run bash "$ROOT/shutsujin_departure.sh" down
  alive honden
  alive honden-agents
}
