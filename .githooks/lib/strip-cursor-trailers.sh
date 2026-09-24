#!/bin/sh
# Cursor の agent が commit に差し込む Co-authored-by を落とす。
# 出所: cursor-agent-exec（Co-authored-by: Cursor <cursoragent@cursor.com>）

strip_cursor_trailers() {
  file="$1"
  case "$file" in
    '') return 0 ;;
  esac

  tmp=$(mktemp "${file}.XXXXXX") || return 1
  awk '
    /^Co-authored-by: Cursor <cursoragent@cursor.com>[[:space:]]*$/ { next }
    /^Co-authored-by: Cursor[[:space:]]*$/ { next }
    { print }
  ' "$file" > "$tmp" && cat "$tmp" > "$file"
  status=$?
  rm -f "$tmp"
  return "$status"
}
