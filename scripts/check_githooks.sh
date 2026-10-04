#!/usr/bin/env bash
# setup_githooks.sh が据えた hook が、**どの worktree でも実在する先を指しておるか**を検める。
# 木ごとに ok / NG を並べ、NG が一つでもあれば非ゼロで返す。
#
# 判定は出所ではなく、指す先に commit-msg が実在すること。出所の表示（config.worktree など）は、
# 指す先が消えておっても同じに見える。git は、指す先が消えても警めを出さぬ——hook が黙って落ちる。
#   ok  <木> → <指す先>
#   NG  <木> → <指す先>（commit-msg が無い。hook が走らぬ）
#   NG  <木>（git が読めぬ。…）          木が動かされた・消えた等
#   --  <木>（hooksPath を据えておらぬ木。…）   検めの外（NG に数えぬ）
#
# 据えておらぬ木（core.hooksPath を local にも worktree にも持たぬ）は、global の hook が走る。
# setup を走らせた木だけが据え付けの対象ゆえ、NG に数えぬ（数えると、据えておらぬ木が一つ在るだけで
# setup が常に非ゼロで終わる）。全部を NG の対象にしたければ --all を付ける。
#
# 使い方: bash scripts/check_githooks.sh [--all]

set -uo pipefail
ALL=0
[[ "${1:-}" == "--all" ]] && ALL=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ng=0
n=0
while IFS= read -r w; do
  [[ -n "$w" ]] || continue
  n=$((n + 1))

  # 作られて消された木（git worktree prune で消える物）は、誰も commit せぬゆえ検めの外
  if [[ ! -e "$w" ]]; then
    echo "--  $w（木が無い。git worktree prune で消える）"
    continue
  fi
  if ! git -C "$w" rev-parse --git-common-dir >/dev/null 2>&1; then
    echo "NG  $w（git が読めぬ。木か repo の在処が動かされたか、消えた）"
    ng=$((ng + 1))
    continue
  fi

  set_value="$(git -C "$w" config --worktree --get core.hooksPath 2>/dev/null || git -C "$w" config --local --get core.hooksPath 2>/dev/null || true)"
  if [[ -z "$set_value" && "$ALL" -eq 0 ]]; then
    echo "--  $w（hooksPath を据えておらぬ木。global の hook が走る。--all で NG の対象にできる）"
    continue
  fi

  p="$(git -C "$w" rev-parse --git-path hooks 2>/dev/null || true)"
  [[ -n "$p" ]] || { echo "NG  $w（hook の路を引けぬ）"; ng=$((ng + 1)); continue; }
  case "$p" in /*) ;; *) p="$w/$p" ;; esac
  if [[ -f "$p/commit-msg" ]]; then
    echo "ok  $w → $p"
  else
    echo "NG  $w → $p（commit-msg が無い。hook が走らぬ）"
    ng=$((ng + 1))
  fi
done < <(git worktree list --porcelain | sed -n 's/^worktree //p')

if [[ "$n" -eq 0 ]]; then
  echo "NG  木が一つも引けぬ（git worktree list が空）"
  exit 1
fi
if [[ "$ng" -gt 0 ]]; then
  echo "NG が ${ng} 本。指す先が消えた木では、strip も門も global の Assisted-by も黙って落ちる。" >&2
  echo "  本の木の .githooks が在る枝へ戻すか、repo を元の在処へ戻すか、setup_githooks.sh を据え直せ。" >&2
  exit 1
fi
exit 0
