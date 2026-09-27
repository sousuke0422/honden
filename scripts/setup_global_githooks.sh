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
  --uninstall  退避（*.bak.<刻>）から戻す。退避が無く当方の配り物なら消す
  --help       この文

配る物:
  $DST_HOOK
  $DST_LIB

書き換える前に必ず \$file.bak.<刻> へ退避する。--uninstall が効かぬ形で
壊れても、退避から手で戻せる。core.hooksPath が未設定なら $HOOKS_DIR に
据える。別の値が既に据わっておるなら触らず報せるだけである。
EOF
}

# 一枚の配り予定を述べる。出力: new / differs / up-to-date
plan_of() {
  src="$1" dst="$2"
  if [ ! -e "$dst" ]; then
    echo "new"
  elif ! cmp -s "$src" "$dst"; then
    echo "differs"
  else
    echo "up-to-date"
  fi
}

show_plan() {
  hook_plan=$(plan_of "$SRC_HOOK" "$DST_HOOK")
  lib_plan=$(plan_of "$SRC_LIB" "$DST_LIB")
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
}

deploy_one() {
  src="$1" dst="$2" mode="$3"
  case "$(plan_of "$src" "$dst")" in
    up-to-date)
      echo "  $dst: 既に入っておる"
      ;;
    new)
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      chmod "$mode" "$dst"
      echo "  $dst: 配った（新規）"
      ;;
    differs)
      bak="$dst.bak.$(date +%Y%m%d%H%M%S)"
      cp "$dst" "$bak"
      cp "$src" "$dst"
      chmod "$mode" "$dst"
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

# 一枚を戻す。最新の退避が在ればそれを戻し、無ければ当方の配り物（正本と
# 同一の物）だけ消す。見知らぬ中身は消さず残して報せる。
restore_one() {
  src="$1" dst="$2"
  latest_bak=$(ls -1 "$dst".bak.* 2>/dev/null | sort | tail -1 || true)
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
  echo "  core.hooksPath は触らぬ（据えたのが当方か判じられぬ）。外すなら:"
  echo "    git config --global --unset core.hooksPath"
}

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
