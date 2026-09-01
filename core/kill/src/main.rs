//! 己の系譜の下だけを撃つ。
//!
//! # なぜ在るか
//!
//! 門（D006）は生の `kill` / `pkill` / `killall` / `tmux kill-*` を拒む。
//! だが滞った process を始末する道が一つも無いと、詰まったときに人を呼ぶしかない。
//!
//! そこで**ただ一つの道**を開ける。ここは次を守る。
//!
//! 一、撃つ相手が**己の pane の系譜の下**にあること
//! 二、**pidfd で掴んでから検め、掴んだまま撃つ**こと（pid の使い回しが届かぬ）
//! 三、**群れを撃つ形は受けぬ**（負の pid、`0`、複数）
//!
//! # 門は pid を見ない
//!
//! 系譜を辿るのは「いま」を見る仕事で、紋様の層は静のままにしておきたい。
//! 門に動を持たせると、門の側に検めと実行の隙が生まれる。
//! **動の検めは、実際に撃つ物の中に置く。**
//!
//! # 拒む形（uutils の `kill` と POSIX を読んで並べた）
//!
//! 写したのではなく、**何を拒むかを知るために読んだ**。
//!
//! | 形 | 何が起きるか |
//! |---|---|
//! | `kill -1` | その利用者が撃てる process すべて |
//! | `kill 0` | 己の process group 全部 |
//! | `kill -<pgid>` | その group 全部 |
//! | pid を複数 | 一つ検めても他が漏れる |
//! | `kill -l` | 一覧。撃つ道具に要らぬ |
//! | `kill -9 <pid>` | 旧式構文。`--signal` に一本化する |

use std::process::Command;

/// `pidfd_open(2)` と `pidfd_send_signal(2)`。
///
/// # なぜ pid で撃たぬか
///
/// pid は**使い回される**。検めてから撃つまでの間に相手が終わり、同じ番号が
/// 別の process へ渡ることがある。元は「検めた直後に撃つゆえ隙は無い」と
/// 書いていた。**嘘であった**（sol の点検が釣った・2026-09-01）。
/// 隣に置くだけでは窓は狭くなるが、閉じはせぬ。
///
/// pidfd は**その process そのもの**を掴む。掴んだ後にその process が終われば、
/// 番号が誰に渡ろうと fd は死んだ相手を指したままで、他人へは届かぬ。
///
/// ゆえに順を変える。**掴む → 検める → 掴んだまま撃つ。**
///
/// 番号は `libc` から取る。**土地ごとに違う。**
///
/// はじめ 424 / 434 を直に書いた。我らが配る二つの土地（x86_64・aarch64）では
/// それで正しい——`asm-generic/unistd.h` と x86_64 の表が同じ数を持つ。
/// だが **mips では `4000 + 434` である**（`libc` の表で確かめた・2026-09-01）。
///
/// いま当たっているから良い、では arm64 の `c_char` と同じ轍になる。
/// **土地で変わる数を、数で書かぬ。**
const SYS_PIDFD_SEND_SIGNAL: libc::c_long = libc::SYS_pidfd_send_signal;
const SYS_PIDFD_OPEN: libc::c_long = libc::SYS_pidfd_open;

/// その process を掴む。掴めねば `None`（既に居らぬか、権が無い）。
fn pidfd_open(pid: i32) -> Option<i32> {
    let fd = unsafe { libc::syscall(SYS_PIDFD_OPEN, pid as libc::c_int, 0 as libc::c_uint) };
    if fd < 0 { None } else { Some(fd as i32) }
}

/// 掴んだ相手へ送る。**番号ではなく fd へ送るゆえ、使い回しが届かぬ。**
fn pidfd_send_signal(fd: i32, sig: i32) -> Result<(), std::io::Error> {
    let rc = unsafe {
        libc::syscall(
            SYS_PIDFD_SEND_SIGNAL,
            fd as libc::c_int,
            sig as libc::c_int,
            std::ptr::null_mut::<libc::siginfo_t>(),
            0 as libc::c_uint,
        )
    };
    if rc == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

/// 撃ってよい信号。
///
/// **少なく保つ。** `KILL`(9) を入れていないのは意図である——後始末をさせずに
/// 落とすと、掴んでいた錠やファイルが残る。まず `TERM` で頼み、聞かねば人が出る。
const SIGNALS: &[(&str, i32)] = &[
    ("TERM", libc::SIGTERM),
    ("INT", libc::SIGINT),
    ("HUP", libc::SIGHUP),
];

/// 系譜を辿る深さの上限。輪や深すぎる木で止まらぬため（`anchor.ts` と同じ）。
const MAX_DEPTH: usize = 24;

/// 拒んで退く。**必ず帳へ残す。**
///
/// 元は `journal` を呼ぶ拒みと呼ばぬ拒みが混じっていた（sol の点検・2026-09-01）。
/// 検める側から見れば、記録の無い拒みは**起きなかったのと区別が付かぬ**。
fn die(reason: &str, msg: &str) -> ! {
    journal(&format!("refused\treason={reason}"));
    eprintln!("  {msg}");
    std::process::exit(2);
}

/// `/proc/<pid>/stat` から親を読む。
///
/// comm は括弧で囲まれ**空白も括弧も含みうる**ので、右括弧から数える。
/// 素朴に空白で割ると `(bash foo)` のような名で桁がずれる。
/// `src/anchor.ts` の `parentOf` と同じ流儀にしてある——**二箇所で違う辿り方を
/// すると、片方を直した日にもう片方が取り残される。**
fn parent_of(pid: i32) -> Option<i32> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = text.rfind(')')?;
    let rest: Vec<&str> = text.get(close + 2..)?.split_whitespace().collect();
    rest.get(1)?.parse::<i32>().ok().filter(|p| *p > 0)
}

/// `pid` から根へ辿った並び（己を含む）。
fn chain_from(pid: i32) -> Vec<i32> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cur = Some(pid);
    while let Some(p) = cur {
        if out.len() >= MAX_DEPTH || !seen.insert(p) {
            break;
        }
        out.push(p);
        cur = parent_of(p);
    }
    out
}

/// いま座っている pane の親 process。
///
/// `TMUX_PANE` は環境変数なので**騙れる**。ゆえに名乗りをそのまま信じず、
/// 「己の系譜がその pane の下にあるか」を後で照らす（`anchor.ts` と同じ守り）。
fn pane_pid() -> Option<i32> {
    let pane = std::env::var("TMUX_PANE").ok()?;
    let out = Command::new("tmux")
        .args(["display-message", "-t", &pane, "-p", "#{pane_pid}"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse::<i32>().ok()
}

/// 撃った跡・拒んだ跡を残す。
///
/// 正本（SQLite）は抱えない。抱えれば、この物が「何でもできる物」に近づく。
/// 隣に追記するだけの帳で足りる——**後から誰が何を撃ったか辿れれば良い。**
fn journal(line: &str) {
    // **道は絶対で、遡りを含まぬ物だけ受ける。** `HONDEN_DB=/tmp/../../x/db` の
    // ような形で帳を任意の場所へ向けられる（sol の点検・2026-09-01）。
    // この物は特権を持たぬので実害は小さいが、**帳の行き先を外から動かせるのは
    // 検めの筋として悪い**。怪しければ既定へ落とす。
    let home = std::env::var("HOME").unwrap_or_default();
    let fallback = format!("{home}/.honden/honden.db");
    let db = match std::env::var("HONDEN_DB") {
        Ok(v) if v.starts_with('/') && !v.split('/').any(|seg| seg == "..") => v,
        _ => fallback,
    };
    let dir = match db.rfind('/') {
        Some(i) => &db[..i],
        None => ".",
    };
    let path = format!("{dir}/kill.log");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{now}\t{line}");
    }
}

fn usage() -> ! {
    eprintln!(
        "  honden-kill <pid> [--signal TERM|INT|HUP]

  己の pane の系譜の下にある process だけを撃つ。
  群れを撃つ形（負の pid・0・複数）は受けぬ。
  生の kill / pkill / killall は門（D006）が拒む。ここが唯一の道である。"
    );
    std::process::exit(2)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        usage();
    }

    // **旧式構文と一覧は受けぬ。** `-9` は `--signal` に一本化し、`-l` は
    // 撃つ道具に要らぬ。受ければ、その分だけ読み解きが増え、穴も増える。
    let mut pid_arg: Option<&str> = None;
    let mut sig_name = "TERM";
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "--signal" | "-s" => {
                i += 1;
                match args.get(i) {
                    Some(v) => sig_name = v.as_str(),
                    None => die("no-signal-value", "--signal に値が無い"),
                }
            }
            _ if a.starts_with('-') => {
                die("unknown-flag", &format!("知らぬ旗である: {a}（受けるのは --signal だけ）"))
            }
            _ => {
                if pid_arg.is_some() {
                    // **複数は受けぬ。** 一つ検めても、残りが漏れる
                    die("multiple-pids", "pid は一つだけ受ける。群れを撃つ形は通さぬ");
                }
                pid_arg = Some(a);
            }
        }
        i += 1;
    }

    let raw = match pid_arg {
        Some(r) => r,
        None => die("no-pid", "pid が要る"),
    };
    let pid: i32 = match raw.parse() {
        Ok(p) => p,
        Err(_) => die("not-a-number", &format!("pid が数でない: {raw}")),
    };

    // 負の pid は process group、`0` は己の group、`-1` は撃てるすべて。
    // いずれも「一つを撃つ」ではない。
    if pid <= 0 {
        die("group", "pid は 1 以上でなければならぬ（0 は己の group、負は group、-1 は撃てるすべて）");
    }

    let sig = match SIGNALS.iter().find(|(n, _)| n.eq_ignore_ascii_case(sig_name)) {
        Some((_, s)) => *s,
        None => die(
            "bad-signal",
            &format!(
                "受けぬ信号である: {sig_name}（{}）",
                SIGNALS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(" / ")
            ),
        ),
    };

    let root = match pane_pid() {
        Some(p) => p,
        None => die("no-pane", "陣の中ではない（TMUX_PANE から pane を引けぬ）。ここは布陣の中だけの道である"),
    };

    // **名乗りをそのまま信じぬ。** TMUX_PANE は環境変数ゆえ騙れる。
    // 己の系譜がその pane の下にあることを、まず照らす。
    let me = std::process::id() as i32;
    if !chain_from(me).contains(&root) {
        die("not-in-pane", "名乗った pane の下に己がおらぬ。TMUX_PANE を騙ってはならぬ");
    }

    // 己自身と pane の根は撃たせぬ。落とせば、その pane ごと死ぬ
    if pid == me || pid == root {
        die("self", "己または pane の根は撃たぬ");
    }

    // ── ここから順が肝である ──
    //
    // **掴む → 検める → 掴んだまま撃つ。**
    //
    // pid で撃つと、検めてから撃つまでに相手が終わり、同じ番号が別の process へ
    // 渡りうる。隣に並べても窓は狭くなるだけで閉じはせぬ（sol の点検・2026-09-01）。
    // 先に pidfd で掴めば、以後その fd は**その process そのもの**を指す。
    // 掴んだ後に相手が終われば fd は死んだ相手を指したままで、他人へは届かぬ。
    let fd = match pidfd_open(pid) {
        Some(f) => f,
        None => {
            let e = std::io::Error::last_os_error();
            die("no-such-process", &format!("その process を掴めぬ（pid {pid}）: {e}"));
        }
    };

    // 掴んだ**後**に系譜を見る。掴む前に見ると、見てから掴むまでが隙になる。
    let target = chain_from(pid);
    if !target.contains(&root) {
        unsafe { libc::close(fd) };
        journal(&format!("refused\tpid={pid}\treason=outside\troot={root}"));
        eprintln!("  その process は己の pane（pid {root}）の下におらぬ。他人の物は撃たぬ");
        std::process::exit(2);
    }

    match pidfd_send_signal(fd, sig) {
        Ok(()) => {
            unsafe { libc::close(fd) };
            journal(&format!("sent\tpid={pid}\tsig={sig_name}\troot={root}"));
            println!("  {sig_name} を送った（pid {pid}・pane {root} の下）");
        }
        Err(e) => {
            unsafe { libc::close(fd) };
            journal(&format!("failed\tpid={pid}\tsig={sig_name}\terr={e}"));
            eprintln!("  撃てなんだ（pid {pid}）: {e}");
            std::process::exit(1);
        }
    }
}
