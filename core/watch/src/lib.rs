//! 芯の決め事。syscall を持たないので、そのまま試験できる。
//!
//! ## 何を知っていて、何を知らないか
//!
//! この芯は agent も pane も未読も escalation も知らない。
//! 知っているのは 3 つだけ。
//!
//!   1. 何か書かれた（inotify が鳴った）
//!   2. 落ち着くまで少し待つ（束ねて 1 回にする）
//!   3. 手を呼ぶ。手が「次はいつ起こせ」と言うので、それまで寝る
//!
//! 未読の数え方も、合図の文面も、escalation の段も、全部 honden 側にある。
//! 芯へ持ち込むと、同じものに 2 つの実装が生まれる（合図の形で一度やった）。
//!
//! ## なぜ常駐する側だけ分けるのか
//!
//! 現行 (scripts/inbox_watcher.sh) の実測、2026-08-26:
//!
//!   - 20 プロセス / RSS 合計 61.8 MiB
//!   - 何も起きておらぬ 60 秒で 72 回の起動
//!     (inotifywait 29 / python3 22 / bash 21)
//!
//! inotifywait を `-t 30` で回すので 30 秒ごとに起動し直し、
//! 未読を数えるたびに python3 が PyYAML を読み込む。
//! 速さの話ではない。**何も起きていない間の常駐費**である。

use std::time::{Duration, Instant};

/// 芯の決め事。
#[derive(Debug, Clone)]
pub struct Policy {
    /// 書き込みが落ち着くまで待つ間。束ねて 1 回にする。
    pub debounce: Duration,
    /// 手が何も言わなかった時に、次に起こすまでの間。
    pub fallback: Duration,
    /// 手を呼ぶ間隔の下限。壊れた手が即座に「今すぐ」と言い続けても回らない。
    pub floor: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            debounce: Duration::from_millis(200),
            // 何も起きねば 5 分に一度。escalation の刻み (2 分) より粗いが、
            // 手が「次は 2 分後」と言えばそちらが効く。これは手が黙った時の網。
            fallback: Duration::from_secs(300),
            floor: Duration::from_millis(500),
        }
    }
}

/// 次に何をするか。
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// 手を呼ぶ。
    Run,
    /// この時間だけ待つ。0 なら永久に待つ（inotify 待ち）。
    Wait(Option<Duration>),
}

/// 起きている間の状態。
#[derive(Debug)]
pub struct Scheduler {
    policy: Policy,
    /// 書き込みを見てから、まだ手を呼んでいない状態か。
    pending_since: Option<Instant>,
    /// 手が次に起こせと言った時刻。
    due: Option<Instant>,
    /// 最後に手を呼んだ時刻。
    last_run: Option<Instant>,
}

impl Scheduler {
    pub fn new(policy: Policy) -> Self {
        Self { policy, pending_since: None, due: None, last_run: None }
    }

    /// 何か書かれた。
    pub fn touched(&mut self, now: Instant) {
        // 既に待っている最中なら、待ち始めを延ばさない。
        //
        // 延ばすと、書き込みが続く限り永久に手を呼ばない。
        // 現行の bash も同じ罠を持っていた（`-t 30` の再武装で誤魔化していた）。
        if self.pending_since.is_none() {
            self.pending_since = Some(now);
        }
    }

    /// 手が「次はこの時に起こせ」と言った。None なら既定の網へ落とす。
    pub fn ran(&mut self, now: Instant, next: Option<Duration>) {
        self.last_run = Some(now);
        self.pending_since = None;
        self.due = Some(now + next.unwrap_or(self.policy.fallback));
    }

    /// いま何をするか。
    pub fn step(&self, now: Instant) -> Step {
        // 呼びすぎの歯止め。手が壊れて「今すぐ」と言い続けても、
        // ここより速くは回らない。
        if let Some(last) = self.last_run {
            let since = now.saturating_duration_since(last);
            if since < self.policy.floor {
                return Step::Wait(Some(self.policy.floor - since));
            }
        }

        if let Some(t) = self.pending_since {
            let waited = now.saturating_duration_since(t);
            return if waited >= self.policy.debounce {
                Step::Run
            } else {
                Step::Wait(Some(self.policy.debounce - waited))
            };
        }

        match self.due {
            Some(d) if now >= d => Step::Run,
            Some(d) => Step::Wait(Some(d.saturating_duration_since(now))),
            None => Step::Run, // 起きた直後は一度呼ぶ。取りこぼしを拾うため
        }
    }
}

/// 手の返した最後の行から「次はいつ」を取る。
///
/// 行ごと JSON を読むのではなく、最後の行だけを見る。
/// 手は人が読む文も出すので、混ざっても構わない造りにする。
///
/// 読めなければ None。**黙って 0 にはしない**——読めなかったことと
/// 「今すぐ来い」を同じ扱いにすると、壊れた手が回転を生む。
pub fn parse_next_wake(stdout: &str) -> Option<Duration> {
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{'))?;
    let key = "\"next_wake_ms\"";
    let i = line.find(key)? + key.len();
    let rest = &line[i..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse::<u64>().ok().map(Duration::from_millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn 起きた直後は一度呼ぶ() {
        let s = Scheduler::new(Policy::default());
        assert_eq!(s.step(t0()), Step::Run);
    }

    /// 束ねの試験では下限を外す。下限が効いていると、束ねが効いておるのか
    /// 下限で止まっておるのかが区別できない（別の試験で下限は見ておる）。
    fn no_floor() -> Policy {
        Policy { floor: Duration::from_millis(0), ..Policy::default() }
    }

    #[test]
    fn 書き込みは束ねて一回にする() {
        let mut s = Scheduler::new(no_floor());
        let now = t0();
        s.ran(now, Some(Duration::from_secs(60)));

        s.touched(now + Duration::from_millis(10));
        // 続けて書かれても待ち始めは動かない
        s.touched(now + Duration::from_millis(100));
        s.touched(now + Duration::from_millis(180));

        // 最初の書き込みから 200ms で呼ぶ。三度呼ばない。
        assert!(matches!(s.step(now + Duration::from_millis(150)), Step::Wait(_)));
        assert_eq!(s.step(now + Duration::from_millis(215)), Step::Run);
    }

    #[test]
    fn 書き込みが続いても待ち始めは延びぬ() {
        let mut s = Scheduler::new(no_floor());
        let now = t0();
        s.ran(now, Some(Duration::from_secs(60)));
        s.touched(now + Duration::from_millis(10));
        // 190ms 後にもう一度書かれても、延長されるなら Run にならない
        s.touched(now + Duration::from_millis(190));
        assert_eq!(s.step(now + Duration::from_millis(215)), Step::Run);
    }

    #[test]
    fn 手の言うた時まで寝る() {
        let mut s = Scheduler::new(Policy::default());
        let now = t0();
        s.ran(now, Some(Duration::from_secs(120)));
        match s.step(now + Duration::from_secs(1)) {
            Step::Wait(Some(d)) => assert!(d.as_secs() >= 118 && d.as_secs() <= 119),
            other => panic!("待つはずが {other:?}"),
        }
        assert_eq!(s.step(now + Duration::from_secs(121)), Step::Run);
    }

    #[test]
    fn 手が黙れば既定の網へ落ちる() {
        let mut s = Scheduler::new(Policy::default());
        let now = t0();
        s.ran(now, None);
        assert!(matches!(s.step(now + Duration::from_secs(299)), Step::Wait(_)));
        assert_eq!(s.step(now + Duration::from_secs(301)), Step::Run);
    }

    #[test]
    fn 壊れた手でも回転しない() {
        let mut s = Scheduler::new(Policy::default());
        let now = t0();
        // 「今すぐ来い」と言われても、下限より速くは回らない
        s.ran(now, Some(Duration::from_millis(0)));
        match s.step(now + Duration::from_millis(1)) {
            Step::Wait(Some(d)) => assert!(d.as_millis() > 0),
            other => panic!("歯止めが効いておらぬ: {other:?}"),
        }
        assert_eq!(s.step(now + Duration::from_millis(501)), Step::Run);
    }

    #[test]
    fn 下限は書き込みにも効く() {
        let mut s = Scheduler::new(Policy::default());
        let now = t0();
        s.ran(now, Some(Duration::from_secs(60)));
        s.touched(now + Duration::from_millis(1));
        // debounce は過ぎておるが、下限 500ms を待つ
        assert!(matches!(s.step(now + Duration::from_millis(250)), Step::Wait(_)));
        assert_eq!(s.step(now + Duration::from_millis(501)), Step::Run);
    }

    #[test]
    fn 次の起床を読む() {
        assert_eq!(
            parse_next_wake("karo へ合図した\n{\"next_wake_ms\": 120000}"),
            Some(Duration::from_millis(120_000))
        );
        assert_eq!(parse_next_wake("{\"next_wake_ms\":0}"), Some(Duration::from_millis(0)));
    }

    #[test]
    fn 読めぬときは今すぐにしない() {
        // 読めなかったことと「今すぐ来い」を同じ扱いにすると回転が起きる
        assert_eq!(parse_next_wake(""), None);
        assert_eq!(parse_next_wake("何も出さぬ手"), None);
        assert_eq!(parse_next_wake("{\"next_wake_ms\": \"すぐ\"}"), None);
        assert_eq!(parse_next_wake("{\"other\": 1}"), None);
    }

    #[test]
    fn 最後の行のJSONを採る() {
        // 手が途中で何行も出しても、最後の一行を見る
        let out = "{\"next_wake_ms\": 1000}\n途中の報せ\n{\"next_wake_ms\": 2000}";
        assert_eq!(parse_next_wake(out), Some(Duration::from_millis(2000)));
    }
}
