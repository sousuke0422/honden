#!/usr/bin/env bash
# task CLI（koyori-app/task）を、署名を検めてから据える。
#
# review の門（cmd done の前の伺い）と honden-bot --to task は、task が道に
# 在って初めて働く。honden 自身の --fetch と同じ流儀で降ろす:
#
#   署名 → SHA256SUMS → tarball
#
# 縛るのは「誰が署名したか」。身元は koyori-app/task の release-cli.yml に
# 釘付けする（緩めれば、Sigstore で署名した誰の物でも通ってしまう）。
#
#   bash scripts/setup_task_cli.sh          # 訊いてから ~/.local/bin/task へ
#   bash scripts/setup_task_cli.sh --yes    # 訊かぬ
#   --insecure-skip-signature               # 勧めぬ。数は壊れと途中切れしか守らぬ
set -uo pipefail

REPO="koyori-app/task"
DEST="${TASK_CLI_DEST:-$HOME/.local/bin}"
COSIGN="${COSIGN:-cosign}"
YES=0; SKIP_SIG=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --insecure-skip-signature) SKIP_SIG=1 ;;
    *) echo "知らぬ旗: $a（--yes / --insecure-skip-signature）" >&2; exit 2 ;;
  esac
done

c()   { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info(){ echo "  $(c '0;36' '│') $*"; }
ok()  { echo "  $(c '1;32' '✓') $*"; }
warn(){ echo "  $(c '1;33' '▲') $*"; }
die() { echo "  $(c '1;31' '✗') $*" >&2; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }

have curl || die "curl が無い。降ろせぬ"
# 配っておるのは linux x86_64（gnu/musl）と macOS arm64 と Windows。
# ここは honden の土地（Linux）向けの仕度ゆえ、それ以外は正直に断る。
[ "$(uname -s)" = Linux ] || die "この仕度は Linux 向けである（$(uname -s)）。他の土地は releases から手で"
case "$(uname -m)" in x86_64|amd64) : ;; *) die "$(uname -m) 向けの linux 配布は無い。releases を確かめられよ" ;; esac

TAG=$(curl -fsSL -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "${TAG:-}" ] || die "出し物が見当たらぬ"
info "降ろす版: $TAG"

TMPD=$(mktemp -d) || die "作業場を作れなんだ"
trap 'rm -r "$TMPD" 2>/dev/null' EXIT
base="https://github.com/$REPO/releases/download/$TAG"

curl -fsSL -o "$TMPD/SHA256SUMS" "$base/SHA256SUMS" || die "数の紙を降ろせなんだ"

if [ "$SKIP_SIG" = 1 ]; then
  warn "署名を検めずに降ろす（--insecure-skip-signature）。**数は壊れと途中切れしか守らぬ**"
else
  have "$COSIGN" || die "署名を検める道具が無い（cosign）。**検められぬ物は置かぬ。**
      入れ方: https://docs.sigstore.dev/cosign/system_config/installation/
      どうしても急ぐなら --insecure-skip-signature（**勧めぬ**）"
  curl -fsSL -o "$TMPD/SHA256SUMS.cosign.bundle" "$base/SHA256SUMS.cosign.bundle" \
    || die "署名の束を降ろせなんだ。**置いておらぬ**"
  "$COSIGN" verify-blob \
    --bundle "$TMPD/SHA256SUMS.cosign.bundle" \
    --certificate-identity-regexp "^https://github\.com/$REPO/\.github/workflows/release-cli\.yml@refs/tags/" \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    "$TMPD/SHA256SUMS" >/dev/null 2>&1 \
    || die "署名が上流の物と認められなんだ。**置いておらぬ**"
  ok "署名は上流（$REPO の release-cli.yml）の物である"
fi

# tarball の名は版を含むゆえ、**検めた紙から**引く。api の答えから組むと、
# 紙に載っておらぬ名を降ろして「照らされぬまま置く」道が開く。
TARBALL=$(grep -oE 'task-[0-9][^ ]*-x86_64-unknown-linux-gnu\.tar\.gz$' "$TMPD/SHA256SUMS" | head -1)
[ -n "${TARBALL:-}" ] || die "数の紙に linux-gnu の tarball が載っておらぬ"
n=$(grep -cE " \*?${TARBALL//./\\.}\$" "$TMPD/SHA256SUMS")
[ "$n" -eq 1 ] || die "紙の中で $TARBALL が $n 行ある。形が読めぬゆえ置かぬ"

curl -fsSL -o "$TMPD/$TARBALL" "$base/$TARBALL" || die "$TARBALL を降ろせなんだ"
( cd "$TMPD" && grep -E " \*?${TARBALL//./\\.}\$" SHA256SUMS | sha256sum -c --quiet - ) \
  || die "数が合わぬ。**置いておらぬ**"
ok "数が合うた（$TARBALL）"

tar -xzf "$TMPD/$TARBALL" -C "$TMPD" task || die "tarball から task を取り出せなんだ"
[ -x "$TMPD/task" ] || chmod +x "$TMPD/task"

if [ "$YES" != 1 ]; then
  printf '  %s へ task（%s）を置いてよいか [y/N]: ' "$DEST" "$TAG"
  read -r a || a=""
  case "$a" in y|Y|yes) : ;; *) die "やめた。何も置いておらぬ" ;; esac
fi
mkdir -p "$DEST"
# 上書きでなく置き換える（走っておる task が掴んでおっても倒れぬ）
mv -f "$TMPD/task" "$DEST/task"
ok "$DEST/task に $TAG を置いた"

v=$("$DEST/task" --version 2>/dev/null || true)
[ -n "$v" ] && ok "動く: $v" || warn "置いたが --version が答えぬ。道と土地を確かめられよ"

info "次は口の設定である（どれか一つ）:"
echo "      env:   TASK_API_URL / TASK_TOKEN / TASK_TENANT"
echo "      file:  ~/.config/task/config.yaml（task config --help）"
echo "      honden の門は settings.yaml の review.gate(s) から宛先を上書きできる"
