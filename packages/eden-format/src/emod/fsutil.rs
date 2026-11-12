//! The store's file primitives: positioned reads, the spec's fsync, and an atomic replace whose
//! new name is durable (the same rename-then-fsync-the-parent idiom as VuencEdit's `publish`).

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// Reads exactly `buf.len()` bytes at `off`, without moving any shared cursor.
pub(crate) fn read_exact_at(f: &File, off: u64, buf: &mut [u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        f.read_exact_at(buf, off)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let (mut done, mut off) = (0usize, off);
        while done < buf.len() {
            match f.seek_read(&mut buf[done..], off) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short read")),
                Ok(n) => {
                    done += n;
                    off += n as u64;
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

/// Writes all of `buf` at `off`.
pub(crate) fn write_all_at(f: &File, off: u64, buf: &[u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        f.write_all_at(buf, off)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let (mut done, mut off) = (0usize, off);
        while done < buf.len() {
            match f.seek_write(&buf[done..], off) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "short write")),
                Ok(n) => {
                    done += n;
                    off += n as u64;
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

/// `<path><suffix>` (`x.emod` → `x.emod.creating`): the container's extension stays in the name.
pub(crate) fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(suffix);
    PathBuf::from(p)
}

/// Fsync a directory so a name just created in it is durable. Best-effort, and a no-op on
/// Windows (a directory can't be opened as a file there; `MoveFileEx` is the durability).
fn fsync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(f) = File::open(if dir.as_os_str().is_empty() { Path::new(".") } else { dir }) {
        let _ = f.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Atomically renames `from` over `to` (`fs::rename` replaces on both POSIX and Windows), then
/// makes the new name durable. The caller has already fsynced `from`'s contents.
pub(crate) fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    rename_with_retry(from, to)?;
    if let Some(parent) = to.parent() {
        fsync_dir(parent);
    }
    Ok(())
}

/// Backoff between rename attempts (≈0.3 s worst case): Windows AV scanners and indexers hold a
/// freshly written file open for a moment, and `MoveFileExW` fails transiently meanwhile.
const RENAME_BACKOFF_MS: [u64; 5] = [10, 20, 40, 80, 160];

/// Whether a rename error may clear by itself: `PermissionDenied`, or raw OS error 5 (access
/// denied), 32 (sharing violation) or 33 (lock violation). Anything else is final at once.
fn rename_error_is_transient(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

/// `fs::rename` that retries transient failures; returns the last error after the backoff runs out.
/// Same code on every OS (free on Unix, where these errors don't occur).
pub fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    rename_with_retry_counted(from, to).0
}

/// [`rename_with_retry`], also reporting how many retries ran (for a `[SAVE] rename retried N×` log).
pub fn rename_with_retry_counted(from: &Path, to: &Path) -> (io::Result<()>, u32) {
    rename_with_retry_by(|| std::fs::rename(from, to), &RENAME_BACKOFF_MS, std::thread::sleep)
}

/// The retry loop with the rename and the sleep injected, so the classify + give-up path is
/// unit-testable without a real lock.
pub(crate) fn rename_with_retry_by(
    mut f: impl FnMut() -> io::Result<()>,
    backoff_ms: &[u64],
    mut sleep: impl FnMut(std::time::Duration),
) -> (io::Result<()>, u32) {
    let mut retries = 0u32;
    loop {
        match f() {
            Ok(()) => return (Ok(()), retries),
            Err(e) if rename_error_is_transient(&e) && (retries as usize) < backoff_ms.len() => {
                sleep(std::time::Duration::from_millis(backoff_ms[retries as usize]));
                retries += 1;
            }
            Err(e) => return (Err(e), retries),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied() -> io::Error { io::Error::from(io::ErrorKind::PermissionDenied) }

    #[test]
    fn retries_transient_then_succeeds() {
        let mut n = 0;
        let mut slept = vec![];
        let (r, k) = rename_with_retry_by(
            || { n += 1; if n < 3 { Err(denied()) } else { Ok(()) } },
            &RENAME_BACKOFF_MS,
            |d| slept.push(d.as_millis()),
        );
        assert!(r.is_ok());
        assert_eq!(k, 2);
        assert_eq!(slept, vec![10, 20]);
    }

    #[test]
    fn gives_up_after_the_backoff_with_the_last_error() {
        let mut n = 0;
        let (r, k) = rename_with_retry_by(|| { n += 1; Err(io::Error::from_raw_os_error(32)) }, &RENAME_BACKOFF_MS, |_| {});
        assert_eq!(r.unwrap_err().raw_os_error(), Some(32));
        assert_eq!((n, k), (6, 5));
    }

    #[test]
    fn other_errors_return_at_once() {
        let mut n = 0;
        let (r, k) = rename_with_retry_by(|| { n += 1; Err(io::Error::from(io::ErrorKind::NotFound)) }, &RENAME_BACKOFF_MS, |_| {});
        assert!(r.is_err());
        assert_eq!((n, k), (1, 0));
    }
}
