#!/usr/bin/env bash
# 初度の仕度 — 出陣の前に、要る物を揃える。
#
# 旧 first_setup.sh（1030 行）から移した。骨は同じ——道具を確かめ、無ければ
# 断って入れ、設定と正本を整えて、最後に一覧で結ぶ。
#
# 中身は大きく減った。honden が要らぬようにした物がそれだけあるゆえである:
#
#   Python / venv / PyYAML   YAML を読む者が居らぬ（正本は SQLite）
#   queue/*.yaml の初期化    表は正本が持つ。作る files が無い
#   Memory MCP の仕度        記憶も正本に入る
#   inotifywait / fswatch    芯（Rust）が己で見張る
#
# 代わりに一つ増えた。**本体をどう手に入れるか**である。出し物から降ろせば
# Bun も Rust も要らぬ。建てるなら要る。ここで道を分ける。
#
# ## 勝手に入れぬ
#
# 道具を入れるのは、殿が「入れよ」と応えた時だけとする。黙って入れる書は、
# 何が入ったのか後から辿れぬ。`--yes` で断りを省けるが、**既定は訊く**。
#
# ## 遠くから取った物を、確かめずに走らせぬ
#
# 出し物を降ろす道は `curl | bash` の形を取らぬ。数（SHA256）を照らし、
# 五本すべて揃って初めて置く。honden 自身の禁じ手（D008・D011-AT）が
# 戒めておるのと同じ形を、仕度の書も守る。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="sousuke0422/honden"
SETTINGS="$ROOT/config/settings.yaml"
EXAMPLE="$ROOT/config/settings.yaml.example"
DB="${HONDEN_DB:-$HOME/.honden/honden.db}"
# 署名を検める道具。**一箇所で決める**——試験が贋物へ差し替えられるように
# するためと、道が散って一つだけ別の物を指すのを防ぐため（HONDEN_BIN と同じ流儀）。
COSIGN="${HONDEN_COSIGN:-cosign}"

ASSUME_YES=0
SKIP_SIG=0
PKG_ORDER_ONLY=0
MODE=""          # fetch | build。空なら訊く
for a in "$@"; do
  case "$a" in
    --yes|-y)  ASSUME_YES=1 ;;
    --insecure-skip-signature) SKIP_SIG=1 ;;
    --pkg-order) PKG_ORDER_ONLY=1 ;;
    --fetch)   MODE=fetch ;;
    --build)   MODE=build ;;
    -h|--help)
      cat <<'USAGE'
  初度の仕度。

    bash scripts/first_setup.sh [--fetch|--build] [--yes]

      --fetch  本体を出し物から降ろす（curl だけあればよい）
      --build  本体を手元で建てる（Bun と Rust が要る）
      --yes    断りを省く（道具の導入にも同意したものとする）

      --insecure-skip-signature
               署名を検めずに降ろす。**勧めぬ**——数は壊れと途中切れしか
               守らぬゆえ、出し物そのものが差し替えられておっても気づけぬ

      --pkg-order
               道具を入れる手の順を見せて退く（何も入れぬ）

  何も付けねば、その都度訊く。
USAGE
      exit 0 ;;
    *) echo "  知らぬ旗である: $a（--help を見られよ）" >&2; exit 2 ;;
  esac
done

c()   { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info(){ echo "  $(c '0;36' '│') $*"; }
ok()  { echo "  $(c '1;32' '✓') $*"; }
warn(){ echo "  $(c '1;33' '▲') $*"; }
die() { echo "  $(c '1;31' '✗') $*" >&2; exit 1; }
step(){ echo ""; echo "  $(c '1;36' "━━━ $* ━━━")"; echo ""; }

RESULTS=()
note(){ RESULTS+=("$1"); }

# 訊く。`--yes` なら訊かずに是とする。端末が無ければ否とする——
# **無人で走っておる時に黙って道具を入れさせぬ。**
ask() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || { warn "端末が無いゆえ「否」と見る（$1）"; return 1; }
  local reply
  read -r -p "  $(c '1;33' '?') $1 [y/N]: " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

have(){ command -v "$1" >/dev/null 2>&1; }

# cosign が名乗る版。読めねば空を返す。
#
# `--json` の gitVersion を第一とし、無ければ人向けの `GitVersion:` 行を見る。
# 版によって形が違うゆえ、二つとも見る。
cosign_ver() {
  local v
  v=$("$COSIGN" version --json 2>/dev/null | grep -o '"gitVersion"[^,]*' | cut -d'"' -f4)
  [ -z "${v:-}" ] && v=$("$COSIGN" version 2>/dev/null | grep -oE 'GitVersion:[[:space:]]*\S+' | awk '{print $2}')
  printf '%s' "${v:-}"
}

# その cosign で我らの束を検められるか（v3 以上か）。
#
# **読めぬ版は否とする。** 読めぬ物を新しいと見なせば、そこが素通りの口になる。
cosign_ok() {
  have "$COSIGN" || return 1
  local v maj
  v=$(cosign_ver)
  maj=$(printf '%s' "$v" | tr -d 'v' | cut -d. -f1)
  [ -n "${maj:-}" ] && [ "$maj" -ge 3 ] 2>/dev/null
}

# どの手を、どの順で試すか。**問える形にしておく**——
# 順は品ごとに違い、しかも外からは見えぬ。`--pkg-order` で覗ける。
pkg_order() {
  case "${1:-}" in
    brew) echo "brew apt dnf" ;;
    dnf)  echo "dnf apt brew" ;;
    *)    echo "apt brew dnf" ;;   # 既定は土地の手が先
  esac
}

# 順を訊かれただけなら、答えて退く（試験と、人が確かめるため）
if [ "$PKG_ORDER_ONLY" = 1 ]; then
  echo "既定:   $(pkg_order)"
  echo "cosign: $(pkg_order brew)"
  exit 0
fi


echo ""
echo "$(c '1;33' '  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓')"
echo "$(c '1;33' '  ┃') $(c '1;37' '🏯 honden')  〜 $(c '1;36' '初度の仕度') 〜                        $(c '1;33' '┃')"
echo "$(c '1;33' '  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛')"
echo ""
info "置き場: $ROOT"

# ── 一、土地を見る ────────────────────────────────────────────────
step "一、土地"

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      info "WSL（Windows Subsystem for Linux）"
      # **正本を /mnt/c に置かせぬ。** 9p の上では書きが 25 倍・読みが 84 倍
      # 遅い（honden 自身が openStore で拒む）。仕度の段で言うておく。
      case "$ROOT" in
        /mnt/*) warn "repo が $ROOT にある。**正本は ext4 側（~/.honden）へ置くこと**——9p の上では桁で遅い" ;;
      esac
    else
      info "Linux"
    fi ;;
  Darwin) info "macOS $(sw_vers -productVersion 2>/dev/null || echo '')" ;;
  *) warn "見知らぬ土地である（$UNAME_S）。動くかは分からぬ" ;;
esac
note "土地: $UNAME_S"

# ── 二、要る道具 ──────────────────────────────────────────────────
step "二、要る道具"

# 入れ方は土地で違う。**知らぬ土地では入れ方を推さぬ**——
# 当てずっぽうの命令を走らせるより、何が要るかだけ告げるほうが安全である。
# 一つだけ入れる。品ごとに好みの手を先へ回せる。
#   pkg_install <品> [先に試す手]
#
# **好みが要る訳。** 土台の道具（tmux・git の類）は土地の手で入れるのが
# 筋である——brew は /home/linuxbrew に入り、土地の物を覆い隠す。
#
# だが cosign は違う。**土地の archive は古い**——Ubuntu 26.04 が配るのは
# 2.6.2 で、我らの束は v3 でなければ読めぬ（殿の実測 2026-08-31）。
# brew は上流に近いゆえ、cosign に限っては Linux でも brew を先に試す。
#
# 入れた後に版を検める段は残す。好みは当たる率を上げるだけで、
# **守りではない**——古い物が入れば、その先で止まる。
# 一つだけ入れる。
#   pkg_install <品> [先に試す手] [入った物を検める関数]
#
# **検める関数が肝である。** 同じ `apt` でも中身が違う——素の Ubuntu 26.04 は
# cosign 2.6.2 を配り、WakeMeOps（第三者 repo・upstream の binary を deb に
# 詰め直す）を足しておれば 3.1.3 が来る。この機体は後者であった
# （殿の実測 2026-08-31）。
#
# 外からは見分けられぬゆえ、**順で当てるのは推量にすぎぬ**。入れた後に検め、
# 足りねば次の手へ回る。順は当たる率を上げるだけの前置きになる。
pkg_install() {
  local what="$1" prefer="${2:-}" check="${3:-}"
  local order
  order=$(pkg_order "$prefer")

  # 入った物が用を成すか。検める関数が無ければ「入れば良し」とする
  _ok() { [ -z "$check" ] && return 0; "$check"; }

  local m tried=0
  for m in $order; do
    case "$m" in
      apt)  have apt-get || continue
            ask "$what を apt で入れてよいか（sudo を使う）" || continue
            tried=1
            sudo apt-get update >/dev/null 2>&1
            sudo apt-get install -y "$what" >/dev/null 2>&1 ;;
      brew) have brew || continue
            ask "$what を brew で入れてよいか" || continue
            tried=1
            brew install "$what" >/dev/null 2>&1 ;;
      dnf)  have dnf || continue
            ask "$what を dnf で入れてよいか（sudo を使う）" || continue
            tried=1
            sudo dnf install -y "$what" >/dev/null 2>&1 ;;
      *)    continue ;;
    esac
    if _ok; then
      ok "$what を $m で入れた"
      return 0
    fi
    # **入ったが用を成さぬ時も、黙って次へは行かぬ。** 何が起きたか告げる
    [ -n "$check" ] && warn "$m の $what は用を成さぬ。次の手を試す"
  done
  [ "$tried" = 0 ] && warn "入れ方が分からぬ。$what を手で入れられよ"
  return 1
}

MISSING=0
need() {
  local cmd="$1" pkg="${2:-$1}" why="$3"
  if have "$cmd"; then
    ok "$cmd — あり"
    note "$cmd: OK"
    return 0
  fi
  warn "$cmd が無い（$why）"
  if pkg_install "$pkg"; then
    if have "$cmd"; then ok "$cmd — 入った"; note "$cmd: 入れた"; return 0; fi
  fi
  note "$cmd: **無い**"
  MISSING=$((MISSING + 1))
  return 1
}

need tmux tmux "陣を組む"
need curl curl "配りと生死の確かめ"
need flock util-linux "芯の二重起動を防ぐ"
need git git "取り込みと持ち場の見張り"
need sha256sum coreutils "降ろした物を照らす"

# tmux の版。3.0 未満では pane の名札（@agent_id）が扱えぬ。
if have tmux; then
  TMUX_V="$(tmux -V 2>/dev/null | awk '{print $2}' | tr -d 'a-z-')"
  TMUX_MAJOR="${TMUX_V%%.*}"
  if [ -n "${TMUX_MAJOR:-}" ] && [ "$TMUX_MAJOR" -lt 3 ] 2>/dev/null; then
    warn "tmux $TMUX_V は古い。3.0 以上が要る（pane の名札に依っておる）"
    note "tmux: **古い（$TMUX_V）**"
    MISSING=$((MISSING + 1))
  else
    info "tmux $TMUX_V"
  fi
fi

[ "$MISSING" -gt 0 ] && warn "$MISSING 件足りぬ。揃えてからもう一度走らせられよ"

# ── 二の二、門の入口 ──────────────────────────────────────────────
#
# **本体を得る前に置く。** ここは本体の在る無しと関わらぬ話で、後ろに置くと
# 本体の入手でつまずいた時に届かぬ（実測: `--fetch` が出し物なしで倒れ、
# 門の入口が印のまま残った・2026-09-01）。
step "二の二、門の入口"

# `.codex/hooks.json` は道を印（`__HONDEN_ROOT__`）で持っている。
#
# **絶対で焼き付けると二つ困る。** 公にすれば書いた者の利用者名と作業場の配置が
# 出るし、他所へ clone すれば無い binary を指す。Claude 側は
# `$CLAUDE_PROJECT_DIR` で書けるが、codex 側にその変数が無い。
#
# **印のまま残せば門が黙る。** ここで実の道へ直し、直したことを告げる。
CODEX_HOOKS="$ROOT/.codex/hooks.json"
# **雛形だけを追い、実体は追わぬ。** 追跡すると、ここで書き換えた道が
# そのまま commit に載る（実際に一度載せた・2026-09-01）。
if [ ! -f "$CODEX_HOOKS" ] && [ -f "$CODEX_HOOKS.example" ]; then
  cp "$CODEX_HOOKS.example" "$CODEX_HOOKS"
fi
if [ -f "$CODEX_HOOKS" ]; then
  if grep -q '__HONDEN_ROOT__' "$CODEX_HOOKS"; then
    tmp=$(mktemp) && sed "s|__HONDEN_ROOT__|$ROOT|g" "$CODEX_HOOKS" > "$tmp" && mv "$tmp" "$CODEX_HOOKS"
    ok "codex の門の入口を、この置き場へ向けた"
    note "門の入口: 直した"
  else
    ok "codex の門の入口は既に向いておる"
    note "門の入口: OK"
  fi
else
  warn ".codex/hooks.json が無い。codex を使うなら門が効かぬ"
  note "門の入口: **無い**"
fi

# ── 三、本体をどう手に入れるか ────────────────────────────────────
step "三、本体"

BINS=(honden honden-bot honden-watch honden-parse honden-kill)

all_present() {
  local b
  for b in "${BINS[@]}"; do [ -x "$ROOT/bin/$b" ] || return 1; done
  return 0
}

if all_present && [ -z "$MODE" ]; then
  ok "bin/ に五本とも揃うておる（$("$ROOT/bin/honden" version 2>/dev/null || echo '版は不明')）"
  info "新しくするなら honden update --check"
  note "本体: あり"
else
  if [ -z "$MODE" ]; then
    echo "  本体の手に入れ方を選ばれよ:"
    echo "    1) 出し物から降ろす — curl だけでよい（早い）"
    echo "    2) 手元で建てる     — Bun と Rust が要る（手を入れるなら）"
    if [ "$ASSUME_YES" = 1 ]; then
      MODE=fetch
      info "--yes ゆえ 1)（降ろす）を採る"
    elif [ -t 0 ]; then
      read -r -p "  $(c '1;33' '?') [1/2]: " pick
      case "$pick" in 2) MODE=build ;; *) MODE=fetch ;; esac
    else
      MODE=fetch
    fi
  fi

  if [ "$MODE" = build ]; then
    have bun  || die "bun が無い。https://bun.sh から入れられよ（我は入れぬ——道具の導入は殿の手で）"
    have cargo || die "cargo が無い。https://rustup.rs から入れられよ（我は入れぬ）"
    info "建てておる（少し掛かる）…"
    (cd "$ROOT" && bun install && bun run build:all) || die "建てられなんだ"
    ok "五本とも建った"
    note "本体: 建てた"
  else
    # ── 降ろす。**数を照らし、五本揃って初めて置く** ──
    have curl || die "curl が無い。降ろせぬ"
    # **macOS は配っておらぬ。** 芯は inotify 一本ゆえ Linux でしか建たぬ。
    case "$(uname -s)" in
      Linux) OS=linux ;;
      Darwin) die "macOS 向けは配っておらぬ（芯は inotify 一本ゆえ建たぬ）。" ;;
      *) die "この土地向けは配っておらぬ。--build で建てられよ" ;;
    esac
    case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "$(uname -m) 向けは配っておらぬ。--build で建てられよ" ;; esac
    info "土地: $OS-$ARCH"

    TAG=$(curl -fsSL -H 'Accept: application/vnd.github+json' \
            "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
          | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
    [ -n "${TAG:-}" ] || die "出し物が見当たらぬ。まだ一つも出しておらぬなら --build で建てられよ"
    info "降ろす版: $TAG"

    TMPD=$(mktemp -d) || die "作業場を作れなんだ"
    trap 'rm -r "$TMPD" 2>/dev/null' EXIT

    base="https://github.com/$REPO/releases/download/$TAG"
    curl -fsSL -o "$TMPD/SHA256SUMS" "$base/SHA256SUMS" || die "数の紙を降ろせなんだ"

    # ── 署名を先に検める。**紙を縛れば、紙が縛る全部が縛られる** ──
    #
    #     署名 → SHA256SUMS → 各 binary
    #
    # 縛るのは「誰が署名したか」である。身元の指定を省いて cosign を走らせると
    # *Sigstore で署名された物なら誰の物でも通る*——誰でも自分の workflow で
    # 署名できるゆえ、それは検めになっておらぬ。
    if [ "$SKIP_SIG" = 1 ]; then
      warn "署名を検めずに降ろす（--insecure-skip-signature）。**数は壊れと途中切れしか守らぬ**"
    elif ! have "$COSIGN"; then
      # 断る前に、入れてよいか訊く。tmux や curl と同じ扱いである——
      # brew にも apt にも在ることが多い（殿の実測 2026-08-31）。
      warn "署名を検める道具が無い（cosign）"
      # brew を先に試すが、**決め手は入った後の検め**である（cosign_ok）。
      # 同じ apt でも v2 を配る土地と v3 を配る土地がある。
      pkg_install cosign brew cosign_ok || true
      if cosign_ok; then
        :
      else
        # **安全な道を先に示す。** 「入れる」か「飛ばす」の二択にすると急ぐ者は
        # 飛ばす。--build は cosign を一切要さぬ——降ろす物が無いゆえ検める物も無い。
        die "署名を検められぬ。**検められぬ物は置かぬ。**
      手元で建てる: bash scripts/first_setup.sh --build（何も降ろさぬゆえ cosign は要らぬ）
      道具を入れる: https://docs.sigstore.dev/cosign/system_config/installation/
      どうしても急ぐなら --insecure-skip-signature（**勧めぬ**）"
      fi
    fi
    # **版も見る。束の形が版で変わる。**
    #
    # 出す側は v3 で署名し、v3 の束を書く。v2 の cosign はそれを素では読めぬ。
    # そして**素の Ubuntu 26.04 の apt が配るのは 2.6.2 である**（v3 は
    # 第三者 repo 由来・殿の実測 2026-08-31）。入れさせて検められぬのでは
    # 親切が仇になるゆえ、ここで見分けて告げる。
    if [ "$SKIP_SIG" != 1 ]; then
      cv=$(cosign_ver)
      if ! cosign_ok; then
        die "cosign が古い、または版が読めぬ（${cv:-不明}）。この束は v3 以上でしか検められぬ。
      ※ 素の apt が配るのは v2 のことがある（Ubuntu 26.04 は 2.6.2）
      手元で建てる: bash scripts/first_setup.sh --build（何も降ろさぬゆえ cosign は要らぬ）
      新しく入れる: https://docs.sigstore.dev/cosign/system_config/installation/
      どうしても急ぐなら --insecure-skip-signature（**勧めぬ**）"
      fi
      info "cosign $cv"
      curl -fsSL -o "$TMPD/SHA256SUMS.cosign.bundle" "$base/SHA256SUMS.cosign.bundle" \
        || die "署名の束を降ろせなんだ。**一つも置いておらぬ**"
      "$COSIGN" verify-blob \
        --bundle "$TMPD/SHA256SUMS.cosign.bundle" \
        --certificate-identity-regexp "^https://github\.com/$REPO/\.github/workflows/release\.yml@refs/tags/" \
        --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
        "$TMPD/SHA256SUMS" >/dev/null 2>&1 \
        || die "署名が我らの物と認められなんだ。**一つも置いておらぬ**"
      ok "署名は我らの物である（Sigstore keyless）"
    fi

    for b in "${BINS[@]}"; do
      curl -fsSL -o "$TMPD/$b-$OS-$ARCH" "$base/$b-$OS-$ARCH" || die "$b を降ろせなんだ"
    done

    # **一つでも違えば一つも置かぬ。** 半分だけ新しい bin/ は、
    # どちらの版とも違う物になる。
    #
    # **本数を数えるのが肝である。** 紙から一本抜けておると、grep は残りだけを
    # 拾い、`sha256sum -c` はその三本で合格を出す——抜けた一本は**照らされぬまま
    # 置かれる**。試験が即座にこれを突いた（tests/setup_fetch.bats）。
    # 「載せ忘れ」を「無検査で通す」に化けさせぬため、数が揃わねば倒す。
    want="$TMPD/want.txt"
    ( cd "$TMPD" && grep -E " \*?($(IFS='|'; echo "${BINS[*]/%/-$OS-$ARCH}"))\$" SHA256SUMS > want.txt ) || true
    n=$(grep -c . "$want" 2>/dev/null || echo 0)
    [ "$n" -eq "${#BINS[@]}" ] \
      || die "降ろした物が検めを通らなんだ（数の紙に ${#BINS[@]} 本のはずが $n 本）。**一つも置いておらぬ**"
    ( cd "$TMPD" && sha256sum -c --quiet want.txt ) \
      || die "降ろした物が検めを通らなんだ。**一つも置いておらぬ**"
    ok "五本とも数が合うた"

    mkdir -p "$ROOT/bin"
    for b in "${BINS[@]}"; do
      chmod +x "$TMPD/$b-$OS-$ARCH"
      # 上書きでなく**置き換える**。走っておる芯は己の binary を掴んでおり、
      # cp は Text file busy で倒れる（建て方で実測 2026-08-30）。
      mv -f "$TMPD/$b-$OS-$ARCH" "$ROOT/bin/$b"
    done
    ok "$TAG を置いた"
    if [ "$SKIP_SIG" = 1 ]; then note "本体: 降ろした（$TAG・**署名は検めておらぬ**）"
    else note "本体: 降ろした（$TAG・署名検証済み）"; fi
  fi
fi

# ── 四、設定 ──────────────────────────────────────────────────────
step "四、設定"

if [ -f "$SETTINGS" ]; then
  ok "config/settings.yaml — あり（触らぬ）"
  note "設定: あり"
elif [ -f "$EXAMPLE" ]; then
  cp "$EXAMPLE" "$SETTINGS"
  ok "雛形から config/settings.yaml を作った"
  warn "**顔ぶれを己の陣に直されよ**——CLI とモデルは組で書くこと"
  note "設定: 雛形から作った（要編集）"
else
  warn "雛形が無い。config/settings.yaml を手で書かれよ"
  note "設定: **無い**"
fi

# ── 五、正本 ──────────────────────────────────────────────────────
step "五、正本"

if [ -x "$ROOT/bin/honden" ] && [ -f "$SETTINGS" ]; then
  mkdir -p "$(dirname "$DB")"
  if HONDEN_DB="$DB" "$ROOT/bin/honden" roster sync --settings "$SETTINGS" 2>&1 | tail -6; then
    ok "正本に顔ぶれを写した: $DB"
    note "正本: OK"
  else
    warn "顔ぶれを写せなんだ。設定を見直されよ"
    note "正本: **失敗**"
  fi
else
  warn "本体か設定が無いゆえ、正本には触らぬ"
  note "正本: 未了"
fi

# ── 六、道 ────────────────────────────────────────────────────────
step "六、道"

if have honden; then
  ok "honden は道に在る（$(command -v honden)）"
  note "道: OK"
else
  info "指示書は素の 'honden' で書いてある。繋いでおくと楽である:"
  echo "      mkdir -p ~/.local/bin && ln -sfn '$ROOT/bin/honden' ~/.local/bin/honden"
  note "道: 未接続（任意）"
fi

# ── 締め ──────────────────────────────────────────────────────────
step "締め"

for r in "${RESULTS[@]}"; do
  case "$r" in
    *"**"*) echo "  $(c '1;31' '✗') $r" ;;
    *"未了"*|*"任意"*|*"要編集"*) echo "  $(c '1;33' '▲') $r" ;;
    *) echo "  $(c '1;32' '✓') $r" ;;
  esac
done

echo ""
if [ "$MISSING" -gt 0 ]; then
  warn "足りぬ物がある。揃えてからもう一度"
  exit 1
fi
info "次は出陣:  bash shutsujin_departure.sh"
info "様子見  :  bash shutsujin_departure.sh status"
echo ""
