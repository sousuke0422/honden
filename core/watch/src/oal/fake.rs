//! 試験用の偽物。
//!
//! これがあると、回り方そのものを検められる。`Scheduler` の単体試験では
//! 「呼んだ後どうなるか」——手の出力をどう解したか、二重起動を弾いたか、
//! 手が落ちても回り続けるか——までは見られない。

use super::{HookOut, Oal, Watch};
use std::cell::RefCell;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

/// 台本。`wait` が返す答えを順に配る。
#[derive(Default)]
pub struct Script {
    /// true = 変化が来た / false = 時間切れ
    pub events: Vec<bool>,
    /// 手が返すもの。使い切ったら最後のものを繰り返す。
    pub outs: Vec<HookOut>,
    /// 錠を握れるか。
    pub lock_free: bool,
}

#[derive(Default)]
pub struct Log {
    /// 手を呼んだ回数と、その時の引数。
    pub runs: Vec<Vec<String>>,
    /// wait を呼んだ時の待ち時間。
    pub waits: Vec<Option<Duration>>,
}

pub struct Fake {
    script: RefCell<Script>,
    pub log: Rc<RefCell<Log>>,
    base: std::time::Instant,
    /// 起きてからの経ち。wait が眠ったぶんだけ進む。
    elapsed: Rc<RefCell<Duration>>,
    /// 真なら wait が眠らない（約束を破る口の再現）。
    sleepless: Rc<RefCell<bool>>,
}

impl Fake {
    pub fn new(script: Script) -> Self {
        Self {
            script: RefCell::new(script),
            log: Rc::new(RefCell::new(Log::default())),
            base: std::time::Instant::now(),
            elapsed: Rc::new(RefCell::new(Duration::from_secs(0))),
            sleepless: Rc::new(RefCell::new(false)),
        }
    }

    /// 約束を破った口にする。timeout を無視して即返り、時も進めぬ。
    /// 上の層の歯止めを検めるためだけに使う。
    pub fn sleepless(self) -> Self {
        *self.sleepless.borrow_mut() = true;
        self
    }
}

/// 変化が待ちの何秒後に来たことにするか。
const EVENT_ARRIVES_AFTER: Duration = Duration::from_millis(50);

pub struct FakeWatch {
    events: Vec<bool>,
    at: usize,
    log: Rc<RefCell<Log>>,
    elapsed: Rc<RefCell<Duration>>,
    sleepless: Rc<RefCell<bool>>,
}

impl Watch for FakeWatch {
    fn wait(&mut self, timeout: Option<Duration>) -> io::Result<bool> {
        self.log.borrow_mut().waits.push(timeout);

        // 台本を使い切ったら誤りとして返す。
        //
        // 以前はここで false を返し続けていた。時計も進めていなかったので、
        // 上の層は永久に Wait を返し、密なループが回り、waits が積もり続けた。
        // **25 GiB 食って OOM に殺された** (2026-08-26)。
        //
        // 偽物が実物の約束を破ると、上の層はそれを検知できない。
        // 「使い切った」を黙って「何も来ない」にしてはならない。
        let got = match self.events.get(self.at) {
            Some(&g) => g,
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "台本を使い切った。試験が想定より多く待っておる",
                ))
            }
        };
        self.at += 1;

        // 実物と同じだけ時を進める。
        //
        // 真の wait は頼まれた時間ぶん眠る。眠らぬ偽物を置くと、
        // 上の層は「待ったつもりで一瞬も進んでいない」世界で回る。
        // 束ねも歯止めも期限も、全部その進みを前提にしている。
        let advance = if got {
            // 変化が来たのは待ちの途中。全部は経っていない。
            EVENT_ARRIVES_AFTER.min(timeout.unwrap_or(EVENT_ARRIVES_AFTER))
        } else {
            // 時間切れ。頼まれたぶん経った。None (永久待ち) は
            // 実物なら二度と返らぬので、台本側で必ず変化を積むこと。
            timeout.unwrap_or(Duration::from_secs(0))
        };
        if !*self.sleepless.borrow() {
            *self.elapsed.borrow_mut() += advance;
        }

        Ok(got)
    }
}

impl Oal for Fake {
    type Watch = FakeWatch;
    type Guard = ();

    fn watch(&self, _paths: &[PathBuf]) -> io::Result<FakeWatch> {
        Ok(FakeWatch {
            events: self.script.borrow().events.clone(),
            at: 0,
            log: Rc::clone(&self.log),
            elapsed: Rc::clone(&self.elapsed),
            sleepless: Rc::clone(&self.sleepless),
        })
    }

    fn single_instance(&self, _path: &Path) -> io::Result<Option<()>> {
        Ok(if self.script.borrow().lock_free { Some(()) } else { None })
    }

    fn now(&self) -> std::time::Instant {
        // 呼んだだけでは進まない。眠った時だけ進む。実物と同じ。
        self.base + *self.elapsed.borrow()
    }

    fn run(&self, cmd: &[String]) -> io::Result<HookOut> {
        let mut log = self.log.borrow_mut();
        log.runs.push(cmd.to_vec());
        let n = log.runs.len();
        let s = self.script.borrow();
        let out = s.outs.get(n - 1).or_else(|| s.outs.last());
        Ok(match out {
            Some(o) => HookOut {
                stdout: o.stdout.clone(),
                stderr: o.stderr.clone(),
                ok: o.ok,
                status: o.status.clone(),
            },
            None => HookOut { stdout: String::new(), stderr: String::new(), ok: true, status: "ok".into() },
        })
    }
}

/// 台本を書きやすくする短い作り手。
pub fn out(stdout: &str) -> HookOut {
    HookOut { stdout: stdout.into(), stderr: String::new(), ok: true, status: "ok".into() }
}

/// 落ちた手。
pub fn broken() -> HookOut {
    HookOut { stdout: String::new(), stderr: "落ちた".into(), ok: false, status: "exit 1".into() }
}
