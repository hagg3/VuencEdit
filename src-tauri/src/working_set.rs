//! Targeted working-set release for the world mapping — **Windows only**, everything else is a
//! no-op (H1 remediation, `the-windows-mmap-working-set-lucid-heron.md` Stage 3).
//!
//! ## Why this exists
//!
//! `LoadedWorld::bytes` is one whole-file mapping of the staged temp. Reserving 11.8 GB of address
//! space costs nothing on 64-bit Windows; what climbs is the **working set**, and a page enters it
//! the moment anything touches it. Stage 1/2's `top_band_hint` removed the thing that touched
//! essentially every page (the top-down band scan), which is the real fix. This is the backstop for
//! what the hint cannot help with — a genuinely tall world, a full-map render, a whole-world sculpt
//! — and it lets *us* pick the moment the pages go back, rather than waiting for Windows to trim
//! ~10 GB wholesale at a time of its choosing (which is what turns a trim into a visible stall).
//!
//! ## Why `VirtualUnlock` and nothing else
//!
//! - `OfferVirtualMemory`/`ReclaimVirtualMemory` — **unusable**: documented to require `MEM_PRIVATE`
//!   pages, and a file-mapping view is `MEM_MAPPED`.
//! - `EmptyWorkingSet` / `SetProcessWorkingSetSizeEx(h, -1, -1, 0)` — **rejected as a routine
//!   mechanism**: they trim the *whole process*, including the WebView2 renderer's pages and our own
//!   tile/geometry caches, producing exactly the refault stall this is trying to avoid.
//! - `VirtualUnlock` on a range that was never `VirtualLock`ed is the standard targeted trim. MSDN:
//!   "Calling VirtualUnlock on a range of memory that is not locked releases the pages from the
//!   process's working set." It returns `FALSE` with `ERROR_NOT_LOCKED` while doing so, which is why
//!   the return value is deliberately ignored. Clean file-backed pages then sit on the standby list
//!   and are re-satisfiable from the file cache without disk I/O.
//! - `PrefetchVirtualMemory` is the opposite direction — out of scope, but worth knowing about if a
//!   trim ever proves to make the next pan too slow.
//!
//! `memmap2` cannot do any of this for us: its `advise`/`advise_range` are `#[cfg(unix)]` and its
//! Windows backend exposes only `flush`/`flush_async`. Hence the raw declaration below — deliberately
//! a hand-written `extern "system"` block rather than a `windows-sys` dependency, because two stable
//! kernel32 entry points do not justify a new vendored crate (and its feature-flag surface) in a
//! tree that cannot compile for Windows locally.
//!
//! ## Trigger policy
//!
//! **Off unless `VUENCEDIT_TRIM=1`.** Shipped dark on purpose, matching the `VUENCEDIT_MAP`
//! precedent: it is unverifiable from the machine this was written on, and getting the policy wrong
//! trades a memory bug for a stall bug. Flip the default only after it has been measured on Windows.
//!
//! When enabled: a background thread polls once a second and trims the **whole mapping in one call**
//! once nothing has touched the world lock for `IDLE_MS`. Not per render — the visible window would
//! refault immediately. Not a computed "cold set" either: tracking which chunks are cold would need
//! a touched-set the renderers don't maintain, and the visible tiles refault from standby cheaply.
//!
//! ⚠️ **The trim runs while holding the world's *read* guard.** That is the deliberate answer to the
//! lifetime question: the guard is what proves the mapping is still alive for the duration of the
//! call, because `close_world`/`load_world` can only replace it under the *write* guard. Renders and
//! tile fetches are unaffected (they take read guards too); only an edit that arrives mid-trim
//! waits, and a trim only starts after seconds of complete inactivity. Taking the **write** guard
//! here would be wrong: a trim of a multi-GB dirty `MAP_SHARED` region can block on writeback, and
//! blocking every reader on that reproduces the exact stall this is meant to remove.

/// `VUENCEDIT_TRIM=1` arms the idle trimmer. Anything else (including unset) leaves it off.
#[cfg(target_os = "windows")]
fn trim_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("VUENCEDIT_TRIM").as_deref() == Ok("1"))
}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
    use std::time::{Duration, Instant};
    use tauri::Manager; // for `AppHandle::state`

    /// How long the world lock must go untouched before a trim is considered.
    const IDLE_MS: u64 = 4_000;
    /// Poll cadence of the trimmer thread. Cheap: two atomic loads unless it decides to act.
    const POLL: Duration = Duration::from_millis(1_000);
    /// Don't bother below this mapping size — there is nothing to reclaim and a needless refault
    /// on the next pan is pure cost.
    const MIN_TRIM_BYTES: usize = 256 << 20;

    /// Milliseconds since process start. `Instant` can't live in an atomic, so the clock is stored
    /// as an offset from one fixed origin.
    fn now_ms() -> u64 {
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_millis() as u64
    }

    /// Last moment anything acquired the world lock (or stepped a long operation).
    static LAST_ACCESS: AtomicU64 = AtomicU64::new(0);
    /// The `LAST_ACCESS` value that was current when the last trim ran — the latch that stops the
    /// trimmer from re-trimming every `IDLE_MS` forever while the app sits idle.
    static TRIMMED_FOR: AtomicU64 = AtomicU64::new(u64::MAX);

    pub(super) fn note_access() {
        if !super::trim_enabled() { return; }
        LAST_ACCESS.store(now_ms(), Relaxed);
    }

    pub(super) fn spawn(app: tauri::AppHandle) {
        if !super::trim_enabled() { return; }
        LAST_ACCESS.store(now_ms(), Relaxed);
        let _ = std::thread::Builder::new()
            .name("vuencedit-ws-trim".into())
            .spawn(move || loop {
                std::thread::sleep(POLL);
                let seen = LAST_ACCESS.load(Relaxed);
                // Nothing has happened since the last trim — the mapping is already as cold as we
                // are going to make it.
                if seen == TRIMMED_FOR.load(Relaxed) { continue; }
                if now_ms().saturating_sub(seen) < IDLE_MS { continue; }
                // Latch *before* acting, so every outcome — trimmed, no world loaded, mapping too
                // small — stops this cycle repeating once a second until something real happens.
                TRIMMED_FOR.store(seen, Relaxed);

                let state = app.state::<crate::AppState>();
                // ⚠️ Deliberately **not** `read_ws`: that stamps `LAST_ACCESS`, and the trimmer
                // stamping its own clock would make `seen` advance every cycle and defeat the latch
                // above. Same poison policy as `read_ws` — a panic elsewhere must not brick this.
                let ws = state.read().unwrap_or_else(|p| p.into_inner());
                let Some(world) = ws.world.as_ref() else { continue };
                let len = world.bytes.len();
                if len < MIN_TRIM_BYTES { continue; }
                // Safe to pass out of the guard's scope only because the guard is still held: the
                // mapping cannot be replaced or dropped without the write guard.
                super::release_range(world.bytes.as_ptr(), len);
                drop(ws);
                crate::timing_log!("[PAGES] trimmed {len}B of world mapping from the working set");
            });
    }
}

// kernel32 is linked by the standard library on every MSVC target, so this only declares the
// symbol — it adds no build-script or vendored-binding surface.
#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn VirtualUnlock(lpAddress: *mut core::ffi::c_void, dwSize: usize) -> i32;
}

/// Release `[base, base+len)` from this process's working set. No-op off Windows.
///
/// The return value is ignored on purpose: for a range that was never `VirtualLock`ed — which is
/// every range we ever pass — `VirtualUnlock` performs the trim and *then* reports `FALSE` /
/// `ERROR_NOT_LOCKED`. Treating that as a failure would mean never trimming anything.
// Off Windows its only caller (`imp::spawn`) doesn't exist, so it is legitimately dead there.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn release_range(base: *const u8, len: usize) {
    #[cfg(target_os = "windows")]
    {
        if len == 0 { return; }
        // SAFETY: the caller holds the world's read guard, so the mapping `base` points into is
        // alive for the duration of this call and cannot be replaced (that needs the write guard).
        // `VirtualUnlock` neither reads nor writes the range — it only moves pages out of the
        // working set — so no aliasing rule is at stake.
        unsafe { VirtualUnlock(base as *mut core::ffi::c_void, len) };
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (base, len);
}

/// Record that something just touched the world lock. Called from `read_ws`/`write_ws` (the only
/// two lock sites in the app) and from `LongOpHandle::step`, so a multi-second save or export that
/// holds one guard the whole time still counts as continuous activity rather than idleness.
///
/// Compiles to nothing off Windows, and to one atomic store behind one cached boolean when the
/// trimmer is disarmed.
#[inline]
pub(crate) fn note_world_access() {
    #[cfg(target_os = "windows")]
    imp::note_access();
}

/// Start the idle trimmer, if `VUENCEDIT_TRIM=1`. No-op off Windows.
///
/// ⚠️ Interaction with saving, stated rather than discovered: `autosave_world_inner` reads the temp
/// *file* and `try_incremental_save` reads chunk bytes straight out of the mapping. A trim during
/// either is merely wasteful, never incorrect — and both go through `LongOpHandle::step` or the
/// lock sites, so an in-flight save keeps the access clock warm and the trimmer stays out of the
/// way on its own.
pub(crate) fn spawn_idle_trimmer(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    imp::spawn(app);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}
