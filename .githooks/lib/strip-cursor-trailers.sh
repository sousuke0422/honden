#!/bin/sh
# Cursor の agent が commit に差し込む Co-authored-by を落とす。
# 出所: cursor-agent-exec（Co-authored-by: Cursor <cursoragent@cursor.com>）
# 紋様は表示名でなく宛先の領域（@cursor.com）で留める。表示名は Cursor 本体に埋まった文字列で、
# こちらは握っておらぬ（`Cursor Agent <cursoragent@cursor.com>` が旧い紋様を抜けた実打がある）。
# commit-msg と同じ紋様にすること。

strip_cursor_trailers() {
  file="$1"
  case "$file" in
    '') return 0 ;;
  esac

  tmp=$(mktemp "${file}.XXXXXX") || return 1
  awk '
    /^Co-authored-by: .*<[^>]*@cursor\.com>[[:space:]]*$/ { next }
    { print }
  ' "$file" > "$tmp" && cat "$tmp" > "$file"
  status=$?
  rm -f "$tmp"
  return "$status"
}
