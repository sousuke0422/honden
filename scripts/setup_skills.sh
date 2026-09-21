#!/usr/bin/env bash
# 棚の skill を Claude Code または Codex が拾う段へ繋ぐ。
#
# **既定の繋ぎ先は honden 自身**である。陣の session はみな honden の根を
# cwd に起きるゆえ、task や vrt など案件側の repo に置いても誰の目にも
# 入らぬ（殿の指摘・2026-09-05）。棚（skills/）はただの置き場で、
# .claude/skills/ に在って初めて Claude Code が拾う。
#
# 写しではなく symlink で繋ぐ——棚を直せば即座に効き、二重管理を作らぬ。
#
#   bash scripts/setup_skills.sh --all                      # 棚の全部を honden へ
#   bash scripts/setup_skills.sh honden-coder skill-creator # 選んで honden へ
#   bash scripts/setup_skills.sh --unlink honden-coder      # 外す
#   bash scripts/setup_skills.sh --project <道> --all       # その repo で直に
#                                                           # claude を開く時だけ意味を持つ
#
# bash scripts/setup_skills.sh --codex --all              # Codex の各人段へ
# bash scripts/setup_skills.sh --codex --unlink honden-coder
#
# 繋ぎ先に**実体（link でない物）が居れば触らぬ**。己の版を持っておるのを、
# 仕度が黙って壊してはならぬ。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELF="$ROOT/skills"

c()   { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info(){ echo "  $(c '0;36' '│') $*"; }
ok()  { echo "  $(c '1;32' '✓') $*"; }
warn(){ echo "  $(c '1;33' '▲') $*"; }
die() { echo "  $(c '1;31' '✗') $*" >&2; exit 1; }

PROJ="$ROOT"
PROJECT_SET=0
if [ "${1:-}" = "--project" ]; then
  [ -n "${2:-}" ] || die "--project の後に道を"
  [ -d "$2" ] || die "$2 は dir でない"
  PROJ="$(cd "$2" && pwd)"
  PROJECT_SET=1
  shift 2
fi

# 棚の一覧。近道（symlink）は実体へ解いてから繋ぐ——link の link は
# 棚を動かした時に黙って切れる。vendor の中身も名で選べるようにする。
shelf_skills() {
  local d name
  for d in "$SHELF"/*/ "$SHELF"/vendor/*/; do
    [ -f "$d/SKILL.md" ] || continue
    name=$(basename "$d")
    [ "$name" = vendor ] && continue
    echo "$name"
  done | sort -u
}

resolve() { # <名> → 実体の道（無ければ空）
  local n="$1"
  if [ -f "$SHELF/$n/SKILL.md" ]; then
    ( cd "$SHELF/$n" && pwd -P )
  elif [ -f "$SHELF/vendor/$n/SKILL.md" ]; then
    ( cd "$SHELF/vendor/$n" && pwd -P )
  fi
}

UNLINK=0; ALL=0; CODEX=0; PICK=()
for a in "$@"; do
  case "$a" in
    --all) ALL=1 ;;
    --unlink) UNLINK=1 ;;
    --codex) CODEX=1 ;;
    --*) die "知らぬ旗: $a（--all / --unlink / --codex）" ;;
    *) PICK+=("$a") ;;
  esac
done

if [ "$CODEX" = 1 ]; then
  [ "$PROJECT_SET" = 0 ] || die "--project は Claude Code の段を選ぶ旗。--codex とは併用できぬ"
  DEST="$HOME/.agents/skills"
else
  DEST="$PROJ/.claude/skills"
fi

if [ "$ALL" = 1 ]; then
  while read -r n; do PICK+=("$n"); done < <(shelf_skills)
fi

if [ ${#PICK[@]} -eq 0 ]; then
  info "棚に在る skill（名を並べるか --all で繋ぐ・繋ぎ先 $DEST）:"
  while read -r n; do
    if [ -L "$DEST/$n" ]; then echo "    ✓ $n（繋ぎ済み）"; else echo "      $n"; fi
  done < <(shelf_skills)
  exit 0
fi

mkdir -p "$DEST" || die "繋ぎ先を作れぬ: $DEST"
for n in "${PICK[@]}"; do
  src=$(resolve "$n" || true)
  [ -n "$src" ] || { warn "$n は棚に無い。飛ばす"; continue; }
  tgt="$DEST/$n"

  if [ -L "$tgt" ]; then
    cur=$(readlink -f "$tgt" 2>/dev/null || true)
    case "$cur" in
      "$SHELF"/*) ;;
      *) warn "$n は他所の link を指しておる。触らぬ"; continue ;;
    esac
  fi
  if [ "$UNLINK" = 1 ]; then
    if [ -L "$tgt" ]; then
      rm "$tgt" || die "$n を外せぬ: $tgt"
      ok "$n を外した"
    elif [ -e "$tgt" ]; then warn "$n は link でない（案件の実体）。触らぬ"
    else info "$n は繋がっておらぬ"; fi
    continue
  fi
  if [ -L "$tgt" ]; then
    if [ "$cur" = "$src" ]; then ok "$n は繋ぎ済み"; else
      replacement="$DEST/.${n}.honden.$$"
      ln -s "$src" "$replacement" || die "$n の仮 link を作れぬ: $replacement"
      if ! mv -Tf "$replacement" "$tgt"; then
        rm -f "$replacement"
        die "$n の link を置き換えられぬ: $tgt"
      fi
      ok "$n を繋ぎ直した（→ $src）"
    fi
  elif [ -e "$tgt" ]; then
    warn "$n: 案件が己の実体を持っておる。触らぬ（要るなら手で除いてから）"
  else
    ln -s "$src" "$tgt" || die "$n を繋げぬ: $tgt"
    ok "$n を繋いだ"
  fi
done
info "繋ぎ先: $DEST（machine-local・git には載らぬ）"
