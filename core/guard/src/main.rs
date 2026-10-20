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
#[derive(Clone, Default)]
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
    /// 標準入力の出所。門が git apply・patch の patch を読むのに使う
    stdin: Stdin,
    /// この命が script として走らせる file（`bash x.sh`・`source x.sh`・`. x.sh`・`bash <(cat x.sh)`）。
    /// 門が file を読み、中身を命として判ずる
    script: Option<Script>,
}

/// script の file の道。道に展開が在れば dynamic（門は `$HOME` の類だけを解き、他は拒む）。
struct Script {
    path: String,
    dynamic: bool,
    /// `source`・`.` で読み込む（`/` の無い道は PATH の上からも探される）
    sourced: bool,
    /// process 置換（`<(cat f)`）から読む。中身は標準入力で流すのと同じく、門が必ず判ずる
    proc: bool,
    /// 門が中身を shell の命として解ける shell か（csh・tcsh・fish は否）
    posix: bool,
}

/// 命の語の並び。process 置換（`<(…)`）は argv から落ちるゆえ、script の位置を見るために残す。
enum Op<'a> {
    Word(WordFacts),
    Proc(&'a ast::CompoundList),
}

/// 門が中身を shell の命として解ける shell。csh・tcsh・fish は書きざまが違い、解けぬ
fn is_posix_shell(name: &str) -> bool {
    is_shell(name) && !matches!(name.rsplit('/').next().unwrap_or(name), "csh" | "tcsh" | "fish" | "busybox")
}

/// script を走らせる命なら、script の語の位置を返す。
///
/// `source f`・`. f` は一つ目の引数。shell は旗の後ろの、旗でない一つ目の引数。`-c` の束は引数の
/// 字を走らせ（門は別の道で降りる）、`-n` の束は読むだけで走らせず、`-s` は標準入力を読む。
/// 値を取る旗（`-o pipefail`・`-O extglob`・`--rcfile f`・`--init-file f`）の値は file ではない。
/// script の後ろの語（`bash x.sh --flag`）は script への引数である。
fn script_index(ops: &[WordFacts]) -> Option<usize> {
    let head = ops.first()?;
    let name = base(&head.value);
    if name == "source" || name == "." {
        let mut i = 1;
        if ops.get(i).map(|w| w.value.as_str()) == Some("--") {
            i += 1;
        }
        return if i < ops.len() { Some(i) } else { None };
    }
    if !is_shell(&head.value) {
        return None;
    }
    let mut i = 1;
    if name == "busybox" {
        match ops.get(1) {
            Some(w) if is_shell(&w.value) && w.value != "busybox" => i = 2,
            _ => return None,
        }
    }
    while i < ops.len() {
        let v = ops[i].value.as_str();
        if v == "--" {
            i += 1;
            break;
        }
        if v == "-s" {
            return None;
        }
        if v.len() <= 5 && v.starts_with('-') && !v.starts_with("--") && (v[1..].contains('c') || v[1..].contains('n') || v[1..].contains('s')) {
            return None;
        }
        let short = (v.starts_with('-') || v.starts_with('+')) && !v.starts_with("--") && v.len() > 1;
        if (short && (v[1..].contains('o') || v[1..].contains('O'))) || v == "--rcfile" || v == "--init-file" {
            i += 2;
            continue;
        }
        if v.starts_with('-') || v.starts_with('+') {
            i += 1;
            continue;
        }
        break;
    }
    if i < ops.len() { Some(i) } else { None }
}

/// `<(…)` の中身が書き出す字の出所。命が一つだけなら管の前の段と同じに読む。
fn proc_source(list: &ast::CompoundList, opts: &brush_parser::ParserOptions) -> Stdin {
    if list.0.len() != 1 {
        return Stdin::Opaque;
    }
    let and_or = &list.0[0].0;
    if !and_or.additional.is_empty() || and_or.first.seq.len() != 1 {
        return Stdin::Opaque;
    }
    pipe_source(&and_or.first.seq[0], opts)
}

/// script を走らせる命の script を見る。file なら道を返し、字が見えれば置換と同じ群れへ渡し、
/// 見えねば opaque に挙げる。
fn script_of(ops: &[Op], out: &mut Extract, opts: &brush_parser::ParserOptions) -> Option<Script> {
    // process 置換は印の語に替えて、包み（timeout・env の類）を剥がす。印の値は命の字に出ぬ
    let marks: Vec<WordFacts> = ops
        .iter()
        .enumerate()
        .map(|(n, o)| match o {
            Op::Word(w) => w.clone(),
            Op::Proc(_) => WordFacts {
                text: String::new(),
                value: format!("\u{1}proc{n}"),
                quoted: false,
                glob: false,
                var: false,
                cmdsubst: false,
            },
        })
        .collect();
    let inner = peel(&marks);
    let k = script_index(inner)?;
    // `busybox sh x.sh` は二つ目の語が shell の名である
    let shell = if base(&inner[0].value) == "busybox" { &inner[1] } else { &inner[0] };
    let name = base(&shell.value).to_string();
    let posix = name == "source" || name == "." || is_posix_shell(&shell.value);
    let w = &inner[k];
    if let Some(n) = w.value.strip_prefix("\u{1}proc").and_then(|n| n.parse::<usize>().ok()) {
        let Some(Op::Proc(list)) = ops.get(n) else { return None };
        if !posix {
            out.opaque.push(format!("{name} が process 置換から読む script は門が解けぬ"));
            return None;
        }
        match proc_source(list, opts) {
            Stdin::Text(t) => f_push_subst(&t),
            Stdin::File(f) => return Some(Script { path: f, dynamic: false, sourced: name == "source" || name == ".", proc: true, posix }),
            _ => out.opaque.push(format!("{name} が process 置換から読む script の字が見えぬ")),
        }
        return None;
    }
    Some(Script {
        path: w.value.clone(),
        dynamic: w.var || w.cmdsubst,
        sourced: name == "source" || name == ".",
        proc: false,
        posix,
    })
}

/// 単純命令の標準入力の出所。
#[derive(Clone, Default)]
enum Stdin {
    /// 端末か、何も繋がっておらぬ
    #[default]
    None,
    /// `< file`・`cat file |`。file の道
    File(String),
    /// heredoc・here-string・字どおり読める echo や printf の管
    Text(String),
    /// 中身が見えぬ（展開に依る、読めぬ命の管）
    Opaque,
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
    /// 向き替えで書く先（`>`・`>>`・`>|`・`<>`）。同じ命の中で作られる file を門が知るため
    writes: Vec<String>,
    /// shell が標準入力から命として読む file の道（`bash < f`・`cat f | sh`・`ssh h 'bash -s' < f`）。
    /// 門が file を読んで中身を命として判ずる。読めねば門が拒む
    shell_files: Vec<String>,
    /// heredoc の本文を `cat > f` で書く file と、その本文（`cat > f <<'EOF' … EOF`）。
    /// 同じ命の中で書いてから走らせる script の中身を、門がこの本文で判ずるため
    written_texts: Vec<(String, String)>,
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

/// `$'…'` の中身の逃がしを、bash と同じく解く。
///
/// `\a \b \e \E \f \n \r \t \v \\ \' \" \?`、8 進（`\NNN` の一〜三字）、16 進（`\xHH` の一〜二字）、
/// `\uHHHH`・`\UHHHHHHHH`、`\cX`（制御の字）。知らぬ逃がしは逆斜線ごと残す（bash と同じ）。
fn decode_ansi_c(t: &str) -> String {
    let cs: Vec<char> = t.chars().collect();
    let mut out = String::with_capacity(t.len());
    let mut i = 0;
    let digits = |cs: &[char], from: usize, max: usize, radix: u32| -> (u32, usize) {
        let mut v = 0u32;
        let mut n = 0;
        while n < max && from + n < cs.len() {
            match cs[from + n].to_digit(radix) {
                Some(d) => {
                    v = v * radix + d;
                    n += 1;
                }
                None => break,
            }
        }
        (v, n)
    };
    while i < cs.len() {
        let c = cs[i];
        if c != '\\' || i + 1 >= cs.len() {
            out.push(c);
            i += 1;
            continue;
        }
        let e = cs[i + 1];
        i += 2;
        let simple = match e {
            'a' => Some('\u{7}'),
            'b' => Some('\u{8}'),
            'e' | 'E' => Some('\u{1b}'),
            'f' => Some('\u{c}'),
            'n' => Some('\n'),
            'r' => Some('\r'),
            't' => Some('\t'),
            'v' => Some('\u{b}'),
            '\\' => Some('\\'),
            '\'' => Some('\''),
            '"' => Some('"'),
            '?' => Some('?'),
            _ => None,
        };
        if let Some(ch) = simple {
            out.push(ch);
            continue;
        }
        match e {
            '0'..='7' => {
                let (v, n) = digits(&cs, i - 1, 3, 8);
                i = i - 1 + n;
                out.push(char::from_u32(v & 0xff).unwrap_or('\u{fffd}'));
            }
            'x' => {
                let (v, n) = digits(&cs, i, 2, 16);
                if n == 0 {
                    out.push_str("\\x");
                } else {
                    i += n;
                    out.push(char::from_u32(v).unwrap_or('\u{fffd}'));
                }
            }
            'u' | 'U' => {
                let (v, n) = digits(&cs, i, if e == 'u' { 4 } else { 8 }, 16);
                if n == 0 {
                    out.push('\\');
                    out.push(e);
                } else {
                    i += n;
                    out.push(char::from_u32(v).unwrap_or('\u{fffd}'));
                }
            }
            'c' if i < cs.len() => {
                let x = cs[i];
                i += 1;
                out.push(char::from_u32((x.to_ascii_uppercase() as u32) ^ 0x40).unwrap_or('\u{fffd}'));
            }
            _ => {
                out.push('\\');
                out.push(e);
            }
        }
    }
    out
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
            P::SingleQuotedText(t) => value.push_str(t),
            // `$'…'` の中の逃がしは、bash が解いた字が値である。`$'\162m'` は `rm`、
            // `$'\x2f'` は `/`。解かずに残すと、命の名と道が字のまま残る
            P::AnsiCQuotedText(t) => value.push_str(&decode_ansi_c(t)),
            P::DoubleQuotedSequence(inner) => {
                for ipw in inner {
                    match &ipw.piece {
                        P::Text(t) => value.push_str(t),
                        P::CommandSubstitution(s) | P::BackquotedCommandSubstitution(s) => {
                            // 引用の中でも置換は走る。中身を渡し、印も立てる。
                            // 値には書かれたまま残す（引用の外と同じ）。落とすと、字を解き
                            // 直した時に頭の展開が見えず、`sh -c "$(…)"` を命の無い字と読む
                            f.cmdsubst = true;
                            f_push_subst(s);
                            value.push_str(src(raw, ipw));
                        }
                        P::ParameterExpansion(_) => {
                            f.var = true;
                            value.push_str(src(raw, ipw));
                        }
                        // 二重引用の中の `\$` `\"` 等。逃がした字そのものが値である
                        P::EscapeSequence(e) => value.push_str(unescape(e)),
                        _ => value.push_str(src(raw, ipw)),
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
    for (i, cmd) in p.seq.iter().enumerate() {
        let before = out.cmds.len();
        walk_command(cmd, out, opts);
        // 単純命令は、中の置換の命より後に積まれる。管の段の命は最後の一つである
        if i > 0 && matches!(cmd, ast::Command::Simple(_)) && out.cmds.len() > before {
            let last = out.cmds.len() - 1;
            if matches!(out.cmds[last].stdin, Stdin::None) {
                out.cmds[last].stdin = pipe_source(&p.seq[i - 1], opts);
            }
        }
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
        // 書く先を控える（同じ命の中で patch の file を作って当てる形を、門が見分けるため）
        ast::IoRedirect::File(
            _,
            ast::IoFileRedirectKind::Write
            | ast::IoFileRedirectKind::Append
            | ast::IoFileRedirectKind::Clobber
            | ast::IoFileRedirectKind::ReadAndWrite,
            ast::IoFileRedirectTarget::Filename(w),
        ) => {
            if let Ok(f) = facts_quiet(&w.value, opts) {
                out.writes.push(f.value);
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
    matches!(
        base,
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "ash" | "mksh" | "busybox" | "csh" | "tcsh" | "fish"
            | "posh" | "yash" | "rbash" | "pdksh" | "oksh"
    )
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
        // 値を取る旗。`-euo pipefail` のように束の中に `o` が在れば、次の語は値である
        // （script の file ではない）。束の後ろの名を file と読むと、標準入力へ流す形を
        // 通してしまう
        let short = (v.starts_with('-') || v.starts_with('+')) && !v.starts_with("--") && v.len() > 1;
        if (short && (v[1..].contains('o') || v[1..].contains('O'))) || v == "--rcfile" || v == "--init-file" {
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
            // `echo -e` は `\n` を改行に直す。dash の echo は旗が無くても直す。直さずに
            // 一行と読むと、改行の後ろの命が通る。直す側へ倒す
            Some(args.join(" ").replace("\\n", "\n"))
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
            match item {
                ast::CommandPrefixOrSuffixItem::Word(w) | ast::CommandPrefixOrSuffixItem::AssignmentWord(_, w) => {
                    argv.push(facts_quiet(&w.value, opts).ok()?);
                }
                _ => {}
            }
        }
    }
    Some(argv)
}

fn base(v: &str) -> &str {
    v.rsplit('/').next().unwrap_or(v)
}

/// 命を包む命を剥がし、中の命の argv を返す（`timeout 5 sh` の `sh`）。
///
/// 包みごとに値を取る旗と、命の前の位置引数の数を書く（src/parse.ts の WRAP と同じ流儀）。
/// 包みの後に命が無ければ空を返す。`command -v` のように命を走らせぬ形も空を返す。
fn peel(mut argv: &[WordFacts]) -> &[WordFacts] {
    loop {
        let Some(h) = argv.first() else { return argv };
        let name = base(&h.value);
        let (vals, pos): (&[&str], usize) = match name {
            "env" => (&["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], 0),
            "exec" => (&["-a"], 0),
            "nice" => (&["-n", "--adjustment"], 0),
            "ionice" => (&["-c", "-n", "-p", "-P", "-u"], 0),
            "timeout" => (&["-s", "--signal", "-k", "--kill-after"], 1),
            "command" | "nohup" | "setsid" | "unbuffer" | "builtin" => (&[], 0),
            "stdbuf" => (&["-i", "-o", "-e"], 0),
            "time" => (&["-f", "--format", "-o", "--output"], 0),
            "chrt" | "taskset" => (&[], 1),
            "flock" => (&["-w", "--timeout", "-E", "--conflict-exit-code"], 1),
            "doas" => (&["-u"], 0),
            _ => return argv,
        };
        if name == "command" && argv[1..].iter().any(|w| w.value == "-v" || w.value == "-V") {
            return &[];
        }
        let mut i = 1;
        let mut pos = pos;
        while i < argv.len() {
            let v = argv[i].value.as_str();
            if v == "--" {
                i += 1;
                break;
            }
            if name == "env" && !v.starts_with('-') && v.contains('=') {
                i += 1;
                continue;
            }
            if v.starts_with('-') && v.len() > 1 {
                i += if vals.contains(&v) { 2 } else { 1 };
                continue;
            }
            if pos > 0 {
                pos -= 1;
                i += 1;
                continue;
            }
            break;
        }
        if i >= argv.len() {
            return &[];
        }
        argv = &argv[i..];
    }
}

/// 一つの語に空白で繋がれた命（`ssh h 'bash -s'`）を、語の列に開く。
fn split_words(w: &WordFacts) -> Vec<WordFacts> {
    w.value
        .split_whitespace()
        .map(|t| WordFacts { text: t.to_string(), value: t.to_string(), ..Default::default() })
        .collect()
}

/// 遠方・箱の中で走る命の argv（ssh・docker/podman exec・kubectl exec）。標準入力を中へ
/// 渡す形の時だけ返す（docker と podman は `-i`、kubectl は `-i` か `--stdin`）。
fn remote_inner(argv: &[WordFacts]) -> Option<Vec<WordFacts>> {
    let name = base(&argv.first()?.value);
    let vals_ssh = ["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"];
    let vals_docker = ["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys"];
    let vals_kube = ["-c", "--container", "-n", "--namespace", "--context", "--kubeconfig", "-f", "--filename"];
    let (start, vals, interactive_needed): (usize, &[&str], bool) = match name {
        "ssh" => (1, &vals_ssh, false),
        "docker" | "podman" if argv.get(1).map(|w| w.value.as_str()) == Some("exec") => (2, &vals_docker, true),
        "kubectl" if argv.get(1).map(|w| w.value.as_str()) == Some("exec") => (2, &vals_kube, true),
        _ => return None,
    };
    let mut interactive = false;
    let mut i = start;
    while i < argv.len() {
        let v = argv[i].value.as_str();
        if v == "--" {
            break;
        }
        if v.starts_with('-') && v.len() > 1 {
            if v == "--interactive" || v == "--stdin" || (!v.starts_with("--") && v[1..].contains('i') && name != "ssh") {
                interactive = true;
            }
            i += if vals.contains(&v) { 2 } else { 1 };
            continue;
        }
        break;
    }
    // ここに箱・pod・host の名が在る
    i += 1;
    if argv.get(i).map(|w| w.value.as_str()) == Some("--") {
        i += 1;
    }
    if interactive_needed && !interactive {
        return None;
    }
    let rest = argv.get(i..)?;
    if rest.len() == 1 {
        return Some(split_words(&rest[0]));
    }
    Some(rest.iter().map(|w| WordFacts { text: w.text.clone(), value: w.value.clone(), ..Default::default() }).collect())
}

/// 標準入力から命を読む shell が、この argv の中で走るか。走るなら shell の名を返す。
/// `xargs sh` は流した字が shell の引数になり、何が走るか字では見えぬ。`Err` で返す。
fn stdin_shell(argv: &[WordFacts]) -> Option<Result<String, String>> {
    let head = base(&argv.first()?.value);
    if head == "xargs" {
        let found = argv[1..].iter().any(|w| is_shell(&w.value));
        return if found { Some(Err("xargs で shell へ流す字が見えぬ".to_string())) } else { None };
    }
    let inner = peel(argv);
    if let Some(remote) = remote_inner(inner) {
        let r = peel(&remote);
        return if reads_stdin_script(r) { Some(Ok(format!("{} の中の {}", base(&inner[0].value), r[0].value))) } else { None };
    }
    if reads_stdin_script(inner) {
        return Some(Ok(inner[0].value.clone()));
    }
    None
}

/// 管の一段の中で、管から標準入力を受けうる単純命令を集める。
/// 単純命令ならそれ自身。`{ …; }`・`( … )`・if・while・for の中なら、各々の連なりの
/// 頭の段（管の頭）を集める。中で自ら向き替えを持つ物は、管の字を受けぬ。
fn stdin_receivers<'a>(c: &'a ast::Command, out: &mut Vec<&'a ast::Command>) {
    match c {
        ast::Command::Simple(_) => out.push(c),
        ast::Command::Compound(cc, redirs) => {
            if redirs.as_ref().is_some_and(|r| !r.0.is_empty()) {
                return;
            }
            let mut lists: Vec<&ast::CompoundList> = Vec::new();
            match cc {
                ast::CompoundCommand::BraceGroup(bg) => lists.push(&bg.list),
                ast::CompoundCommand::Subshell(ss) => lists.push(&ss.list),
                ast::CompoundCommand::ForClause(f) => lists.push(&f.body.list),
                ast::CompoundCommand::WhileClause(w) | ast::CompoundCommand::UntilClause(w) => {
                    lists.push(&w.0);
                    lists.push(&w.1.list);
                }
                ast::CompoundCommand::IfClause(i) => {
                    lists.push(&i.condition);
                    lists.push(&i.then);
                    if let Some(elses) = &i.elses {
                        for e in elses {
                            if let Some(cond) = &e.condition {
                                lists.push(cond);
                            }
                            lists.push(&e.body);
                        }
                    }
                }
                _ => {}
            }
            for l in lists {
                for item in &l.0 {
                    let mut pipes = vec![&item.0.first];
                    for a in &item.0.additional {
                        match a {
                            ast::AndOr::And(p) | ast::AndOr::Or(p) => pipes.push(p),
                        }
                    }
                    for p in pipes {
                        if let Some(first) = p.seq.first() {
                            stdin_receivers(first, out);
                        }
                    }
                }
            }
        }
        ast::Command::Function(_) => {}
    }
}

/// 管の前の段が書き出す字の出所。
fn pipe_source(prev: &ast::Command, opts: &brush_parser::ParserOptions) -> Stdin {
    if let Some(argv) = simple_argv(prev, opts) {
        if let Some(t) = literal_output(&argv) {
            return Stdin::Text(t);
        }
        // `cat file |`。file の道を渡す（門が patch を読むため）
        if argv.len() == 2 && base(&argv[0].value) == "cat" && !argv[1].var && !argv[1].cmdsubst && !argv[1].value.starts_with('-') {
            return Stdin::File(argv[1].value.clone());
        }
    }
    match cat_input(prev, opts) {
        Some(t) => Stdin::Text(t),
        None => Stdin::Opaque,
    }
}

/// `cat > f <<'EOF' … EOF` の形なら、書く先と本文を返す。`cat` に引数が無く、標準入力が heredoc か
/// here-string で、標準出力の向き替えが `>`（`>>` でない）の一つだけの時に限る。
fn heredoc_write(c: &ast::Command, argv: &[WordFacts], stdin: &Stdin, opts: &brush_parser::ParserOptions) -> Option<(String, String)> {
    if argv.len() != 1 || base(&argv[0].value) != "cat" {
        return None;
    }
    let Stdin::Text(text) = stdin else { return None };
    let ast::Command::Simple(sc) = c else { return None };
    let items = sc.prefix.iter().flat_map(|p| p.0.iter()).chain(sc.suffix.iter().flat_map(|s| s.0.iter()));
    let mut target = None;
    for item in items {
        if let ast::CommandPrefixOrSuffixItem::IoRedirect(ast::IoRedirect::File(fd, kind, t)) = item {
            if fd.is_some_and(|f| f != 1) {
                continue;
            }
            match (kind, t) {
                (ast::IoFileRedirectKind::Write | ast::IoFileRedirectKind::Clobber, ast::IoFileRedirectTarget::Filename(w)) if target.is_none() => {
                    let f = facts_quiet(&w.value, opts).ok()?;
                    if f.var || f.cmdsubst {
                        return None;
                    }
                    target = Some(f.value);
                }
                (ast::IoFileRedirectKind::Read, _) => {}
                _ => return None,
            }
        }
    }
    Some((target?, text.clone()))
}

/// 単純命令が自ら持つ標準入力の向き替え（`<` の file・heredoc・here-string）。
fn own_stdin(c: &ast::Command, opts: &brush_parser::ParserOptions) -> Stdin {
    let ast::Command::Simple(sc) = c else { return Stdin::None };
    let items = sc.prefix.iter().flat_map(|p| p.0.iter()).chain(sc.suffix.iter().flat_map(|s| s.0.iter()));
    let mut got = Stdin::None;
    for item in items {
        if let ast::CommandPrefixOrSuffixItem::IoRedirect(r) = item {
            got = match r {
                ast::IoRedirect::HereDocument(fd, hd) if fd.map_or(true, |f| f == 0) => Stdin::Text(hd.doc.value.clone()),
                ast::IoRedirect::HereString(fd, w) if fd.map_or(true, |f| f == 0) => match facts_quiet(&w.value, opts) {
                    Ok(f) if !f.var && !f.cmdsubst => Stdin::Text(f.value),
                    _ => Stdin::Opaque,
                },
                ast::IoRedirect::File(fd, ast::IoFileRedirectKind::Read, target) if fd.map_or(true, |f| f == 0) => match target {
                    ast::IoFileRedirectTarget::Filename(w) => match facts_quiet(&w.value, opts) {
                        Ok(f) if !f.var && !f.cmdsubst => Stdin::File(f.value),
                        _ => Stdin::Opaque,
                    },
                    _ => Stdin::Opaque,
                },
                _ => continue,
            };
        }
    }
    got
}

/// shell が標準入力から読む命を、字どおり読めれば置換と同じ群れへ渡し、読めねば
/// opaque に挙げる。
///
/// 門は置換の中身を命として解いて判ずる。`echo kill | sh` の `kill`、
/// `sh <<<"kill 1"` の `kill 1` は、置換と同じく後で走る命である。
fn shell_stdin(p: &ast::Pipeline, out: &mut Extract, opts: &brush_parser::ParserOptions) {
    for (i, stage) in p.seq.iter().enumerate() {
        let mut receivers = Vec::new();
        stdin_receivers(stage, &mut receivers);
        for cmd in receivers {
            let Some(argv) = simple_argv(cmd, opts) else { continue };
            let shell = match stdin_shell(&argv) {
                None => continue,
                Some(Err(why)) => {
                    out.opaque.push(why);
                    continue;
                }
                Some(Ok(shell)) => shell,
            };
            let src = match own_stdin(cmd, opts) {
                Stdin::None if i == 0 => continue,
                Stdin::None => pipe_source(&p.seq[i - 1], opts),
                other => other,
            };
            match src {
                Stdin::Text(t) => f_push_subst(&t),
                Stdin::File(f) => out.shell_files.push(f),
                Stdin::Opaque => out.opaque.push(format!("{shell} へ流す字が見えぬ")),
                Stdin::None => {}
            }
        }
    }
}

fn handle_item(
    item: &ast::CommandPrefixOrSuffixItem,
    argv: &mut Vec<WordFacts>,
    assigns: &mut Vec<String>,
    out: &mut Extract,
    opts: &brush_parser::ParserOptions,
    after_name: bool,
) {
    match item {
        // **命の名より後の `NAME=値` は、代入ではなく引数である。** `dd of=/dev/sda`・
        // `export A=1` の `of=…`・`A=1` は命へ渡る。代入と取って argv から落とすと、
        // 掟が見る字から消える（bash の物差しが見つけた読み違い）
        ast::CommandPrefixOrSuffixItem::AssignmentWord(_, w) if after_name => match word_facts(&w.value, opts) {
            Ok(f) => argv.push(f),
            Err(e) => out.unhandled.push(e),
        },
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
                    handle_item(item, &mut argv, &mut assigns, out, opts, false);
                }
            }
            if let Some(w) = &sc.word_or_name {
                match word_facts(&w.value, opts) {
                    Ok(f) => argv.push(f),
                    Err(e) => out.unhandled.push(e),
                }
            }
            // script の位置を見るための語の並び。process 置換は argv から落ちるゆえ別に持つ
            let mut ops: Vec<Op> = argv.iter().cloned().map(Op::Word).collect();
            if let Some(suffix) = &sc.suffix {
                for item in &suffix.0 {
                    let before = argv.len();
                    handle_item(item, &mut argv, &mut assigns, out, opts, true);
                    if let ast::CommandPrefixOrSuffixItem::ProcessSubstitution(_, sub) = item {
                        ops.push(Op::Proc(&sub.list));
                    }
                    for w in &argv[before..] {
                        ops.push(Op::Word(w.clone()));
                    }
                }
            }
            let stdin = own_stdin(c, opts);
            if let Some(w) = heredoc_write(c, &argv, &stdin, opts) {
                out.written_texts.push(w);
            }
            let script = script_of(&ops, out, opts);
            out.cmds.push(SimpleCmd { argv, assigns, stdin, script });
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
            let stdin = match &c.stdin {
                Stdin::None => "null".to_string(),
                Stdin::File(f) => format!("{{\"file\":\"{}\"}}", esc(f)),
                Stdin::Text(t) => format!("{{\"text\":\"{}\"}}", esc(t)),
                Stdin::Opaque => "{\"opaque\":true}".to_string(),
            };
            let script = match &c.script {
                None => "null".to_string(),
                Some(s) => format!(
                    "{{\"path\":\"{}\",\"dynamic\":{},\"sourced\":{},\"proc\":{},\"posix\":{}}}",
                    esc(&s.path),
                    s.dynamic,
                    s.sourced,
                    s.proc,
                    s.posix
                ),
            };
            format!(
                "{{\"argv\":[{}],\"assigns\":{},\"stdin\":{},\"script\":{}}}",
                words.join(","),
                arr(&c.assigns),
                stdin,
                script
            )
        })
        .collect();

    println!(
        "{{\"ok\":true,\"complete\":{},\"commands\":[{}],\"heredocs\":{},\"substitutions\":{},\"unhandled\":{},\"opaque\":{},\"writes\":{},\"shell_files\":{},\"written_texts\":[{}]}}",
        out.unhandled.is_empty(),
        cmds.join(","),
        arr(&out.heredocs),
        arr(&out.substs),
        arr(&out.unhandled),
        arr(&out.opaque),
        arr(&out.writes),
        arr(&out.shell_files),
        out.written_texts
            .iter()
            .map(|(p, t)| format!("{{\"path\":\"{}\",\"text\":\"{}\"}}", esc(p), esc(t)))
            .collect::<Vec<_>>()
            .join(",")
    );
}
