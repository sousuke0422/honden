//! 命を構文で解き、門へ構造を渡す。
//!
//! # なぜ要るか
//!
//! 門はこれまで生の文字列を紋様で当てておった。四度継ぎを当てて、限界が見えた
//! （`docs/decisions.md` 十八の「継ぎの数え」）。とりわけ最後の二枚:
//!
//! - `tmux -L sock send-keys …` — 旗と値を読み飛ばさねば副命令が見えぬ
//! - `python3 <<'EOF' … EOF` — **引用の中の字面が、命と区別できぬ**
//!
//! 後者で将軍は己の門に二度弾かれた。決め書きを書く手が、決め書きの中の
//! 危うい字面に当たったのである。構文を解けば一目で分かる——heredoc の中身は
//! 命ではない。紋様には永遠に分からぬ。
//!
//! # 何を返すか
//!
//! 判定はせぬ。**解いた構造だけ**を JSON で返す。掟は TS 側（`src/guard.ts`）が
//! 持つ——掟は人の言葉で読めるべきで、Rust に埋めると誰も読まなくなる。
//!
//! # 三つの返り方
//!
//! | | 意味 | 門の振る舞い |
//! |---|---|---|
//! | `ok: false` | 解けなんだ | **拒む**（知らぬ形は通さぬ） |
//! | `ok: true, complete: false` | 解けたが、畳めぬ部分がある | **拒む**（見落としの余地を残さぬ） |
//! | `ok: true, complete: true` | 全て見えた | 掟に照らす |
//!
//! **二段目が肝である。** 「解けた」とだけ言うて中途半端な argv を渡せば、門は
//! それを全体と思うて照らす——成功の顔をした fail-open になる。畳めなんだ物が
//! 一つでもあれば、そう言う。

use brush_parser::ast;

/// 語ひとつの素性。**引用されておるか**が最も重い——引用の中の `rm` は命ではない。
#[derive(Default)]
struct WordFacts {
    /// 書かれたままの姿（引用も含む）
    text: String,
    /// **引用を剥いだ値。** 掟はこちらに照らす——`rm -rf "/"` は
    /// `rm -rf /` と同じ害であり、引用したからとて赦されぬ。
    /// 展開（`$X` / `$(…)`）は走らせるまで判らぬゆえ、書かれたまま残す。
    value: String,
    /// 語の全体が引用に包まれておる（`"rm -rf /"` のような）
    quoted: bool,
    /// 引用の外に `*` か `?` がある
    glob: bool,
    /// 引用の外に変数展開がある（`$DIR` — 中身は走らせるまで判らぬ）
    var: bool,
    /// 命令置換を含む（`$(…)` / `` `…` ` `）
    cmdsubst: bool,
}

/// 単純命令ひとつ。`argv[0]` が命令位置である。
struct SimpleCmd {
    argv: Vec<WordFacts>,
    assigns: Vec<String>,
}

#[derive(Default)]
struct Extract {
    cmds: Vec<SimpleCmd>,
    /// heredoc の中身。**命令位置には決して入らぬ**
    heredocs: Vec<String>,
    /// 命令置換の中身。門は必要なら再帰して解ける
    substs: Vec<String>,
    /// 畳めなんだ物。一つでもあれば `complete: false`
    unhandled: Vec<String>,
    /// shell が標準入力から命として読むのに、その字が観測できぬ物
    /// （`… | base64 -d | sh`・`curl … | bash`・`sh < file`・`sh <<<"$X"`）。
    /// 掟は TS 側が判ずる。ここは見えなんだことだけを言う
    opaque: Vec<String>,
}

/// 語を解いて素性を得る。
///
/// **解けなんだ語は `Err`。** probe の写しは `Err(_) => {}` と既定値を返しておった
/// ——それは「引用されておらぬ・glob 無し・変数無し」と**嘘をつく**に等しい。
/// 新しい層は fail-open として生まれる。生まれた時に塞ぐ。
/// 語の一片が原文で占める所を切り出す。
///
/// `WordPieceWithSource` は中身を持たず、原文への添字を持つ。展開
/// （`$X` / `$(…)`）は走らせるまで値が判らぬゆえ、書かれたままを値とする。
fn src<'a>(raw: &'a str, pw: &brush_parser::word::WordPieceWithSource) -> &'a str {
    raw.get(pw.start_index..pw.end_index).unwrap_or("")
}

/// 逃がしの片（`\x`）から、逃がした字を取り出す。行の継ぎ（`\` と改行）は空になる。
fn unescape(e: &str) -> &str {
    let rest = e.strip_prefix('\\').unwrap_or(e);
    if rest == "\n" { "" } else { rest }
}

fn word_facts(raw: &str, opts: &brush_parser::ParserOptions) -> Result<WordFacts, String> {
    use brush_parser::word::WordPiece as P;
    let pieces = brush_parser::word::parse(raw, opts)
        .map_err(|e| format!("語を解けぬ（{raw}）: {e}"))?;

    let mut f = WordFacts { text: raw.to_string(), ..Default::default() };
    // 空の語（`""`）は「引用されておる」と見る——命令位置には立てぬゆえ。
    let mut all_quoted = true;
    let mut value = String::new();
    for pw in &pieces {
        match &pw.piece {
            // 引用された中身。**命ではないが、値ではある。**
            // `rm -rf "/"` の `/` は引用されておっても根を指す。
            P::SingleQuotedText(t) | P::AnsiCQuotedText(t) => value.push_str(t),
            P::DoubleQuotedSequence(inner) => {
                for ipw in inner {
                    match &ipw.piece {
                        P::Text(t) => value.push_str(t),
                        P::CommandSubstitution(s) | P::BackquotedCommandSubstitution(s) => {
                            // 引用の中でも置換は走る。中身を渡し、印も立てる。
                            f.cmdsubst = true;
                            f_push_subst(s);
                        }
                        P::ParameterExpansion(_) => f.var = true,
                        // 二重引用の中の `\$` `\"` 等。逃がした字そのものが値である
                        P::EscapeSequence(e) => value.push_str(unescape(e)),
                        _ => {}
                    }
                }
            }
            P::CommandSubstitution(s) => {
                f.cmdsubst = true;
                all_quoted = false;
                value.push_str(src(raw, pw));
                f_push_subst(s);
            }
            P::BackquotedCommandSubstitution(s) => {
                f.cmdsubst = true;
                all_quoted = false;
                value.push_str(src(raw, pw));
                f_push_subst(s);
            }
            P::ParameterExpansion(_) => {
                f.var = true;
                all_quoted = false;
                // 展開の中身は走らせるまで判らぬ。書かれたまま残す。
                value.push_str(src(raw, pw));
            }
            // 逆斜線で逃がした字（`\rm` の `\r`）。**逃がした字そのものが値である。**
            // 書かれたまま残すと、`\rm -rf /` の頭が `\rm` になり、命の名と読めぬ
            // （今の門はこれを通しておった）。逃がした字は引用と同じく展開も glob も
            // 起こさぬゆえ、glob の印は立てぬ。
            P::EscapeSequence(e) => {
                all_quoted = false;
                value.push_str(unescape(e));
            }
            P::Text(t) => {
                if t.contains('*') || t.contains('?') || t.contains('[') {
                    f.glob = true;
                }
                all_quoted = false;
                value.push_str(t);
            }
            _ => {
                all_quoted = false;
                value.push_str(src(raw, pw));
            }
        }
    }
    f.quoted = all_quoted && !pieces.is_empty();
    f.value = value;
    Ok(f)
}

// 命令置換の中身は語の解析中に見つかるが、集める先は Extract である。
// thread_local で受けるより、解析を二度回す方が読みやすい——命は短く、
// 一回 1.35 µs ゆえ二度でも塵である。
thread_local! {
    static SUBSTS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}
fn f_push_subst(s: &str) {
    SUBSTS.with(|v| v.borrow_mut().push(s.to_string()));
}

fn walk_list(list: &ast::CompoundList, out: &mut Extract, opts: &brush_parser::ParserOptions) {
    for item in &list.0 {
        let and_or = &item.0;
        walk_pipeline(&and_or.first, out, opts);
        for a in &and_or.additional {
            match a {
                ast::AndOr::And(p) | ast::AndOr::Or(p) => walk_pipeline(p, out, opts),
            }
        }
    }
}

fn walk_pipeline(p: &ast::Pipeline, out: &mut Extract, opts: &brush_parser::ParserOptions) {
    for cmd in &p.seq {
        walk_command(cmd, out, opts);
    }
    shell_stdin(p, out, opts);
}

fn handle_redirect(r: &ast::IoRedirect, out: &mut Extract, opts: &brush_parser::ParserOptions) {
    match r {
        ast::IoRedirect::HereDocument(_, hd) => {
            out.heredocs.push(hd.doc.value.clone());
            // **区切りを引用せぬ heredoc の本文は展開される。** `cat <<EOF` の本文の
            // `$(…)` と backtick は走る（今の門はこれを通しておった）。本文は二重引用の
            // 中と同じ規則で展開されるゆえ、二重引用に包んで語として解き、置換を拾う。
            // 本文の `"` は字のままゆえ逃がして包む。
            // 区切りを引用した heredoc（`<<'EOF'`）は展開されぬ。拾わぬ。
            if hd.requires_expansion {
                let wrapped = format!("\"{}\"", hd.doc.value.replace('"', "\\\""));
                if let Err(e) = word_facts(&wrapped, opts) {
                    out.unhandled.push(format!("heredoc の本文の展開を解けぬ: {e}"));
                }
            }
        }
        // here-string の語の中の置換も走る（`cat <<<"$(…)"`）
        ast::IoRedirect::HereString(_, w) => {
            if let Err(e) = word_facts(&w.value, opts) {
                out.unhandled.push(e);
            }
        }
        _ => {}
    }
}

/// shell の名か（`/bin/bash` のように道が付いてもよい）。
fn is_shell(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    matches!(base, "sh" | "bash" | "zsh" | "dash" | "ksh" | "ash" | "mksh" | "busybox")
}

/// 単純命令が「標準入力から命を読む shell」か。
///
/// `-c` の束があれば引数の字を走らせる（門は別の道で降りる）。`-n` の束は読むだけで
/// 走らせぬ。`-s` があれば標準入力を読む。それ以外は、旗でない引数（script の file）が
/// 無い時だけ標準入力を読む。
/// `busybox sh` は二つ目の語を shell の名として見る。
fn reads_stdin_script(argv: &[WordFacts]) -> bool {
    let Some(head) = argv.first() else { return false };
    if !is_shell(&head.value) {
        return false;
    }
    let mut rest = &argv[1..];
    if head.value.rsplit('/').next() == Some("busybox") {
        match rest.first() {
            Some(w) if is_shell(&w.value) && w.value != "busybox" => rest = &rest[1..],
            _ => return false,
        }
    }
    let mut stdin = true;
    let mut i = 0;
    while i < rest.len() {
        let v = rest[i].value.as_str();
        if v == "-s" {
            return true;
        }
        // `-c` の束は引数の字を走らせる（門は別の道で降りる）。`-n` の束は読むだけで
        // 走らせぬ（構文の検め）。どちらも標準入力の命は走らぬ
        if v.len() <= 5 && v.starts_with('-') && !v.starts_with("--") && (v[1..].contains('c') || v[1..].contains('n')) {
            return false;
        }
        if v == "-o" || v == "+o" || v == "-O" || v == "+O" || v == "--rcfile" || v == "--init-file" {
            i += 2;
            continue;
        }
        if !v.starts_with('-') && !v.starts_with('+') {
            stdin = false;
            break;
        }
        i += 1;
    }
    stdin
}

/// 引数の無い `cat` が heredoc か here-string から読む時、その字を返す。
///
/// heredoc の本文は、区切りを引用せねば展開される。展開の中の置換は handle_redirect が
/// 別に拾うゆえ、ここでは書かれた本文をそのまま返す。here-string の語に展開が在れば読めぬ。
fn cat_input(c: &ast::Command, opts: &brush_parser::ParserOptions) -> Option<String> {
    let argv = simple_argv(c, opts)?;
    let name = argv.first()?.value.rsplit('/').next()?.to_string();
    if name != "cat" || argv.len() != 1 {
        return None;
    }
    let ast::Command::Simple(sc) = c else { return None };
    let items = sc.prefix.iter().flat_map(|p| p.0.iter()).chain(sc.suffix.iter().flat_map(|s| s.0.iter()));
    for item in items {
        if let ast::CommandPrefixOrSuffixItem::IoRedirect(r) = item {
            match r {
                ast::IoRedirect::HereDocument(fd, hd) if fd.map_or(true, |f| f == 0) => {
                    return Some(hd.doc.value.clone());
                }
                ast::IoRedirect::HereString(fd, w) if fd.map_or(true, |f| f == 0) => {
                    let f = facts_quiet(&w.value, opts).ok()?;
                    return if f.var || f.cmdsubst { None } else { Some(f.value) };
                }
                _ => {}
            }
        }
    }
    None
}

/// 管の前の段が、字どおり読める字を書き出すなら、その字を返す。
///
/// `echo`（`-n` `-e` `-E` を除いた引数を空白で繋ぐ）と、`%` を含まぬ `printf` の
/// 書式（`\n` を改行に）だけを読む。引数に変数・置換が在れば読めぬ。
fn literal_output(argv: &[WordFacts]) -> Option<String> {
    let head = argv.first()?;
    if argv.iter().any(|w| w.var || w.cmdsubst) {
        return None;
    }
    let name = head.value.rsplit('/').next().unwrap_or(&head.value);
    match name {
        "echo" => {
            let args: Vec<&str> = argv[1..]
                .iter()
                .map(|w| w.value.as_str())
                .skip_while(|v| matches!(*v, "-n" | "-e" | "-E" | "-ne" | "-en"))
                .collect();
            Some(args.join(" "))
        }
        "printf" => {
            let fmt = argv.get(1)?;
            if argv.len() != 2 || fmt.value.contains('%') {
                return None;
            }
            Some(fmt.value.replace("\\n", "\n"))
        }
        _ => None,
    }
}

/// 語を解くが、置換を群れへ積まぬ。
///
/// word_facts は解く途中で置換を積む。命を歩く時に一度積んだ語を、管の継ぎを見るために
/// 解き直すと、同じ置換が二度積まれる。解き直す所はこれを使う。
fn facts_quiet(raw: &str, opts: &brush_parser::ParserOptions) -> Result<WordFacts, String> {
    let n = SUBSTS.with(|v| v.borrow().len());
    let r = word_facts(raw, opts);
    SUBSTS.with(|v| v.borrow_mut().truncate(n));
    r
}

fn simple_argv(c: &ast::Command, opts: &brush_parser::ParserOptions) -> Option<Vec<WordFacts>> {
    let ast::Command::Simple(sc) = c else { return None };
    let mut argv = Vec::new();
    if let Some(w) = &sc.word_or_name {
        argv.push(facts_quiet(&w.value, opts).ok()?);
    }
    if let Some(suffix) = &sc.suffix {
        for item in &suffix.0 {
            if let ast::CommandPrefixOrSuffixItem::Word(w) = item {
                argv.push(facts_quiet(&w.value, opts).ok()?);
            }
        }
    }
    Some(argv)
}

/// 単純命令の向き替えのうち、標準入力へ字を入れる物（here-string・`<` の file）。
fn stdin_redirects(c: &ast::Command) -> Vec<&ast::IoRedirect> {
    let ast::Command::Simple(sc) = c else { return Vec::new() };
    let items = sc.prefix.iter().flat_map(|p| p.0.iter()).chain(sc.suffix.iter().flat_map(|s| s.0.iter()));
    items
        .filter_map(|item| match item {
            ast::CommandPrefixOrSuffixItem::IoRedirect(r) => match r {
                ast::IoRedirect::HereString(fd, _) | ast::IoRedirect::File(fd, ast::IoFileRedirectKind::Read, _)
                    if fd.map_or(true, |f| f == 0) =>
                {
                    Some(r)
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// shell が標準入力から読む命を、字どおり読めれば置換と同じ群れへ渡し、読めねば
/// opaque に挙げる。
///
/// 門は置換の中身を命として解いて判ずる。`echo kill | sh` の `kill`、
/// `sh <<<"kill 1"` の `kill 1` は、置換と同じく後で走る命である。
fn shell_stdin(p: &ast::Pipeline, out: &mut Extract, opts: &brush_parser::ParserOptions) {
    for (i, cmd) in p.seq.iter().enumerate() {
        let Some(argv) = simple_argv(cmd, opts) else { continue };
        if !reads_stdin_script(&argv) {
            continue;
        }
        let shell = argv[0].value.clone();
        let mut fed = false;
        for r in stdin_redirects(cmd) {
            fed = true;
            match r {
                ast::IoRedirect::HereString(_, w) => match facts_quiet(&w.value, opts) {
                    Ok(f) if !f.var && !f.cmdsubst => f_push_subst(&f.value),
                    _ => out.opaque.push(format!("{shell} <<< の字が展開に依る")),
                },
                _ => out.opaque.push(format!("{shell} < file の中身は見えぬ")),
            }
        }
        if fed || i == 0 {
            continue;
        }
        let prev = &p.seq[i - 1];
        match simple_argv(prev, opts).as_deref().and_then(literal_output).or_else(|| cat_input(prev, opts)) {
            Some(text) => f_push_subst(&text),
            None => out.opaque.push(format!("{shell} へ管で流す字が見えぬ")),
        }
    }
}

fn handle_item(
    item: &ast::CommandPrefixOrSuffixItem,
    argv: &mut Vec<WordFacts>,
    assigns: &mut Vec<String>,
    out: &mut Extract,
    opts: &brush_parser::ParserOptions,
) {
    match item {
        // 代入語も**解く**。`x=$(rm -rf /)` の置換を拾わねば、代入に隠れた命が
        // 門の外を素通りする（実測 2026-08-30）。argv には入れぬ——代入は
        // 命令位置ではない——が、置換の中身は集める。
        ast::CommandPrefixOrSuffixItem::AssignmentWord(_, w) => {
            assigns.push(w.value.clone());
            if let Err(e) = word_facts(&w.value, opts) {
                out.unhandled.push(e);
            }
        }
        ast::CommandPrefixOrSuffixItem::IoRedirect(r) => handle_redirect(r, out, opts),
        ast::CommandPrefixOrSuffixItem::Word(w) => match word_facts(&w.value, opts) {
            Ok(f) => argv.push(f),
            Err(e) => out.unhandled.push(e),
        },
        // `<(…)` の中身は別の命である。**畳む。**
        //
        // 当初は「見落とした」として拒んでおったが、実物 14,120 通りで測ると
        // 拒みの半数近くがこれであった（`comm <(a) <(b)` / `diff <(x) <(y)` は
        // 日常の往来である・2026-08-30）。畳めるものを畳まずに拒むのは、
        // 門ではなくただの障害物である。
        ast::CommandPrefixOrSuffixItem::ProcessSubstitution(_, sub) => {
            walk_list(&sub.list, out, opts);
        }
    }
}

fn walk_command(c: &ast::Command, out: &mut Extract, opts: &brush_parser::ParserOptions) {
    match c {
        ast::Command::Simple(sc) => {
            let mut argv = Vec::new();
            let mut assigns = Vec::new();
            if let Some(prefix) = &sc.prefix {
                for item in &prefix.0 {
                    handle_item(item, &mut argv, &mut assigns, out, opts);
                }
            }
            if let Some(w) = &sc.word_or_name {
                match word_facts(&w.value, opts) {
                    Ok(f) => argv.push(f),
                    Err(e) => out.unhandled.push(e),
                }
            }
            if let Some(suffix) = &sc.suffix {
                for item in &suffix.0 {
                    handle_item(item, &mut argv, &mut assigns, out, opts);
                }
            }
            out.cmds.push(SimpleCmd { argv, assigns });
        }
        ast::Command::Compound(cc, redirs) => {
            if let Some(rs) = redirs {
                for r in &rs.0 {
                    handle_redirect(r, out, opts);
                }
            }
            walk_compound(cc, out, opts);
        }
        // 関数の定義そのものは命を走らせぬが、中身は後で呼ばれる。畳んでおく。
        ast::Command::Function(f) => walk_compound(&f.body.0, out, opts),
    }
}

/// `[[ … ]]` の中の語を歩く。**命は走らぬが、語は展開される。**
/// 置換（`$(…)`）を拾うのが目当てで、命令位置へは何も足さぬ。
fn walk_ext_test(
    e: &ast::ExtendedTestExpr,
    out: &mut Extract,
    opts: &brush_parser::ParserOptions,
) {
    let mut look = |w: &ast::Word| {
        if let Err(err) = word_facts(&w.value, opts) {
            out.unhandled.push(err);
        }
    };
    match e {
        ast::ExtendedTestExpr::And(a, b) | ast::ExtendedTestExpr::Or(a, b) => {
            walk_ext_test(a, out, opts);
            walk_ext_test(b, out, opts);
        }
        ast::ExtendedTestExpr::Not(a) | ast::ExtendedTestExpr::Parenthesized(a) => {
            walk_ext_test(a, out, opts)
        }
        ast::ExtendedTestExpr::UnaryTest(_, w) => look(w),
        ast::ExtendedTestExpr::BinaryTest(_, a, b) => {
            look(a);
            look(b);
        }
    }
}

fn walk_compound(
    cc: &ast::CompoundCommand,
    out: &mut Extract,
    opts: &brush_parser::ParserOptions,
) {
    match cc {
        ast::CompoundCommand::BraceGroup(bg) => walk_list(&bg.list, out, opts),
        ast::CompoundCommand::Subshell(ss) => walk_list(&ss.list, out, opts),
        ast::CompoundCommand::ForClause(f) => walk_list(&f.body.list, out, opts),
        // while/until は無名の三つ組（条件・本体・位置）である。
        ast::CompoundCommand::WhileClause(w) | ast::CompoundCommand::UntilClause(w) => {
            walk_list(&w.0, out, opts);
            walk_list(&w.1.list, out, opts);
        }
        ast::CompoundCommand::IfClause(i) => {
            walk_list(&i.condition, out, opts);
            walk_list(&i.then, out, opts);
            if let Some(elses) = &i.elses {
                for e in elses {
                    if let Some(c) = &e.condition {
                        walk_list(c, out, opts);
                    }
                    walk_list(&e.body, out, opts);
                }
            }
        }
        // `[[ … ]]` は bash の条件式であり、**命は走らぬ**。
        //
        // ただし中の語は展開される——`[[ -n $(cmd) ]]` の `cmd` は走る。
        // ゆえに語だけを解いて置換を拾い、命令位置には入れぬ。
        // 畳めぬと言うて拒めば、日常の条件式が全て止まる（実測で一件出た）。
        //
        // brush-parser の 0.4.0 の後（#1274）、`[[ ]]` は Command の一つから
        // 複合命令の一つへ移った。向き替えは Command::Compound の側で拾う。
        ast::CompoundCommand::ExtendedTest(e) => walk_ext_test(&e.expr, out, opts),
        ast::CompoundCommand::CaseClause(c) => {
            for case in &c.cases {
                if let Some(cmd) = &case.cmd {
                    walk_list(cmd, out, opts);
                }
            }
        }
        // 算術・coproc 等。**畳めぬと言う。** 黙って通せば、そこに隠れた命が
        // 門の外を素通りする。
        other => out
            .unhandled
            .push(format!("畳めぬ複合命令: {}", variant_name(other))),
    }
}

fn variant_name(c: &ast::CompoundCommand) -> &'static str {
    match c {
        ast::CompoundCommand::Arithmetic(_) => "算術 ((…))",
        ast::CompoundCommand::ArithmeticForClause(_) => "算術 for",
        _ => "その他",
    }
}

// ── JSON を手で書く。serde を入れるほどの形ではない ──

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

fn arr(items: &[String]) -> String {
    let inner: Vec<String> = items.iter().map(|s| format!("\"{}\"", esc(s))).collect();
    format!("[{}]", inner.join(","))
}

fn main() {
    // 命は標準入力から丸ごと受ける。引数で渡すと、引用が二重に剥がれる。
    let mut input = String::new();
    if std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).is_err() {
        println!("{{\"ok\":false,\"error\":\"入力を読めぬ\"}}");
        std::process::exit(0);
    }

    let opts = brush_parser::ParserOptions::default();
    let mut parser = brush_parser::Parser::new(std::io::Cursor::new(input.as_bytes()), &opts);

    let prog = match parser.parse_program() {
        Ok(p) => p,
        Err(e) => {
            // **解けぬ形は解けぬと言う。** 門はこれを拒みに変える。
            println!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e.to_string()));
            return;
        }
    };

    SUBSTS.with(|v| v.borrow_mut().clear());
    let mut out = Extract::default();
    // Program は完結した命の列である（`a; b` は二つ）。全て歩く。
    for cc in &prog.complete_commands {
        walk_list(cc, &mut out, &opts);
    }
    out.substs = SUBSTS.with(|v| v.borrow().clone());

    let cmds: Vec<String> = out
        .cmds
        .iter()
        .map(|c| {
            let words: Vec<String> = c
                .argv
                .iter()
                .map(|w| {
                    format!(
                        "{{\"text\":\"{}\",\"value\":\"{}\",\"quoted\":{},\"glob\":{},\"var\":{},\"cmdsubst\":{}}}",
                        esc(&w.text),
                        esc(&w.value),
                        w.quoted,
                        w.glob,
                        w.var,
                        w.cmdsubst
                    )
                })
                .collect();
            format!(
                "{{\"argv\":[{}],\"assigns\":{}}}",
                words.join(","),
                arr(&c.assigns)
            )
        })
        .collect();

    println!(
        "{{\"ok\":true,\"complete\":{},\"commands\":[{}],\"heredocs\":{},\"substitutions\":{},\"unhandled\":{},\"opaque\":{}}}",
        out.unhandled.is_empty(),
        cmds.join(","),
        arr(&out.heredocs),
        arr(&out.substs),
        arr(&out.unhandled),
        arr(&out.opaque)
    );
}
