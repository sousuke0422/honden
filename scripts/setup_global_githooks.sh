#!/usr/bin/env bash
# global の git hooks（~/.git-hooks）を honden の repo から配る。
#
# 正本は repo の二枚:
#   .githooks/global/prepare-commit-msg      （Assisted-by を揃え、Cursor の共著を落とす）
#   .githooks/lib/strip-cursor-trailers.sh   （strip の正本。global 用の二枚目は持たぬ）
#
# 配り先が古くなる恐れへの備え: 打つたびに正本から配り直す。
# --dry-run が「differs（配り直しが要る）」を報せる。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="${HONDEN_GLOBAL_HOOKS_DIR:-$HOME/.git-hooks}"

SRC_HOOK="$ROOT/.githooks/global/prepare-commit-msg"
SRC_LIB="$ROOT/.githooks/lib/strip-cursor-trailers.sh"
DST_HOOK="$HOOKS_DIR/prepare-commit-msg"
DST_LIB="$HOOKS_DIR/lib/strip-cursor-trailers.sh"

usage() {
  cat <<EOF
使い方: scripts/setup_global_githooks.sh [--dry-run | --uninstall | --help]

global の git hooks を $HOOKS_DIR へ配る。

  （旗なし）   何をどう書き換えるかを出し、打つか尋ねてから配る
  --dry-run    出すだけ。一切触らぬ
  --uninstall  一層だけ戻す: 最新の退避（*.bak.<刻>[.<連番>]）から戻し、その退避を消す。
               配り直すたびに退避が一層積まれるゆえ、層が残っておれば
               元へ着くまで --uninstall を繰り返し打つ（残っておれば打った後に告げる）。
               退避が無く当方の配り物（正本と同じ中身）なら消す
  --help       この文

配る物:
  $DST_HOOK
  $DST_LIB

書き換える前に必ず \$file.bak.<刻> へ退避する（同じ刻の退避が既に在れば
\$file.bak.<刻>.1・.2 … と空いた名へ送る）。--uninstall が効かぬ形で
壊れても、退避から手で戻せる。core.hooksPath が未設定なら $HOOKS_DIR に
据える。別の値が既に据わっておるなら触らず報せるだけである。

旗は一つまで。二つ以上は何もせずに断る（--uninstall --dry-run が書き換えぬように）。

終了コード:
  0  済んだ（--dry-run・--help・尋ねて止めた時も 0）
  1  配れなんだ（端末でない・chmod の後も hook が実行できぬ 等）
  2  引数を受け付けぬ（知らぬ旗・二つ以上の旗）
EOF
}

# 一枚の配り予定を述べる。出力: new / differs / not-exec / up-to-date
# not-exec: 中身は同じだが、実行権が要る物（mode 755）に実行権が無い。git は実行権の無い
# hook を黙って飛ばすゆえ、これを up-to-date と言えば、死んだ hook を「入っておる」と言うことになる。
plan_of() {
  src="$1" dst="$2" mode="$3"
  if [ ! -e "$dst" ]; then
    echo "new"
  elif ! cmp -s "$src" "$dst"; then
    echo "differs"
  elif [ "$mode" = 755 ] && [ ! -x "$dst" ]; then
    echo "not-exec"
  else
    echo "up-to-date"
  fi
}

# 退避の名を選ぶ。同じ秒に二度退避すると前の退避を上書きして潰すゆえ、
# 名が既に在れば .1・.2 … と空いた名まで送る。
backup_name() {
  dst="$1"
  base="$dst.bak.$(date +%Y%m%d%H%M%S)"
  bak="$base"
  n=0
  while [ -e "$bak" ]; do
    n=$((n + 1))
    bak="$base.$n"
  done
  echo "$bak"
}

# mode を当て、実行権の要る物は当たったかを確かめる。咎めるのは chmod の失敗そのもの
# ではなく、その後の -x である（scripts/setup_githooks.sh と同じ判じ）。
apply_mode() {
  dst="$1" mode="$2"
  chmod "$mode" "$dst" 2>/dev/null || true
  if [ "$mode" = 755 ] && [ ! -x "$dst" ]; then
    echo "  $dst: chmod の後も実行できぬ。git は実行権の無い hook を黙って飛ばす——止める。" >&2
    exit 1
  fi
}

show_plan() {
  hook_plan=$(plan_of "$SRC_HOOK" "$DST_HOOK" 755)
  lib_plan=$(plan_of "$SRC_LIB" "$DST_LIB" 644)
  echo "配り先: $HOOKS_DIR"
  echo "  $DST_HOOK: $hook_plan"
  echo "  $DST_LIB: $lib_plan"
  current_path=$(git config --global core.hooksPath || true)
  if [ -z "$current_path" ]; then
    echo "  core.hooksPath: 未設定 → $HOOKS_DIR に据える"
  elif [ "$current_path" = "$HOOKS_DIR" ]; then
    echo "  core.hooksPath: $current_path（そのまま）"
  else
    echo "  core.hooksPath: $current_path（$HOOKS_DIR と違う。触らぬ——手で確かめられよ）"
  fi
  echo "  differs の物は \$file.bak.<刻> へ退避してから上書きする"
  echo "  not-exec の物は中身を変えず、実行権だけ直す"
}

deploy_one() {
  src="$1" dst="$2" mode="$3"
  case "$(plan_of "$src" "$dst" "$mode")" in
    up-to-date)
      echo "  $dst: 既に入っておる"
      ;;
    not-exec)
      apply_mode "$dst" "$mode"
      echo "  $dst: 中身は同じで実行権が無かった。権を直した"
      ;;
    new)
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      apply_mode "$dst" "$mode"
      echo "  $dst: 配った（新規）"
      ;;
    differs)
      bak=$(backup_name "$dst")
      cp "$dst" "$bak"
      cp "$src" "$dst"
      apply_mode "$dst" "$mode"
      echo "  $dst: 退避（$bak）して配り直した"
      ;;
  esac
}

install() {
  deploy_one "$SRC_HOOK" "$DST_HOOK" 755
  deploy_one "$SRC_LIB" "$DST_LIB" 644
  current_path=$(git config --global core.hooksPath || true)
  if [ -z "$current_path" ]; then
    git config --global core.hooksPath "$HOOKS_DIR"
    echo "  core.hooksPath → $HOOKS_DIR"
  elif [ "$current_path" != "$HOOKS_DIR" ]; then
    echo "  core.hooksPath は $current_path のまま（触っておらぬ）"
  fi
}

# 最新の退避を選ぶ。名は $dst.bak.<刻> か $dst.bak.<刻>.<連番>（backup_name）。
# 字の並び（sort）では .10 が .2 より前に来るゆえ、刻と連番を数で比べる。
# 連番の無い名は連番 0 と見る。この形でない名（手で置いた物）は選ばぬ。
latest_backup() {
  dst="$1"
  best="" best_t="" best_n=-1
  for b in "$dst".bak.*; do
    [ -e "$b" ] || continue
    rest=${b#"$dst".bak.}
    t=${rest%%.*}
    case "$rest" in
      *.*) n=${rest#*.} ;;
      *) n=0 ;;
    esac
    case "$t" in '' | *[!0-9]*) continue ;; esac
    case "$n" in '' | *[!0-9]*) continue ;; esac
    if [ -z "$best" ] || [ "$t" -gt "$best_t" ] || { [ "$t" -eq "$best_t" ] && [ "$n" -gt "$best_n" ]; }; then
      best=$b best_t=$t best_n=$n
    fi
  done
  echo "$best"
}

# 一枚を戻す。最新の退避が在ればそれを戻し、無ければ当方の配り物（正本と
# 同一の物）だけ消す。見知らぬ中身は消さず残して報せる。
restore_one() {
  src="$1" dst="$2"
  latest_bak=$(latest_backup "$dst")
  if [ -n "$latest_bak" ]; then
    cp "$latest_bak" "$dst"
    rm -f "$latest_bak"
    echo "  $dst: 退避（$latest_bak）から戻した"
  elif [ -e "$dst" ] && cmp -s "$src" "$dst"; then
    rm -f "$dst"
    echo "  $dst: 退避が無く当方の配り物ゆえ消した"
  elif [ -e "$dst" ]; then
    echo "  $dst: 退避が無く中身も当方の物でない。消さず残す——手で確かめられよ"
  else
    echo "  $dst: 元より無い"
  fi
}

uninstall() {
  restore_one "$SRC_HOOK" "$DST_HOOK"
  restore_one "$SRC_LIB" "$DST_LIB"
  rmdir "$HOOKS_DIR/lib" 2>/dev/null || true
  # 一度に戻すのは一層だけ。層が残っておれば、元へ着いたと思わせぬよう告げる。
  for d in "$DST_HOOK" "$DST_LIB"; do
    next_bak=$(latest_backup "$d")
    if [ -n "$next_bak" ]; then
      echo "  $d: 退避がまだ残っておる（次は $next_bak）。元へ着くまで --uninstall を繰り返し打て"
    fi
  done
  echo "  core.hooksPath は触らぬ（据えたのが当方か判じられぬ）。外すなら:"
  echo "    git config --global --unset core.hooksPath"
}

# 旗は一つまで。--uninstall --dry-run のような組を一つ目だけで動かすと、
# 「見るだけ」のつもりで書き換える。何もせずに断る。
if [ "$#" -gt 1 ]; then
  echo "引数は一つまでである（受けたのは $# 個: $*）。何も触っておらぬ。" >&2
  usage >&2
  exit 2
fi

case "${1:-}" in
  --help)
    usage
    ;;
  --dry-run)
    show_plan
    echo "（--dry-run ゆえ一切触っておらぬ）"
    ;;
  --uninstall)
    uninstall
    ;;
  '')
    show_plan
    if [ "${HONDEN_SETUP_ASSUME_YES:-}" = "1" ]; then
      # 試験と自動化のための言質。人が打つ時は使わぬ。
      install
      exit 0
    fi
    if [ ! -t 0 ]; then
      echo "端末でない。--dry-run で見るか、端末から打たれよ。" >&2
      exit 1
    fi
    printf '打つか? [y/N] '
    read -r answer
    case "$answer" in
      y | Y) install ;;
      *) echo "止めた。何も触っておらぬ。" ;;
    esac
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
