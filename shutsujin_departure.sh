#!/usr/bin/env bash
# 出陣の儀 — 本陣を立てる。
#
# 殿の手が覚えておる名と場所である（旧 multi-agent-shogun の
# `shutsujin_departure.sh` と同じ位置）。中身は `scripts/shutsujin.sh` に住む
# ——出陣の書だけを根に置くと、他の script との並びが崩れるゆえ。
#
#   bash shutsujin_departure.sh          出陣（陣を立て、皆を召喚し、
#                                        芯と戦況の窓を起こす）
#   bash shutsujin_departure.sh status   様子見
#   bash shutsujin_departure.sh gate     禁じ手の門だけを叩く
#
# 撤収は人の手でなされよ。この文を書いた者は D006 により他者の陣を畳めぬ。
#
#   tmux kill-session -t honden
#   tmux kill-session -t honden-agents
#
# 戦況の窓（http://127.0.0.1:8788）は出陣に含まれる。口や繋ぎ先を変えるなら:
#
#   HONDEN_DASHBOARD_PORT=9000 bash shutsujin_departure.sh
#   HONDEN_DASHBOARD_HOST=0.0.0.0 bash shutsujin_departure.sh   # 外へも開く
#
# **既定は己の内のみ**。戦況には司令・裁可・陣容が載るゆえ、
# 広げるなら明示で広げよ。
set -euo pipefail

exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/shutsujin.sh" "$@"
