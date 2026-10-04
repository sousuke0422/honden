#!/usr/bin/env bash
# この repo の git hooks（.githooks）を、**この script を走らせた worktree にだけ**据える。
# global の ~/.git-hooks（Assisted-by）は prepare-commit-msg から明示的に呼ぶ。
#
# 作用域は worktree である。`git config core.hooksPath` は共有の .git/config へ書かれ、
# 全 worktree に効いてしまう（.githooks を持たぬ木では global の hook が黙って外れる）。
# ゆえに `extensions.worktreeConfig` を立てた上で `git config --worktree` で書く。
#
# extensions.worktreeConfig の副作用: これは共有の .git/config に書かれ、全 worktree に及ぶ。
# git-worktree の文書は「この拡張を知らぬ古い git は、この repo へ触るのを拒む」と書く
# （"Older Git versions will refuse to access repositories with this extension"）。
# 拡張を解する版は、`git config --worktree` が入った git 2.20（2018-12）以降と覚えておる
# （文書に版の明記は無く、この版数は未確認）。実測（git 2.54）では
# core.repositoryformatversion は 0 のままで、拡張の行だけが足される。
# 古い git や、その git を内に持つ道具が同じ repo を開くなら、先にそちらを確かめること。
# 立てたくなければ、この script を使わず、commit のたびに
# `git -c core.hooksPath=.githooks commit` と明示する。

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
SHARED="$COMMON/config"

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

chmod +x .githooks/prepare-commit-msg .githooks/commit-msg .githooks/lib/strip-cursor-trailers.sh 2>/dev/null || true

# --worktree は、拡張が立っておらぬと --local と同じ（共有へ書く）になる。先に立てる。
git config extensions.worktreeConfig true
git config --worktree core.hooksPath .githooks

echo "  core.hooksPath → .githooks（この worktree だけ: $(git rev-parse --git-path config.worktree)）"
echo "  確かめ: 別の worktree で  git config --show-origin core.hooksPath  （.githooks が出ぬこと）"
