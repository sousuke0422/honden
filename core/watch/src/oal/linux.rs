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
}

impl Watch for LinuxWatch {
    fn wait(&mut self, timeout: Option<Duration>) -> io::Result<bool> {
        let ms = match timeout {
            None => -1,
            Some(d) => d.as_millis().min(i32::MAX as u128) as i32,
        };
        self.ino.wait(ms)
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
        Ok(LinuxWatch { ino })
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
