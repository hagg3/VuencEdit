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
    std::fs::rename(from, to)?;
    if let Some(parent) = to.parent() {
        fsync_dir(parent);
    }
    Ok(())
}
