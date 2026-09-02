//! 口ごとの網の檻。
//!
//! # なぜ在るか
//!
//! 床の v1（bwrap + pasta）は「母屋の口へ届かぬ・外は全開」しか表せぬ。
//! fw 機器の流儀で `tcp/443` と書けるようにするには、外向きを**口で濾す**物が
//! 要る——pasta は egress を口で濾せず、nftables は root と規則の常駐を要する。
//! Landlock（ABI 4 以降）は無特権で「許した TCP の口へしか connect できぬ」枷を
//! はめられる（実測 2026-09-01・Issue #12）。
//!
//! # 何をするか
//!
//! ```text
//! honden-cage --tcp 443 --tcp 80 -- <命>...
//! ```
//!
//! 一、`no_new_privs` を立てる（枷の前提。特権昇格の道を先に閉じる）
//! 二、Landlock の ruleset（扱うのは TCP の connect だけ）を作る
//! 三、許す口を並べる
//! 四、己に枷をはめる——**子孫にも継がれ、後から外せぬ**
//! 五、命を exec する
//!
//! # 何を守らぬか（正直に）
//!
//! - **UDP は縛れぬ。** Landlock の網は TCP の bind/connect だけである。
//!   UDP まで縛るなら pasta の段より深い普請が要る。設定の層（src/isolate.ts）は
//!   `udp/<口>` を**受けずに拒む**——縛れぬ規則を受けると、書いた者は
//!   守られたつもりになる。
//! - **宛先は見ぬ。口だけを見る。** 443 を許せば、どの宛先の 443 へも届く。
//!   母屋の loopback を隔てるのは pasta の仕事で、この檻はその内側に重ねる。
//! - file は触らぬ（handled_access_fs = 0）。床の file の縛りは別の段。
//!
//! # 拒む形
//!
//! | 形 | なぜ |
//! |---|---|
//! | `--tcp` が一つも無い | 「全部塞ぐ」つもりか書き忘れか判ぜぬ。全部塞ぐなら bwrap の `--unshare-net` が既に在る |
//! | 口が 1〜65535 の外 | 書き損じ |
//! | 核の ABI が 4 未満 | 網の規則が無い。**黙って枷なしで exec せぬ**（fail-closed） |

use std::env;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::process::exit;

/// kernel UAPI（include/uapi/linux/landlock.h）を写した。libc には未収載。
#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
}

#[repr(C)]
struct NetPortAttr {
    allowed_access: u64,
    port: u64,
}

const ACCESS_NET_CONNECT_TCP: u64 = 1 << 1;
const RULE_NET_PORT: libc::c_int = 2;
const CREATE_RULESET_VERSION: u32 = 1;

fn die(msg: &str) -> ! {
    eprintln!("honden-cage: {msg}");
    exit(2);
}

fn main() {
    let mut ports: Vec<u16> = Vec::new();
    let mut cmd: Vec<std::ffi::OsString> = Vec::new();
    let mut args = env::args_os().skip(1);
    while let Some(a) = args.next() {
        match a.to_str() {
            Some("--tcp") => {
                let v = args.next().unwrap_or_else(|| die("--tcp に口の番号が要る"));
                let n: u32 = v
                    .to_str()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| die("--tcp の値が数でない"));
                if n == 0 || n > 65535 {
                    die("口は 1〜65535");
                }
                ports.push(n as u16);
            }
            Some("--") => {
                cmd.extend(args.by_ref());
                break;
            }
            _ => die("知らぬ旗がある。形: honden-cage --tcp <口> [--tcp <口>]... -- <命>..."),
        }
    }
    if ports.is_empty() {
        // 「全部塞ぐ」つもりか書き忘れか、ここでは判ぜぬ。全部塞ぐ道は
        // bwrap --unshare-net が既に在る（src/isolate.ts の outbound 無し）。
        die("--tcp が一つも無い。許す口を並べよ（全部塞ぐなら isolation の allow を空にせよ）");
    }
    if cmd.is_empty() {
        die("-- の後に起こす命が要る");
    }

    // 核が口の規則を持つか。ABI 4 未満は黙って枷なしにせず、ここで止まる。
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<RulesetAttr>(),
            0usize,
            CREATE_RULESET_VERSION,
        )
    };
    if abi < 4 {
        die(&format!(
            "核の Landlock が網の規則を持たぬ（ABI {abi}）。口ごとの縛りはこの核では効かせられぬゆえ、枷なしで起こすことはせぬ"
        ));
    }

    // 枷の前提。これが無いと restrict_self が EPERM で拒む。
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        die("prctl(NO_NEW_PRIVS) に失敗した");
    }

    let attr = RulesetAttr {
        handled_access_fs: 0, // file は触らぬ。この檻の仕事は網だけ
        handled_access_net: ACCESS_NET_CONNECT_TCP,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0u32,
        )
    };
    if fd < 0 {
        die("landlock_create_ruleset に失敗した");
    }
    let fd = fd as libc::c_int;

    for p in &ports {
        let rule = NetPortAttr {
            allowed_access: ACCESS_NET_CONNECT_TCP,
            port: *p as u64,
        };
        let rc = unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                fd,
                RULE_NET_PORT,
                &rule as *const NetPortAttr,
                0u32,
            )
        };
        if rc != 0 {
            die(&format!("口 {p} の規則を足せなんだ"));
        }
    }

    if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, fd, 0u32) } != 0 {
        die("枷をはめられなんだ（landlock_restrict_self）");
    }
    unsafe { libc::close(fd) };

    // ここから先、この process と子孫は、許した口へしか TCP で繋げぬ。
    let prog = CString::new(cmd[0].as_bytes()).unwrap_or_else(|_| die("命に NUL が混じる"));
    let argv: Vec<CString> = cmd
        .iter()
        .map(|a| CString::new(a.as_bytes()).unwrap_or_else(|_| die("引数に NUL が混じる")))
        .collect();
    let mut ptrs: Vec<*const libc::c_char> = argv.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    unsafe { libc::execvp(prog.as_ptr(), ptrs.as_ptr()) };
    die("exec に失敗した（命が道に無いか）");
}
