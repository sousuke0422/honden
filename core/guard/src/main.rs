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
    text: String,
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
}

/// 語を解いて素性を得る。
///
/// **解けなんだ語は `Err`。** probe の写しは `Err(_) => {}` と既定値を返しておった
/// ——それは「引用されておらぬ・glob 無し・変数無し」と**嘘をつく**に等しい。
/// 新しい層は fail-open として生まれる。生まれた時に塞ぐ。
fn word_facts(raw: &str, opts: &brush_parser::ParserOptions) -> Result<WordFacts, String> {
    use brush_parser::word::WordPiece as P;
    let pieces = brush_parser::word::parse(raw, opts)
        .map_err(|e| format!("語を解けぬ（{raw}）: {e}"))?;

    let mut f = WordFacts { text: raw.to_string(), ..Default::default() };
    // 空の語（`""`）は「引用されておる」と見る——命令位置には立てぬゆえ。
    let mut all_quoted = true;
    for pw in &pieces {
        match &pw.piece {
            // 引用された中身。ここに何が入っておっても命ではない。
            P::SingleQuotedText(_) | P::AnsiCQuotedText(_) | P::DoubleQuotedSequence(_) => {}
            P::CommandSubstitution(s) => {
                f.cmdsubst = true;
                all_quoted = false;
                f_push_subst(s);
            }
            P::BackquotedCommandSubstitution(s) => {
                f.cmdsubst = true;
                all_quoted = false;
                f_push_subst(s);
            }
            P::ParameterExpansion(_) => {
                f.var = true;
                all_quoted = false;
            }
            P::Text(t) => {
                if t.contains('*') || t.contains('?') || t.contains('[') {
                    f.glob = true;
                }
                all_quoted = false;
            }
            _ => all_quoted = false,
        }
    }
    f.quoted = all_quoted && !pieces.is_empty();
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
}

fn handle_redirect(r: &ast::IoRedirect, out: &mut Extract) {
    if let ast::IoRedirect::HereDocument(_, hd) = r {
        out.heredocs.push(hd.doc.value.clone());
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
        ast::CommandPrefixOrSuffixItem::AssignmentWord(_, w) => assigns.push(w.value.clone()),
        ast::CommandPrefixOrSuffixItem::IoRedirect(r) => handle_redirect(r, out),
        ast::CommandPrefixOrSuffixItem::Word(w) => match word_facts(&w.value, opts) {
            Ok(f) => argv.push(f),
            Err(e) => out.unhandled.push(e),
        },
        // `<(…)` の中身は別の命である。畳まずに「見落とした」と言う。
        ast::CommandPrefixOrSuffixItem::ProcessSubstitution(_, _) => {
            out.unhandled.push("プロセス置換 <(…) の中身は畳んでおらぬ".into());
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
                    handle_redirect(r, out);
                }
            }
            walk_compound(cc, out, opts);
        }
        // 関数の定義そのものは命を走らせぬが、中身は後で呼ばれる。畳んでおく。
        ast::Command::Function(f) => walk_compound(&f.body.0, out, opts),
        // `[[ … ]]` は命を走らせぬ（bash の条件式）。畳めぬが害も無い——
        // ただし**黙って捨てぬ**。見落としとして数える。
        ast::Command::ExtendedTest(_, _) => {
            out.unhandled.push("拡張テスト [[ … ]] は畳んでおらぬ".into());
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
                        "{{\"text\":\"{}\",\"quoted\":{},\"glob\":{},\"var\":{},\"cmdsubst\":{}}}",
                        esc(&w.text),
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
        "{{\"ok\":true,\"complete\":{},\"commands\":[{}],\"heredocs\":{},\"substitutions\":{},\"unhandled\":{}}}",
        out.unhandled.is_empty(),
        cmds.join(","),
        arr(&out.heredocs),
        arr(&out.substs),
        arr(&out.unhandled)
    );
}
