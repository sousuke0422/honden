#!/usr/bin/env bash
# この repo の git hooks（.githooks）を据える。**据える先は、この script を走らせた worktree だけ**
# （git config の --worktree 作用域）。**指す先は、どの木で走らせても本の木（primary worktree）の
# .githooks の絶対路**である。
# global の ~/.git-hooks（Assisted-by）は prepare-commit-msg から明示的に呼ぶ。
#
# 作用域は worktree である。`git config core.hooksPath` は共有の .git/config へ書かれ、
# 全 worktree に効いてしまう（.githooks を持たぬ木では global の hook が黙って外れる）。
# ゆえに `extensions.worktreeConfig` を立てた上で `git config --worktree` で書く。
#
# 路を絶対路の本の木に決めた理由（相対の `.githooks` にせぬ理由）:
#   `git worktree add` は、作る木へ作った側の config.worktree を**そのまま写す**。相対の
#   `.githooks` を据えておくと、setup の後に作った木では、その木の `.githooks` を探しに行く。
#   .githooks の無い枝の木（#34 を含まぬ枝）では hook が見つからず、strip も門も global の
#   Assisted-by も、警め無しに全部外れる。路を絶対路にすれば、写されても同じ先を指す。
#   指す先に、据えた木の路を選ばぬのは、この repo が `.worktrees/` を作っては消すため
#   （消せば宙に浮く）。hook を git-common-dir へ写す形も選ばぬ——写しと源の二つを追うことになり、
#   hook を直すたびに据え直しが要る。本の木は消さぬゆえ、指す先として最も長く生きる。
#   本の木に .githooks が無い（本の木が #34 を含まぬ枝に居る等）時は、何も書かずに止まる。
#
#   **残る窓（据えた後に、指す先が消える）**: (1) 本の木が .githooks を持たぬ枝へ移る、
#   (2) repo の在処を動かす（mv 等）、(3) 本の木を動かすか消す。どれも git は警めを出さず、
#   **どの木でも strip・門・global の Assisted-by が黙って落ちる**。据える前は global の hook が
#   効いておったゆえ、この窓では、動いておった物が止まる。窓は塞げぬ（本の木に頼る形の代価）ゆえ、
#   機械で検める: `bash scripts/check_githooks.sh`（木ごとに ok / NG。NG があれば非ゼロ）。
#   この script も据えた後に自ら呼ぶ。窓が開いた後は、本の木を .githooks の在る枝へ戻すか、
#   repo を元の在処へ戻すか、この script を据え直す。
#
# extensions.worktreeConfig の副作用: これは共有の .git/config に書かれ、全 worktree に及ぶ。
# git-worktree の文書は「この拡張を知らぬ古い git は、この repo へ触るのを拒む」と書く
# （"Older Git versions will refuse to access repositories with this extension"）。
# 拡張を解する版は、`git config --worktree` が入った git 2.20（2018-12）以降と覚えておる
# （文書に版の明記は無く、この版数は未確認）。実測（git 2.54）では
# core.repositoryformatversion は 0 のままで、拡張の行だけが足される。
# 古い git や、その git を内に持つ道具が同じ repo を開くなら、先にそちらを確かめること。
# 立てたくなければ、この script を使わず、commit のたびに
# `git -c core.hooksPath=<本の木>/.githooks commit` と明示する。

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
SHARED="$COMMON/config"
PRIMARY="$(dirname "$COMMON")"
HOOKS="$PRIMARY/.githooks"

# 共有の config に core.worktree / core.bare=true が在ると、拡張を立てた時に
# 意味が変わる（main worktree だけの例外が消える）。人が移すまで進まぬ。
if git config --file "$SHARED" --get core.worktree >/dev/null 2>&1 \
  || [[ "$(git config --file "$SHARED" --type=bool --get core.bare 2>/dev/null || true)" == "true" ]]; then
  {
    echo "  共有の $SHARED に core.worktree か core.bare=true が在る。"
    echo "  extensions.worktreeConfig を立てると、これらの意味が変わる（git-worktree の CONFIGURATION FILE）。"
    echo "  main worktree の config.worktree へ移してから、もう一度走らせよ。何も書き換えておらぬ。"
  } >&2
  exit 1
fi

# 指す先は本の木の .githooks。無ければ、指しても hook は走らぬ（警め無しに外れる形）ゆえ止まる。
if [[ ! -f "$HOOKS/prepare-commit-msg" || ! -f "$HOOKS/commit-msg" ]]; then
  {
    echo "  本の木（$PRIMARY）に .githooks（prepare-commit-msg と commit-msg）が無い。"
    echo "  本の木が、これらを含まぬ枝に居る（#34 を含まぬ枝など）かもしれぬ。"
    echo "  指す先が無いまま据えると、どの木でも hook が警め無しに外れる。何も書き換えておらぬ。"
    echo "  本の木で .githooks を持つ枝へ移ってから、もう一度走らせよ。"
  } >&2
  exit 1
fi

# 共有に core.hooksPath が既に在るなら、黙って上書きも削除もせず、在ることだけ示す。
# 外すかは人が決める。
if shared_value="$(git config --file "$SHARED" --get core.hooksPath 2>/dev/null)"; then
  {
    echo "  注意: 共有の $SHARED に core.hooksPath = $shared_value が既に在る。"
    echo "        これは **全 worktree に効いておる**（--worktree で上書きしておらぬ木すべて）。"
    echo "        この script は触らぬ。外すなら、人が決めて:"
    echo "          git config --local --unset core.hooksPath"
  } >&2
fi

# 入口の二本だけ。指標の mode（755）が効かぬ clone（core.filemode=false や実行権の落ちた展開）の保険。
# lib/strip-cursor-trailers.sh は prepare-commit-msg が `.` で読むだけで実行権は要らぬ（指標の mode は 644 が正しい）。
# lib まで chmod すると、core.filemode=true の clone で ` M`（mode の差）が出る。
chmod +x "$HOOKS/prepare-commit-msg" "$HOOKS/commit-msg" 2>/dev/null || true

# --worktree は、拡張が立っておらぬと --local と同じ（共有へ書く）になる。先に立てる。
# 立てた後に --worktree が落ちたら、立てる前に拡張が無かった時に限り外して戻す
# （立てる前から在った物は、人が立てた物ゆえ消さぬ）。
had_ext_set=0
had_ext_value=""
if had_ext_value="$(git config --file "$SHARED" --get extensions.worktreeConfig 2>/dev/null)"; then
  had_ext_set=1
fi

# 戻しは repo の外から打つ。config.worktree が読めぬ形で落ちた時、repo の中の git は
# `--file` を付けても repo の config を読んで死に、戻せぬのに「戻した」と言いかねぬ。
# 戻せたかは読み返して確かめ、確かめられた時だけ「戻した」と言う。
outside() { git -C / "$@"; }

git config extensions.worktreeConfig true
if ! git config --worktree core.hooksPath "$HOOKS"; then
  {
    echo "  git config --worktree core.hooksPath が落ちた（$(git --version)）。"
    if [[ "$had_ext_set" -eq 0 ]]; then
      outside config --file "$SHARED" --unset extensions.worktreeConfig 2>/dev/null || true
      if outside config --file "$SHARED" --get extensions.worktreeConfig >/dev/null 2>&1; then
        echo "  先に立てた extensions.worktreeConfig を外せなんだ。手で外せ:"
        echo "    git config --file '$SHARED' --unset extensions.worktreeConfig"
      else
        echo "  先に立てた extensions.worktreeConfig を外して、repo を元に戻した。"
      fi
    else
      outside config --file "$SHARED" extensions.worktreeConfig "$had_ext_value" 2>/dev/null || true
      now_value="$(outside config --file "$SHARED" --get extensions.worktreeConfig 2>/dev/null || true)"
      if [[ "$now_value" == "$had_ext_value" ]]; then
        echo "  extensions.worktreeConfig は据え付けの前から在った（値: $had_ext_value）ゆえ、外さず、読み返して前の値のままと確かめた。"
      else
        echo "  extensions.worktreeConfig を前の値（$had_ext_value）へ戻せなんだ。今の値: ${now_value:-（無い）}。手で戻せ:"
        echo "    git config --file '$SHARED' extensions.worktreeConfig '$had_ext_value'"
      fi
    fi
    echo "  core.hooksPath は書いておらぬ。--worktree を解さぬ git かもしれぬ（上の版を見よ）。"
  } >&2
  exit 1
fi

echo "  core.hooksPath → $HOOKS（この worktree だけ: $(git rev-parse --git-path config.worktree)）"

# 据えた後に、どの木でも指す先が実在するかを自ら検める。NG があれば非ゼロで終える。
echo "  検め（scripts/check_githooks.sh）:"
if ! bash "$ROOT/scripts/check_githooks.sh" | sed 's/^/    /'; then
  echo "  据えたが、検めに NG が在る。上の NG の木を直してから、もう一度 bash scripts/check_githooks.sh を打て。" >&2
  exit 1
fi
