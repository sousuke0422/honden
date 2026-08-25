//! 常駐する監視の芯。
//!
//!   honden-watch --path <見張る先> [--path …] -- <手> [引数…]
//!
//! 見張る先が動いたら、落ち着くのを待って手を一度呼ぶ。
//! 手は最後の行に `{"next_wake_ms": N}` を出す。芯はそれまで寝る。
//!
//! 芯は agent も pane も未読も知らない。知らせると、同じものに
//! 2 つの実装が生まれる。
//!
//! OS から借りるものは全部 `oal` 越し (core/watch/src/oal/)。

use honden_watch::oal::Native;
use honden_watch::{run_loop, Policy};
use std::path::PathBuf;
use std::time::Duration;

const USAGE: &str = "\
honden-watch — 常駐する監視の芯

  honden-watch --path <見張る先> [--path …] [旗…] -- <手> [引数…]

  --path <PATH>        見張る先。ディレクトリなら中の出入りも見る。何度でも書ける
  --lock <PATH>        二重起動を防ぐ錠。既に握られておれば走らずに終わる
  --debounce-ms <N>    書き込みが落ち着くまで待つ間 (既定 200)
  --fallback-ms <N>    手が何も言わぬ時の次の起床 (既定 300000)
  --floor-ms <N>       手を呼ぶ間隔の下限 (既定 500)
  --once               一度呼んで終わる (試験用)

手は最後の行に {\"next_wake_ms\": N} を出すと、芯はそれまで寝る。
出さねば --fallback-ms が効く。読めぬ時に「今すぐ」とは解さない。

見張る先は正本そのものではなく <正本>.signal を渡すこと。
手は正本へ書くので、正本を見張ると自分の書き込みで自分を呼ぶ。
";

fn main() {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut policy = Policy::default();
    let mut lock: Option<PathBuf> = None;
    let mut once = false;
    let mut hook: Vec<String> = Vec::new();
    let mut it = std::env::args().skip(1);

    while let Some(a) = it.next() {
        match a.as_str() {
            "--" => {
                hook.extend(it.by_ref());
                break;
            }
            "--path" => match it.next() {
                Some(v) => paths.push(PathBuf::from(v)),
                None => fail("--path に値が無い"),
            },
            "--lock" => match it.next() {
                Some(v) => lock = Some(PathBuf::from(v)),
                None => fail("--lock に値が無い"),
            },
            "--debounce-ms" => policy.debounce = ms(it.next(), "--debounce-ms"),
            "--fallback-ms" => policy.fallback = ms(it.next(), "--fallback-ms"),
            "--floor-ms" => policy.floor = ms(it.next(), "--floor-ms"),
            "--once" => once = true,
            "-h" | "--help" => fail(""),
            other => fail(&format!("知らぬ旗: {other}")),
        }
    }

    if paths.is_empty() {
        fail("--path が無い。何を見張るのか分からぬ");
    }
    if hook.is_empty() {
        fail("-- の後に手が無い。何を呼ぶのか分からぬ");
    }

    let limit = if once { Some(1) } else { None };
    match run_loop(&Native, &paths, &hook, policy, lock.as_deref(), limit) {
        Ok(_) => {}
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

/// 使い方を出して終わる。空文字なら --help ゆえ 0 で終わる。
fn fail(msg: &str) -> ! {
    if !msg.is_empty() {
        eprintln!("{msg}\n");
    }
    eprint!("{USAGE}");
    std::process::exit(if msg.is_empty() { 0 } else { 2 });
}

fn ms(v: Option<String>, name: &str) -> Duration {
    let s = match v {
        Some(s) => s,
        None => fail(&format!("{name} に値が無い")),
    };
    match s.parse::<u64>() {
        Ok(n) => Duration::from_millis(n),
        Err(_) => fail(&format!("{name} は数で書かれよ: {s}")),
    }
}
