//! OAL — OS Abstraction Layer。
//!
//! 芯が OS から借りるものを、ここだけに集める。
//! 上の層 (`Scheduler`・`run_loop`) は syscall を一つも知らない。
//!
//! ## なぜ抽象するか
//!
//! 一つは移植。いまは Linux (WSL2) だけだが、Windows で直に動かす目があり、
//! その時に触る場所がここだけで済む。借りているものは 3 つしかない。
//!
//! | 借りるもの | Linux | Windows | macOS |
//! |---|---|---|---|
//! | 変化を待つ | inotify + poll | ReadDirectoryChangesW | kqueue / FSEvents |
//! | 二重起動を防ぐ | flock(LOCK_EX\|LOCK_NB) | 名前つき Mutex / LockFileEx | flock |
//! | 手を呼ぶ | std::process | 同左（std が吸収済み） | 同左 |
//!
//! もう一つは試験。偽物 (`fake`) を挿せば、実際の時計もファイルも使わずに
//! 回り方そのものを検められる。`Scheduler` の単体試験では
//! 「呼んだ後どうなるか」までは見られない。
//!
//! ## 名前について
//!
//! HAL が抽象するのは機器で、ここが抽象するのは OS の役務ゆえ OAL とした。

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 見張る口。落とすと閉じる。
pub trait Watch {
    /// 何か来るまで待つ。`None` なら永久に待つ。
    ///
    /// 返すのは「来たか」だけ。**どの名が動いたかは返さない。**
    /// 名で分岐すると、見落とした名が黙って落ちる筋ができる。
    ///
    /// # 実装が守るべき約束
    ///
    /// **何も来なければ `timeout` ぶん眠ってから返すこと。** 眠らずに
    /// `Ok(false)` を返すと、上の層は「待ったつもりで一瞬も進んでいない」
    /// 世界で回り続ける。束ねも歯止めも期限も、全部その進みを前提にしている。
    ///
    /// これを破った試験用の偽物で **25 GiB 食って OOM に殺された**
    /// (2026-08-26)。上の層に歯止めは置いたが、それは網であって
    /// 約束の代わりではない。移植先を書く時はここを最初に読まれよ。
    fn wait(&mut self, timeout: Option<Duration>) -> io::Result<bool>;
}

/// 手を呼んだ結果。
pub struct HookOut {
    pub stdout: String,
    pub stderr: String,
    /// 正常に終わったか。
    pub ok: bool,
    /// 終わり方を人へ見せる形にしたもの。
    pub status: String,
}

/// OS から借りるもの。
pub trait Oal {
    type Watch: Watch;
    /// 二重起動を防ぐ錠。握っている間だけ生きていればよいので、
    /// 中身は問わない。落ちれば解ける。
    type Guard;

    /// 見張る先を開く。一つも開けなければ Err。
    fn watch(&self, paths: &[PathBuf]) -> io::Result<Self::Watch>;

    /// 二重起動を防ぐ。
    ///
    /// `Ok(None)` は「他が既に握っておる」。**失敗ではない。**
    /// 現行の bash も同じ手当てを後から足している
    /// (multi-agent-shogun 8f49a0f「per-agent flock で二重起動を防ぐ」)。
    /// 二重に走ると同じ合図が二度飛び、受け取る側が数を見誤る。
    fn single_instance(&self, path: &Path) -> io::Result<Option<Self::Guard>>;

    /// 手を呼ぶ。
    fn run(&self, cmd: &[String]) -> io::Result<HookOut>;

    /// いま。
    ///
    /// 時計も OS から借りるものに含める。含めないと、回り方の試験が
    /// 実時間を待つことになり、束ねや歯止めを検められない。
    fn now(&self) -> std::time::Instant;
}

#[cfg(target_os = "linux")]
mod linux_sys;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::Linux as Native;

pub mod fake;
