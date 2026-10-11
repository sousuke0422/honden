#!/usr/bin/env bash
# 門の本体（src/guard.ts）への直しの patch を当て、試験し、commit して枝へ押す。
#
# **この script は殿が打つ物である。** 門の本体は settings の deny で足軽の手から書けぬ。
# 足軽は patch と試験の commit を作って止まり、将軍が patch と sha256 を検めて、引数を埋めた
# 一行を殿へ渡す。殿はそれを `! bash scripts/apply_guard_patch.sh …` で打つ。
#
# **門の本体のためだけの物である。** patch が src/guard.ts 以外の file を触れば、何もせずに
# 止まる。他に要る file（試験・作法）は、足軽が普通の commit で足す。
#
# 手順。どの段で止まっても、それより前の段の変更は残さぬ:
#   1. 検め: 旗・押す枝が既定の枝（main・master・遠方の既定）でないこと・
#      commit 文の trailer・patch の sha256・patch が触る file（git apply --numstat）・
#      手元の先端（--head）と枝・作業木が清いこと・遠方の先端（git fetch して FETCH_HEAD が
#      --remote）・手元が遠方の子であること。どれか違えば何も変えずに非ゼロで止まる
#   2. git apply --check の後に git apply
#   3. bunx tsc --noEmit と bun test。落ちれば当てた file を git checkout -- で戻し、戻したと
#      告げて止まる
#   4. patch が触った file だけを add して commit（文は --message-file）。add か commit が
#      落ちれば（pre-commit hook が拒む等）、index から降ろして作業木を戻し、止まる
#   5. trailer を git cat-file -p で確かめる（git interpret-trailers --parse で取り出し、
#      Assisted-by の一行と完全に一致すること。検め 1 の文の trailer も同じ判じ）。違えば commit を解いて当てた物を戻し、止まる
#   6. git push origin HEAD:<branch>。fast-forward のみで、force は決して使わぬ。拒まれれば
#      commit を解いて当てた物を戻し、遠方の今の先端を告げて止まる
#   7. 押した SHA を最後の行に出す
#
# 試験の差し替えの口: HONDEN_APPLY_GUARD_VERIFY に実行できる file の道を置くと、3 の段で
# tsc と bun test の代わりにそれを作業木で走らせる。script の試験（使い捨ての repo で撃つ）の
# ための口である。**殿が打つ時は置かぬ**——置かれておれば、その旨を必ず標準エラーへ出す。
set -euo pipefail

ASSISTED='Assisted-by: multi-agent-shogun-aki-tweak'
GUARD_FILE='src/guard.ts'

usage() {
  cat <<'EOF'
使い方:
  bash scripts/apply_guard_patch.sh \
    --worktree <作業木> --patch <patch の道> --sha256 <patch の sha256> \
    --head <手元の先端の SHA> --remote <遠方の先端の SHA> \
    --branch <押す枝> --message-file <commit 文の file>

  門の本体（src/guard.ts）への patch を当て、tsc と bun test を通し、commit して
  origin の <押す枝> へ fast-forward で押す。最後の行に押した SHA を出す。

  --worktree      当てる作業木。<押す枝> を checkout しておること
  --patch         当てる patch。src/guard.ts だけを触ること
  --sha256        patch の sha256（64 桁の 16 進）
  --head          手元の先端（40 桁の SHA）。作業木の HEAD と合わねば止まる
  --remote        遠方の先端（40 桁の SHA）。fetch した origin/<押す枝> と合わねば止まる
  --branch        押す枝の名（PR の枝。refs/heads/<名> でもよい）。既定の枝（main・master・
                  遠方の既定）は拒む——既定の枝へはレビューを通して入れる
  --message-file  commit 文。末尾が "Assisted-by: multi-agent-shogun-aki-tweak" であること。
                  Claude-Session か Co-authored-by の行が在れば止まる
  --help          この使い方を出す

  終わりの値: 0 押した / 1 検めか試験で止まった（何も残さぬ）/ 2 旗の誤り
EOF
}

die_usage() {
  echo "  [旗] $1" >&2
  usage >&2
  exit 2
}

stop() {
  echo "  [止まる] $1" >&2
  exit 1
}

declare -A opt=()
known=' worktree patch sha256 head remote branch message-file '
while (($# > 0)); do
  case "$1" in
    --help | -h)
      usage
      exit 0
      ;;
    --*=*)
      name="${1%%=*}"
      name="${name#--}"
      value="${1#*=}"
      shift
      ;;
    --*)
      name="${1#--}"
      if (($# < 2)); then die_usage "--$name に値が無い"; fi
      value="$2"
      shift 2
      ;;
    *)
      die_usage "余る引数: $1"
      ;;
  esac
  [[ "$known" == *" $name "* ]] || die_usage "知らぬ旗: --$name"
  [[ -z "${opt[$name]+x}" ]] || die_usage "--$name が二度ある"
  [[ -n "$value" ]] || die_usage "--$name の値が空"
  opt[$name]="$value"
done
for name in $known; do
  [[ -n "${opt[$name]+x}" ]] || die_usage "--$name が無い"
done

WT="${opt[worktree]}"
PATCH="${opt[patch]}"
SHA256="${opt[sha256]}"
HEAD_SHA="${opt[head]}"
REMOTE_SHA="${opt[remote]}"
BRANCH="${opt[branch]}"
MSG="${opt[message-file]}"

[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || die_usage "--sha256 は 64 桁の小文字の 16 進で"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || die_usage "--head は 40 桁の SHA で（短い SHA は取り違えを生む）"
[[ "$REMOTE_SHA" =~ ^[0-9a-f]{40}$ ]] || die_usage "--remote は 40 桁の SHA で"
[[ "$BRANCH" != -* ]] || die_usage "--branch が - で始まる"
# refs/heads/<名> の形でも渡せる。以後は名で扱う（既定の枝の判じも、押す先も）。
BRANCH="${BRANCH#refs/heads/}"
[[ -n "$BRANCH" ]] || die_usage "--branch の名が空"

g() { git -C "$WT" "$@"; }

# 文から trailer を取り出し（git interpret-trailers --parse）、Assisted-by の一行と
# 完全に一致するかを問う。一致せねば非ゼロで、余分な trailer の名だけを標準出力へ出す
# （値は出さぬ。名が無ければ「Assisted-by が無い」）。部分一致・前方一致・行の重複は通さぬ。
# 文は標準入力から読む。
trailer_extras() {
  local parsed line name matched=0
  parsed="$(g interpret-trailers --parse)"
  [[ "$parsed" != "$ASSISTED" ]] || return 0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if ((matched == 0)) && [[ "$line" == "$ASSISTED" ]]; then
      matched=1
      continue
    fi
    name="${line%%:*}"
    printf '%s\n' "$name"
  done <<<"$parsed"
  if ((matched == 0)); then echo "Assisted-by が無い、または値が違う"; fi
  return 1
}

# ---- 1. 検め（何も変えぬ） ----
[[ -d "$WT" ]] || stop "作業木が無い: $WT"
[[ "$(g rev-parse --is-inside-work-tree 2>/dev/null || true)" == "true" ]] || stop "git の作業木ではない: $WT"
# 既定の枝へは押さぬ。この script は PR の枝へ押す物で、既定の枝へ直に押せば門の直しが
# レビューを通らずに入る。既定は main・master と、遠方の既定（手元の origin/HEAD か、
# 遠方に問うた HEAD。どちらかで引ければその名）。引けぬ時は main と master だけで判ずる。
defaults=(main master)
local_default="$(g symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
[[ -z "$local_default" ]] || defaults+=("${local_default#origin/}")
remote_default="$(g ls-remote --symref origin HEAD 2>/dev/null | awk '$1 == "ref:" { sub("^refs/heads/", "", $2); print $2; exit }' || true)"
[[ -z "$remote_default" ]] || defaults+=("$remote_default")
for d in "${defaults[@]}"; do
  [[ "$BRANCH" != "$d" ]] || stop "--branch $BRANCH は既定の枝である。この script は PR の枝へ押す物で、既定の枝へはレビューを通して入れる"
done

[[ -f "$PATCH" ]] || stop "patch が無い: $PATCH"
PATCH="$(cd "$(dirname "$PATCH")" && pwd)/$(basename "$PATCH")"
[[ -f "$MSG" ]] || stop "commit 文の file が無い: $MSG"
MSG="$(cd "$(dirname "$MSG")" && pwd)/$(basename "$MSG")"

if grep -qiE '^(Claude-Session|Co-authored-by):' "$MSG"; then
  stop "commit 文に Claude-Session か Co-authored-by の行が在る。trailer は $ASSISTED の一行だけにせよ"
fi
last="$(grep -v '^[[:space:]]*$' "$MSG" | tail -n 1)"
[[ "$last" == "$ASSISTED" ]] || stop "commit 文の末尾が「$ASSISTED」ではない（末尾: ${last:-空}）"
if ! extras="$(trailer_extras <"$MSG")"; then
  stop "commit 文の trailer が「$ASSISTED」の一行だけでない（余分: $(tr '\n' ' ' <<<"$extras")）"
fi

actual="$(sha256sum "$PATCH" | cut -d' ' -f1)"
[[ "$actual" == "$SHA256" ]] || stop "patch の sha256 が合わぬ（渡された: $SHA256 / 実の: $actual）"

numstat="$(g apply --numstat "$PATCH")" || stop "patch を読めぬ（git apply --numstat が落ちた）"
mapfile -t files < <(printf '%s\n' "$numstat" | awk -F'\t' 'NF >= 3 { print $3 }')
echo "  patch が触る file:"
printf '    %s\n' "${files[@]}"
((${#files[@]} > 0)) || stop "patch が触る file が無い"
for f in "${files[@]}"; do
  [[ "$f" == "$GUARD_FILE" ]] || stop "patch が $GUARD_FILE 以外を触る（$f）。この script は門の本体のためだけの物ゆえ、他の file は普通の commit で足せ"
done

cur="$(g rev-parse HEAD)"
[[ "$cur" == "$HEAD_SHA" ]] || stop "手元の先端が合わぬ（渡された: $HEAD_SHA / 作業木の HEAD: $cur）"
on="$(g symbolic-ref --quiet --short HEAD || true)"
[[ "$on" == "$BRANCH" ]] || stop "作業木が枝 $BRANCH に居らぬ（居るのは: ${on:-detached}）"
dirty="$(g status --porcelain)"
[[ -z "$dirty" ]] || stop "作業木が清くない:
$dirty"

g fetch --quiet origin "refs/heads/$BRANCH" || stop "origin の $BRANCH を fetch できぬ"
fetched="$(g rev-parse FETCH_HEAD)"
[[ "$fetched" == "$REMOTE_SHA" ]] || stop "遠方の先端が合わぬ（渡された: $REMOTE_SHA / fetch した: $fetched）"
g merge-base --is-ancestor "$fetched" HEAD || stop "手元が遠方の先端の子ではない。fast-forward で押せぬ"
echo "  検め: sha256・file・手元の先端・作業木・遠方の先端がすべて合う"

# ---- 2. 当てる ----
g apply --check "$PATCH" || stop "git apply --check が落ちた。何も当てておらぬ"
g apply "$PATCH" || stop "git apply が落ちた"
echo "  当てた"

restore() {
  g checkout -- "${files[@]}"
  echo "  当てた物を戻した（git checkout -- ${files[*]}）" >&2
}

# ---- 3. 型と試験 ----
if [[ -n "${HONDEN_APPLY_GUARD_VERIFY:-}" ]]; then
  echo "  ⚠ HONDEN_APPLY_GUARD_VERIFY が置かれておる。tsc と bun test の代わりに $HONDEN_APPLY_GUARD_VERIFY を走らせる（script の試験の口。殿が打つ時は置かぬ）" >&2
  if ! (cd "$WT" && "$HONDEN_APPLY_GUARD_VERIFY"); then
    restore
    stop "試験が落ちた"
  fi
else
  if ! (cd "$WT" && bunx tsc --noEmit); then
    restore
    stop "bunx tsc --noEmit が落ちた"
  fi
  if ! (cd "$WT" && bun test); then
    restore
    stop "bun test が落ちた"
  fi
fi
echo "  型と試験が通った"

# index に載せた物を降ろし、作業木も戻す（commit の前で止まる時）。
unstage_restore() {
  g reset --quiet -- "${files[@]}"
  restore
}

# 作った commit を解き、index と作業木も戻す（commit の後で止まる時）。
# 手元の先端は --head へ帰る。--soft ゆえ、解くのは commit だけで他の物は消さぬ。
uncommit_restore() {
  g reset --quiet --soft "$HEAD_SHA"
  unstage_restore
}

# ---- 4. commit ----
# set -e のままだと、add や commit（pre-commit hook 等）が落ちた時に、当てた物を
# index に載せたまま抜ける。落ちを受け止めて戻す。
if ! g add -- "${files[@]}"; then
  unstage_restore
  stop "git add が落ちた"
fi
if ! g commit --quiet -F "$MSG"; then
  unstage_restore
  stop "commit が落ちた（hook が拒んだ等）"
fi
new="$(g rev-parse HEAD)"

# ---- 5. trailer ----
body="$(g cat-file -p "$new")"
# cat-file -p は先頭に tree・author 等の頭を付ける。最初の空行までを落とした残りが commit 文。
msg_after="$(sed '1,/^$/d' <<<"$body")"
if grep -qiE '^(Claude-Session|Co-authored-by):' <<<"$body"; then
  uncommit_restore
  stop "commit の trailer に Claude-Session か Co-authored-by が在る（hook が足した等）。commit を解いて戻した"
fi
if ! extras="$(trailer_extras <<<"$msg_after")"; then
  uncommit_restore
  stop "commit の trailer が「$ASSISTED」の一行だけでない（余分: $(tr '\n' ' ' <<<"$extras")。hook が足した等）。commit を解いて戻した"
fi
echo "  commit: $new（trailer は $ASSISTED のみ）"

# ---- 6. 押す（fast-forward のみ。force は使わぬ） ----
if ! g push origin "HEAD:refs/heads/$BRANCH"; then
  uncommit_restore
  now="$(g ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1 || true)"
  stop "push が拒まれた。commit $new を解いて戻した（遠方の今の先端: ${now:-引けぬ}）"
fi

# ---- 7. 押した SHA ----
echo "  押した: $BRANCH"
echo "$new"
