#!/usr/bin/env bash
# 顔ぶれの差し替え — 二度打ちで起きる入口。
#
# 中身は `honden roster set`（端末なら一人ずつ訊く）。この書は場所を合わせて
# 呼ぶだけで、何も決めぬ。
#
# 名は上流（yohey-w/multi-agent-shogun#156 の Configure-Agents.*）から取り、小文字に
# 直した（Windows 以外で大文字始まりは打ちにくい・殿）。変えるなら三つ揃えて
# （.sh / .command / .bat）。
#
#   bash configure-agents.sh                 訊く
#   bash configure-agents.sh --dry-run       下見（書かぬ）
#   bash configure-agents.sh --karo claude:claude-sonnet-5 --yes
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HONDEN="${HONDEN_BIN:-$ROOT/bin/honden}"

echo ""
echo "  ┌──────────────────────────────────────────────┐"
echo "  │  honden — 顔ぶれの差し替え                    │"
echo "  │  役ごとの CLI と模型、足軽の頭数を決める        │"
echo "  └──────────────────────────────────────────────┘"
echo ""
if [ ! -x "$HONDEN" ]; then
  echo "  bin/honden が無い。先に仕度を: bash scripts/first_setup.sh" >&2
  exit 1
fi
"$HONDEN" roster set "$@"
echo ""
echo "  立っておる陣には効かぬ。次の出陣から: bash shutsujin_departure.sh"
