//! 常駐する監視の芯。
//!
//!   honden-watch --path <見張る先> [--path …] -- <手> [引数…]
//!
//! 見張る先が動いたら、落ち着くのを待って手を一度呼ぶ。
//! 手は最後の行に `{"next_wake_ms": N}` を出す。芯はそれまで寝る。
//!
//! 芯は agent も pane も未読も知らない。知らせると、同じものに
//! 2 つの実装が生まれる。

mod sys;

use honden_watch::{parse_next_wake, Policy, Scheduler, Step};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

const USAGE: &str = "\
honden-watch — 常駐する監視の芯

  honden-watch --path <見張る先> [--path …] [旗…] -- <手> [引数…]

  --path <PATH>        見張る先。ディレクトリなら中の出入りも見る。何度でも書ける
  --debounce-ms <N>    書き込みが落ち着くまで待つ間 (既定 200)
  --fallback-ms <N>    手が何も言わぬ時の次の起床 (既定 300000)
  --floor-ms <N>       手を呼ぶ間隔の下限 (既定 500)
  --once               一度呼んで終わる (試験用)

手は最後の行に {\"next_wake_ms\": N} を出すと、芯はそれまで寝る。
出さねば --fallback-ms が効く。読めぬ時に「今すぐ」とは解さない。
";

struct Args {
    paths: Vec<PathBuf>,
    policy: Policy,
    once: bool,
    hook: Vec<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut paths = Vec::new();
    let mut policy = Policy::default();
    let mut once = false;
    let mut hook = Vec::new();
    let mut it = std::env::args().skip(1);

    while let Some(a) = it.next() {
        match a.as_str() {
            "--" => {
                hook.extend(it.by_ref());
                break;
            }
            "--path" => paths.push(PathBuf::from(it.next().ok_or("--path に値が無い")?)),
            "--debounce-ms" => policy.debounce = ms(it.next(), "--debounce-ms")?,
            "--fallback-ms" => policy.fallback = ms(it.next(), "--fallback-ms")?,
            "--floor-ms" => policy.floor = ms(it.next(), "--floor-ms")?,
            "--once" => once = true,
            "-h" | "--help" => return Err(String::new()),
            other => return Err(format!("知らぬ旗: {other}")),
        }
    }

    if paths.is_empty() {
        return Err("--path が無い。何を見張るのか分からぬ".into());
    }
    if hook.is_empty() {
        return Err("-- の後に手が無い。何を呼ぶのか分からぬ".into());
    }
    Ok(Args { paths, policy, once, hook })
}

fn ms(v: Option<String>, name: &str) -> Result<Duration, String> {
    let s = v.ok_or_else(|| format!("{name} に値が無い"))?;
    s.parse::<u64>().map(Duration::from_millis).map_err(|_| format!("{name} は数で書かれよ: {s}"))
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("{e}\n");
            }
            eprint!("{USAGE}");
            std::process::exit(if e.is_empty() { 0 } else { 2 });
        }
    };

    let ino = match sys::Inotify::new() {
        Ok(i) => i,
        Err(e) => {
            eprintln!("inotify を開けぬ: {e}");
            std::process::exit(1);
        }
    };

    // ディレクトリを見張ると、中の出入りも拾える。
    //
    // SQLite の WAL は checkpoint で作り直されるので、ファイルだけを
    // 見張ると番号が古くなって黙る。親を見るのが確実になる。
    let mask = sys::IN_MODIFY
        | sys::IN_CLOSE_WRITE
        | sys::IN_MOVED_TO
        | sys::IN_CREATE
        | sys::IN_DELETE_SELF
        | sys::IN_MOVE_SELF;
    let mut watched = 0;
    for p in &args.paths {
        match ino.add(p, mask) {
            Ok(_) => watched += 1,
            Err(e) => eprintln!("見張れぬ: {} ({e})", p.display()),
        }
    }
    if watched == 0 {
        eprintln!("見張れる先が一つも無い。");
        std::process::exit(1);
    }

    let mut sched = Scheduler::new(args.policy.clone());
    loop {
        let now = Instant::now();
        match sched.step(now) {
            Step::Run => {
                let next = run_hook(&args.hook);
                sched.ran(Instant::now(), next);
                if args.once {
                    return;
                }
            }
            Step::Wait(d) => {
                // 待っている間に書き込みが来れば、そこで起きる。
                let timeout = d.map(|d| d.as_millis().min(i32::MAX as u128) as i32).unwrap_or(-1);
                match ino.wait(timeout) {
                    Ok(true) => sched.touched(Instant::now()),
                    Ok(false) => {}
                    Err(e) => {
                        eprintln!("待ちに失敗した: {e}");
                        std::process::exit(1);
                    }
                }
            }
        }
    }
}

/// 手を呼ぶ。返すのは「次はいつ起こせ」。
///
/// 手が落ちても芯は落とさない。**芯が落ちると誰も起こせなくなる。**
/// 落ちたことは出すが、次は既定の網で起きる。
fn run_hook(hook: &[String]) -> Option<Duration> {
    let out = Command::new(&hook[0]).args(&hook[1..]).output();
    match out {
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            if !err.trim().is_empty() {
                eprint!("{err}");
            }
            let text = String::from_utf8_lossy(&o.stdout);
            if !o.status.success() {
                eprintln!("手が {} で終わった", o.status);
            }
            parse_next_wake(&text)
        }
        Err(e) => {
            eprintln!("手を呼べぬ: {} ({e})", hook[0]);
            None
        }
    }
}
