//! Linux 向けの実装。inotify + flock + std::process。

use super::linux_sys::{FileLock, Inotify, IN_CLOSE_WRITE, IN_CREATE, IN_DELETE_SELF, IN_MODIFY, IN_MOVED_TO, IN_MOVE_SELF};
use super::{HookOut, Oal, Watch};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub struct Linux;

pub struct LinuxWatch {
    ino: Inotify,
    /// 見張る先。起きるたびに付け直すために持つ。
    paths: Vec<PathBuf>,
    /// 見張る先の**親**。消えて作り直された時に気づくために持つ。
    dirs: Vec<PathBuf>,
    mask: u32,
    /// 付け直しに続けて失敗しておるか。黙って死なぬために数える。
    blind: std::cell::Cell<u32>,
}

/// 親を見る時の目。**生まれと入りだけ**を見る。
///
/// `IN_MODIFY` まで入れると、同じ棚にある正本や WAL の書き込みで毎回起きる。
/// 生まれと入りは稀ゆえ、これだけなら騒がしくならない。
const DIR_MASK: u32 = IN_CREATE | IN_MOVED_TO;

impl LinuxWatch {
    /// 見張りを付け直す。
    ///
    /// **inotify の見張りは inode に付く。** 見張っておるファイルが消されて
    /// 作り直されると、新しい inode には何も付いておらず、以後は静かに黙る。
    /// 合図の口 (`<正本>.signal`) は書き換えで作り直されうるので、この筋は実際に起きる。
    ///
    /// `inotify_add_watch` は同じ inode へ付け直すと同じ番号を返すだけで、
    /// 何度呼んでも害が無い。ゆえに起きるたびに無条件で付け直す——
    /// どの名が動いたかを見て分岐すると、見落とした名が黙って落ちる。
    ///
    /// 付け直しに失敗しても倒れない。**芯が落ちると誰も起こせなくなる。**
    ///
    /// # 「次に起きた時にまた試す」は嘘であった
    ///
    /// 元はそう書いてあった。**次が来ぬ。** 見張りが外れておるのだから、
    /// 何が起きても起こされぬ。実測（2026-09-01・sol の点検が釣った）:
    ///
    /// ```text
    /// 書き換え        起きた
    /// 消す            起きた（消滅の報せ）→ 付け直しが ENOENT で失敗
    /// 作り直して書く   **起きぬ**
    /// さらに書く       **起きぬ**
    /// ```
    ///
    /// 合図の口が消えて作り直される筋は実際にある。そこで黙れば、
    /// **誰も起こされぬまま、何も壊れていないように見える。**
    ///
    /// ゆえに**親も見る**。子が居らずとも親は在るので、作り直された折に
    /// 生まれの報せで起き、そこで付け直せる。
    fn rearm(&self) {
        let mut failed = 0;
        for d in &self.dirs {
            if self.ino.add(d, DIR_MASK).is_err() {
                failed += 1;
            }
        }
        let mut lost = 0;
        for p in &self.paths {
            if self.ino.add(p, self.mask).is_err() {
                lost += 1;
            }
        }
        // **黙らせぬ。** 見張りが一つも付いておらぬ状態が続くのは、
        // 芯が生きたまま耳が死んでおるのと同じである。
        if lost > 0 && lost == self.paths.len() && failed == self.dirs.len() {
            let n = self.blind.get() + 1;
            self.blind.set(n);
            if n == 1 || n % 30 == 0 {
                eprintln!(
                    "見張りが一つも付いておらぬ（{n} 度目）。合図が届かぬ恐れがある"
                );
            }
        } else {
            self.blind.set(0);
        }
    }
}

impl Watch for LinuxWatch {
    fn wait(&mut self, timeout: Option<Duration>) -> io::Result<bool> {
        let ms = match timeout {
            None => -1,
            Some(d) => d.as_millis().min(i32::MAX as u128) as i32,
        };
        let got = self.ino.wait(ms)?;
        // 起きた後で付け直す。消して作り直されておっても、次からは拾える。
        self.rearm();
        Ok(got)
    }
}

impl Oal for Linux {
    type Watch = LinuxWatch;
    type Guard = FileLock;

    fn watch(&self, paths: &[PathBuf]) -> io::Result<LinuxWatch> {
        let ino = Inotify::new()?;
        // ディレクトリを渡されれば中の出入りも拾う。
        //
        // SQLite の WAL は checkpoint で作り直されるので、ファイルだけを
        // 見張ると番号が古くなって黙る。親を見るのが確実になる。
        let mask = IN_MODIFY
            | IN_CLOSE_WRITE
            | IN_MOVED_TO
            | IN_CREATE
            | IN_DELETE_SELF
            | IN_MOVE_SELF;
        let mut ok = 0;
        for p in paths {
            match ino.add(p, mask) {
                Ok(_) => ok += 1,
                Err(e) => eprintln!("見張れぬ: {} ({e})", p.display()),
            }
        }
        if ok == 0 {
            return Err(io::Error::new(io::ErrorKind::NotFound, "見張れる先が一つも無い"));
        }

        // **親も見る。** 子が消されて作り直されると、子への見張りは古い inode に
        // 付いたまま黙る。親を見ておけば生まれの報せで起き、そこで付け直せる。
        // 親が無ければ諦める——子が見えておるなら親は在るはずで、無いのは
        // 相対路などの例外である。
        let mut dirs: Vec<PathBuf> = Vec::new();
        for p in paths {
            if let Some(d) = p.parent() {
                if !d.as_os_str().is_empty() && !dirs.iter().any(|x| x == d) {
                    if ino.add(d, DIR_MASK).is_ok() {
                        dirs.push(d.to_path_buf());
                    }
                }
            }
        }

        Ok(LinuxWatch { ino, paths: paths.to_vec(), dirs, mask, blind: std::cell::Cell::new(0) })
    }

    fn single_instance(&self, path: &Path) -> io::Result<Option<FileLock>> {
        FileLock::try_acquire(path)
    }

    fn now(&self) -> std::time::Instant {
        std::time::Instant::now()
    }

    fn run(&self, cmd: &[String]) -> io::Result<HookOut> {
        let o = Command::new(&cmd[0]).args(&cmd[1..]).output()?;
        Ok(HookOut {
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
            ok: o.status.success(),
            status: o.status.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 実の inotify を使う。時間に依るので待ちは長めに取り、
    /// 回る数は必ず有限にする（無限に回して機械を焼いた前例がある）。
    #[test]
    fn 消して作り直されても見張り続ける() {
        let dir = std::env::temp_dir().join(format!("honden-watch-rearm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.signal");
        fs::write(&f, "1").unwrap();

        let mut w = Linux.watch(&[f.clone()]).unwrap();

        // 合図の口を消して作り直す。新しい inode には何も付いておらぬ。
        fs::remove_file(&f).unwrap();
        fs::write(&f, "2").unwrap();
        // 消えたことの通知を吸う（ここで付け直しが走る）
        let _ = w.wait(Some(Duration::from_millis(300))).unwrap();

        // 新しい inode へ書く。付け直しておらねば、ここで黙る。
        fs::write(&f, "3").unwrap();
        let got = w.wait(Some(Duration::from_millis(1500))).unwrap();

        let _ = fs::remove_dir_all(&dir);
        assert!(got, "作り直された後の書き込みを拾えておらぬ");
    }

    #[test]
    fn 見張れる先が一つも無ければ断る() {
        assert!(Linux.watch(&[PathBuf::from("/そのような先は無い")]).is_err());
    }
}
