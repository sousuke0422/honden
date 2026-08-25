//! inotify と ppoll の最小の口。
//!
//! crate を足さずに済ませるため、要る syscall だけ自前で宣言する。
//! ここが unsafe の全部で、他の場所には一切置かない。

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

// libc から借りるもの。数は Linux の値で固定されており変わらない。
pub const IN_MODIFY: u32 = 0x0000_0002;
pub const IN_CLOSE_WRITE: u32 = 0x0000_0008;
pub const IN_MOVED_TO: u32 = 0x0000_0080;
pub const IN_CREATE: u32 = 0x0000_0100;
pub const IN_DELETE_SELF: u32 = 0x0000_0400;
pub const IN_MOVE_SELF: u32 = 0x0000_0800;

const IN_NONBLOCK: i32 = 0o4000;
const IN_CLOEXEC: i32 = 0o2000000;

// flock の操作。Linux/BSD で同じ値。
pub const LOCK_EX: i32 = 2;
pub const LOCK_NB: i32 = 4;

extern "C" {
    fn inotify_init1(flags: i32) -> i32;
    fn flock(fd: i32, operation: i32) -> i32;
    fn inotify_add_watch(fd: i32, pathname: *const i8, mask: u32) -> i32;
    fn read(fd: i32, buf: *mut u8, count: usize) -> isize;
    fn close(fd: i32) -> i32;
    fn poll(fds: *mut PollFd, nfds: u64, timeout: i32) -> i32;
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PollFd {
    fd: i32,
    events: i16,
    revents: i16,
}

const POLLIN: i16 = 0x001;

/// inotify の口。落とすと閉じる。
pub struct Inotify {
    fd: i32,
}

impl Inotify {
    pub fn new() -> io::Result<Self> {
        // SAFETY: 引数は定数のみ。返り値は fd か -1。
        let fd = unsafe { inotify_init1(IN_NONBLOCK | IN_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { fd })
    }

    /// 見張る先を足す。既にある先を足し直すと同じ番号が返る（inotify の仕様）。
    pub fn add(&self, path: &Path, mask: u32) -> io::Result<i32> {
        let c = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "パスに NUL が混じっておる"))?;
        // SAFETY: c は呼び出しの間じゅう生きている。fd は自分のもの。
        let wd = unsafe { inotify_add_watch(self.fd, c.as_ptr(), mask) };
        if wd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(wd)
    }

    /// 何か来るまで待つ。`timeout_ms` が負なら永久に待つ。
    ///
    /// 返り値は「来たか」。中身は見ない——どの名が動いたかで振る舞いを
    /// 変えないので、読み捨てて構わない。名を見て分岐すると、
    /// 見落とした名が黙って落ちる筋ができる。
    pub fn wait(&self, timeout_ms: i32) -> io::Result<bool> {
        let mut pfd = PollFd { fd: self.fd, events: POLLIN, revents: 0 };
        // SAFETY: pfd は 1 要素の配列として渡す。
        let n = unsafe { poll(&mut pfd as *mut PollFd, 1, timeout_ms) };
        if n < 0 {
            let e = io::Error::last_os_error();
            // 合図で起こされただけなら、何も来ていないものとして扱う。
            if e.kind() == io::ErrorKind::Interrupted {
                return Ok(false);
            }
            return Err(e);
        }
        if n == 0 {
            return Ok(false); // 時間切れ
        }
        self.drain()?;
        Ok(true)
    }

    /// 溜まった通知を読み捨てる。
    ///
    /// 読まぬと fd が詰まり、次の poll が即座に返り続けて空回りする。
    pub fn drain(&self) -> io::Result<()> {
        // inotify_event は可変長。名前つきで最大 NAME_MAX+1。
        let mut buf = [0u8; 4096];
        loop {
            // SAFETY: buf は自分のもので、長さも渡している。
            let n = unsafe { read(self.fd, buf.as_mut_ptr(), buf.len()) };
            if n > 0 {
                continue; // まだ残っておるかもしれぬ
            }
            if n == 0 {
                return Ok(());
            }
            let e = io::Error::last_os_error();
            return match e.kind() {
                // 非閉塞ゆえ、空になればここへ来る。これが正常な終わり。
                io::ErrorKind::WouldBlock => Ok(()),
                io::ErrorKind::Interrupted => continue,
                _ => Err(e),
            };
        }
    }
}

impl Drop for Inotify {
    fn drop(&mut self) {
        // SAFETY: 自分で開いた fd を一度だけ閉じる。
        unsafe { close(self.fd) };
    }
}

/// 二重起動を防ぐ錠。落とすと解ける。
///
/// ファイルを消しても解けない（inode に付くため）。プロセスが落ちれば
/// OS が解く——「錠を残したまま死ぬ」が起きないのが、印ファイルとの違い。
pub struct FileLock {
    _file: std::fs::File,
}

impl FileLock {
    /// 握れたら Some。他が握っていれば None。
    pub fn try_acquire(path: &Path) -> io::Result<Option<Self>> {
        use std::os::unix::io::AsRawFd;
        let file = std::fs::OpenOptions::new().create(true).write(true).open(path)?;
        // SAFETY: fd は file が生きている間だけ有効で、その間にしか使わない。
        let r = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        if r == 0 {
            return Ok(Some(Self { _file: file }));
        }
        let e = io::Error::last_os_error();
        // 他が握っておる。失敗ではない。
        if e.raw_os_error() == Some(11) {
            return Ok(None); // EWOULDBLOCK
        }
        Err(e)
    }
}
