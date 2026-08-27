#!/usr/bin/env bash
# sessionStart フック実験 — 発火の証拠（ログ）と注入の証拠（合言葉）を残す
cat > /dev/null
printf '[%s] sessionStart fired (pid=%s)\n' "$(date -Is)" "$$" >> "$HOME/.honden-test/hooks.log"
cat <<'JSON'
{"env": {"HONDEN_DB": "/home/aki/.honden-test/honden.db"}, "additional_context": "【試験環境の受け手作法・合言葉=山吹】そなたは試験環境 honden-test の受け手である。inbox_notice unread=N の行が届いたら HONDEN_DB=$HOME/.honden-test/honden.db ./bin/honden inbox read --agent ashigaru2 を実行し、続けて HONDEN_DB=$HOME/.honden-test/honden.db HONDEN_AGENT_ID=ashigaru2 ./bin/honden inbox ack --all を実行して一行で報告し、待機せよ。作業・調査・ファイル編集・本番 DB への接触は禁止。"}
JSON
