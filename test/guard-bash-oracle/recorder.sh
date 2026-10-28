# 箱の中の bash に読ませる記録係。命は走らせず、展開した後の argv を xtrace で fd 9 へ出す。
#
# 箱（box.ts）は初回bash起動後にseccompを据え、execveとexecveatをENOENTで拒む。
# /oracle/shと/proc/self/exeを含めて呼び直せず、命のargvだけが記録される。
# - PATH は空の dir。名だけの命は見つからず、command_not_found_handle が何もせずに返る
# - 道を書いた命（/bin/rm 等）は、箱の中に file が無いゆえ exec が ENOENT で落ちる（execfail で続ける）
# - shell そのものを替える・外を読む・印を替える組み込み（exec・source・.・kill・trap・enable）は
#   enable -n で外す。外した名は PATH を探しに行き、見つからずに記録だけが残る
# xtrace は展開・引用の除去・$IFS の分割・brace 展開の後の語を出す。各件の頭に \x01、関数の名の後に \x02 を置き、
# 改行を含む語でも件の境が割れぬようにする（bash の版で、改行を $'\n' で出すか生の改行で出すかが違う）。
# fd 8 は陽性対照の痕を書く口（標準エラーへ出る）。記録の fd 9 には件の他は混ぜぬ。命の字は /oracle/in/case から読む（攻撃の形をこの file に書かぬ）。
case_text=$(< /oracle/in/case)
exec 9>&1 8>&2 1>/dev/null 2>/dev/null </dev/null
BASH_XTRACEFD=9
PS4=$'\x01${FUNCNAME[0]-}\x02'
PATH=/oracle/empty
command_not_found_handle() { return 0; }
shopt -s execfail
enable -n exec source . kill trap enable
set -x
eval "$case_text"
