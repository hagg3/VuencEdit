//! Native memory probes backing the `mem_stats` IPC command (ROADMAP-EDIT Stage 9.1).
//!
//! VuencEdit had no RSS/working-set readout at all before this — `working_set.rs` can *release*
//! pages on Windows but nothing anywhere reported how many there were, which is exactly the gap
//! that let the Windows working-set blowup ship silently for months (see that module's own docs)
//! and is now blocking diagnosis of a second Windows report (`TEST WORLDS/windows-3d-lag-report-
//! 2026-09-14.md`). This module is the smallest thing that closes it: one process-memory probe and
//! one system-memory probe, each a hand-written `extern "system"`/`extern "C"` block matching
//! `working_set.rs`'s own precedent — **no `sysinfo` or `windows-sys` dependency** for two syscalls.
//!
//! The **page-fault count** is the one number here that earns its keep beyond a nice-to-have: it is
//! what separates "the mmap is thrashing" (H3/H4 in the field report) from "the GPU is doing
//! everything in software" (H1) when a user's only other signal is "it's slow". Sampled on demand
//! (the Diagnostics panel's Refresh button), never per frame — a diagnostic must never itself be a
//! performance problem.

/// This process's resident memory, sampled on demand.
#[derive(Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemory {
    /// Current working set (Windows) / resident size (macOS) — the number that plateaus-or-climbs
    /// question in ROADMAP-EDIT Stage 4 is asking about.
    pub working_set_bytes: u64,
    /// High-water mark since process start.
    pub peak_working_set_bytes: u64,
    /// Total (soft + hard) page faults since process start. 0 where unavailable.
    pub page_fault_count: u64,
}

/// System-wide RAM, sampled on demand.
#[derive(Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemory {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

/// Platform state that can explain a throttled or memory-starved machine (ROADMAP-EDIT 17.2, H-E1
/// and H-D1 in `TEST WORLDS/perf-degradation-investigation-2026-09-29.md`). Every field is
/// "unknown" (`None`/0) where the platform doesn't expose it, so the report can say so instead of
/// guessing. Thermal state and Low Power Mode are deliberately **not** here: on macOS they need
/// `NSProcessInfo` (an `objc2` dependency), so 17.0 reads `pmset -g therm` by hand instead.
#[derive(Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformState {
    /// macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. 0 = unknown.
    pub memory_pressure_level: u32,
    /// macOS swap file usage (`vm.swapusage`). 0/0 where unavailable.
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
    /// Windows commit charge and limit (`GlobalMemoryStatusEx` total/avail page file). 0/0 elsewhere.
    pub commit_used_bytes: u64,
    pub commit_limit_bytes: u64,
    /// Windows `GetSystemPowerStatus`: `Some(true)` on AC, `Some(false)` on battery.
    pub on_ac_power: Option<bool>,
    /// Battery charge 0–100 when a battery is present.
    pub battery_percent: Option<u8>,
    /// Windows Battery Saver (`SystemStatusFlag`), which throttles background and frame work.
    pub battery_saver: Option<bool>,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{PlatformState, ProcessMemory, SystemMemory};

    // psapi.dll and kernel32.dll are both linked by the standard library on every MSVC target —
    // same rationale as `working_set.rs`: two stable entry points don't justify a vendored crate.
    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut core::ffi::c_void,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
    }

    pub(super) fn process_memory() -> ProcessMemory {
        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            ..Default::default()
        };
        // SAFETY: `counters` is sized and zeroed above, matching the `cb` this call is told about;
        // `GetCurrentProcess` is a pseudo-handle that needs no closing.
        let ok = unsafe {
            GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb)
        };
        if ok == 0 {
            return ProcessMemory::default();
        }
        ProcessMemory {
            working_set_bytes: counters.working_set_size as u64,
            peak_working_set_bytes: counters.peak_working_set_size as u64,
            page_fault_count: counters.page_fault_count as u64,
        }
    }

    #[repr(C)]
    #[derive(Default)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
    }

    pub(super) fn system_memory() -> SystemMemory {
        let mut status = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            ..Default::default()
        };
        // SAFETY: `status` is sized per `dw_length`, which is all this call requires.
        let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
        if ok == 0 {
            return SystemMemory::default();
        }
        SystemMemory { total_bytes: status.ull_total_phys, available_bytes: status.ull_avail_phys }
    }

    // <winbase.h> SYSTEM_POWER_STATUS.
    #[repr(C)]
    #[derive(Default)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }

    pub(super) fn platform_state() -> PlatformState {
        let mut state = PlatformState::default();

        let mut status = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            ..Default::default()
        };
        // SAFETY: as in `system_memory`.
        if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 {
            state.commit_limit_bytes = status.ull_total_page_file;
            state.commit_used_bytes =
                status.ull_total_page_file.saturating_sub(status.ull_avail_page_file);
        }

        let mut power = SystemPowerStatus::default();
        // SAFETY: `power` matches SYSTEM_POWER_STATUS's layout, which is all this call requires.
        if unsafe { GetSystemPowerStatus(&mut power) } != 0 {
            // ACLineStatus: 0 offline, 1 online, 255 unknown.
            state.on_ac_power = match power.ac_line_status {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            };
            // BatteryLifePercent: 255 unknown; BatteryFlag bit 7 (128) = no system battery.
            if power.battery_life_percent <= 100 && power.battery_flag & 128 == 0 {
                state.battery_percent = Some(power.battery_life_percent);
            }
            // SystemStatusFlag: 1 = Battery Saver on.
            state.battery_saver = Some(power.system_status_flag & 1 != 0);
        }
        state
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{PlatformState, ProcessMemory, SystemMemory};

    // <mach/task_info.h>: MACH_TASK_BASIC_INFO = 20, 10 natural_t words
    // (virtual_size/resident_size/resident_size_max as u64 pairs, then
    // user_time/system_time/policy/suspend_count).
    #[repr(C)]
    #[derive(Default)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: [i32; 2],
        system_time: [i32; 2],
        policy: i32,
        suspend_count: i32,
    }
    const MACH_TASK_BASIC_INFO: i32 = 20;

    // <mach/task_info.h> TASK_EVENTS_INFO = 2 — the only place this platform exposes a fault count.
    #[repr(C)]
    #[derive(Default)]
    struct TaskEventsInfo {
        faults: i32,
        pageins: i32,
        cow_faults: i32,
        messages_sent: i32,
        messages_received: i32,
        syscalls_mach: i32,
        syscalls_unix: i32,
        csw: i32,
    }
    const TASK_EVENTS_INFO: i32 = 2;

    extern "C" {
        static mach_task_self_: u32;
        fn task_info(
            target_task: u32,
            flavor: i32,
            task_info_out: *mut i32,
            task_info_count: *mut u32,
        ) -> i32;
    }

    pub(super) fn process_memory() -> ProcessMemory {
        let mut basic = MachTaskBasicInfo::default();
        let mut count =
            (std::mem::size_of::<MachTaskBasicInfo>() / std::mem::size_of::<i32>()) as u32;
        // SAFETY: `basic`/`count` describe each other's size; `mach_task_self_` needs no closing.
        let kr = unsafe {
            task_info(
                mach_task_self_,
                MACH_TASK_BASIC_INFO,
                &mut basic as *mut MachTaskBasicInfo as *mut i32,
                &mut count,
            )
        };
        let (working_set_bytes, peak_working_set_bytes) =
            if kr == 0 { (basic.resident_size, basic.resident_size_max) } else { (0, 0) };

        let mut events = TaskEventsInfo::default();
        let mut ecount =
            (std::mem::size_of::<TaskEventsInfo>() / std::mem::size_of::<i32>()) as u32;
        // SAFETY: as above.
        let ekr = unsafe {
            task_info(
                mach_task_self_,
                TASK_EVENTS_INFO,
                &mut events as *mut TaskEventsInfo as *mut i32,
                &mut ecount,
            )
        };
        let page_fault_count = if ekr == 0 { events.faults as u64 } else { 0 };

        ProcessMemory { working_set_bytes, peak_working_set_bytes, page_fault_count }
    }

    extern "C" {
        fn sysctlbyname(
            name: *const core::ffi::c_char,
            oldp: *mut core::ffi::c_void,
            oldlenp: *mut usize,
            newp: *mut core::ffi::c_void,
            newlen: usize,
        ) -> i32;
    }

    fn sysctl_u64(name: &str) -> Option<u64> {
        let name = std::ffi::CString::new(name).ok()?;
        let mut value: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: `value`/`len` describe each other's size; `name` is a valid, NUL-terminated
        // C string owned for the duration of the call.
        let rc = unsafe {
            sysctlbyname(
                name.as_ptr(),
                &mut value as *mut u64 as *mut core::ffi::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        (rc == 0).then_some(value)
    }

    pub(super) fn system_memory() -> SystemMemory {
        // `available` on macOS has no single kernel number the way Windows' `ullAvailPhys` is one —
        // the closest cheap approximation without a `host_statistics64` vm-stats round trip is
        // "not pinned to the wired set", which sysctl doesn't expose directly either. Report total
        // only; available stays 0 (rendered as "unknown" by the frontend) rather than guessing.
        SystemMemory { total_bytes: sysctl_u64("hw.memsize").unwrap_or(0), available_bytes: 0 }
    }

    // <sys/sysctl.h> `struct xsw_usage`, the payload of `vm.swapusage`.
    #[repr(C)]
    #[derive(Default)]
    struct XswUsage {
        total: u64,
        avail: u64,
        used: u64,
        pagesize: u32,
        encrypted: u8,
    }

    fn sysctl_swap() -> Option<XswUsage> {
        let name = std::ffi::CString::new("vm.swapusage").ok()?;
        let mut value = XswUsage::default();
        let mut len = std::mem::size_of::<XswUsage>();
        // SAFETY: `value`/`len` describe each other's size; `name` is a valid C string.
        let rc = unsafe {
            sysctlbyname(
                name.as_ptr(),
                &mut value as *mut XswUsage as *mut core::ffi::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        (rc == 0).then_some(value)
    }

    pub(super) fn platform_state() -> PlatformState {
        let mut state = PlatformState::default();
        // The level is a 4-byte int; `sysctl_u64` would fail with ENOMEM on the size mismatch.
        let level = std::ffi::CString::new("kern.memorystatus_vm_pressure_level").unwrap();
        let mut v: i32 = 0;
        let mut len = std::mem::size_of::<i32>();
        // SAFETY: `v`/`len` describe each other's size; `level` is a valid C string.
        let rc = unsafe {
            sysctlbyname(
                level.as_ptr(),
                &mut v as *mut i32 as *mut core::ffi::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && v > 0 {
            state.memory_pressure_level = v as u32;
        }
        if let Some(swap) = sysctl_swap() {
            state.swap_used_bytes = swap.used;
            state.swap_total_bytes = swap.total;
        }
        state
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    use super::{PlatformState, ProcessMemory, SystemMemory};
    pub(super) fn process_memory() -> ProcessMemory { ProcessMemory::default() }
    pub(super) fn system_memory() -> SystemMemory { SystemMemory::default() }
    pub(super) fn platform_state() -> PlatformState { PlatformState::default() }
}

pub fn process_memory() -> ProcessMemory { imp::process_memory() }
pub fn system_memory() -> SystemMemory { imp::system_memory() }
pub fn platform_state() -> PlatformState { imp::platform_state() }

// ── Stage 18.0: peak/size counters ──────────────────────────────────────────
//
// Plain atomics, set at the operation (never a per-event log, never a poll) and read on demand by
// `mem_stats`. The peak working set can't attribute a spike to an operation; these can. `_last` is
// the most recent occurrence, `_max` the session high-water mark. Relaxed everywhere: they are
// diagnostics, not synchronisation.
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// One `_last`/`_max` pair.
#[derive(Default)]
pub struct Peak { last: AtomicU64, max: AtomicU64 }

impl Peak {
    pub const fn new() -> Self { Peak { last: AtomicU64::new(0), max: AtomicU64::new(0) } }
    pub fn record(&self, v: u64) { self.last.store(v, Relaxed); self.max.fetch_max(v, Relaxed); }
    fn snap(&self) -> PeakPair { PeakPair { last: self.last.load(Relaxed), max: self.max.load(Relaxed) } }
}

#[derive(Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakPair { pub last: u64, pub max: u64 }

/// Every 18.0 counter. `static PEAKS` below is the one instance.
pub struct Peaks {
    /// Pre-image bytes copied by `with_edit_inner` (RAM-1).
    pub edit_preimage: Peak,
    /// `UndoEntry::bytes` of the entry `finish_edit` kept (RAM-1 ratio, RAM-5).
    pub edit_delta: Peak,
    /// `ChunkScratch` buffer bytes per sculpt flush (RAM-2).
    pub sculpt_scratch: Peak,
    /// Bytes copied into a preview scan buffer (RAM-6).
    pub preview_scan: Peak,
    /// Peak transient bytes a clipboard mutation (copy/rotate/mirror) allocated beyond the
    /// clipboard itself (RAM-4).
    pub clipboard_op: Peak,
    /// Autosave tick payload bytes / wall ms (C-2).
    pub autosave_bytes: Peak,
    pub autosave_ms: Peak,
    pub autosave_compactions: AtomicU64,
    /// Full/incremental/compressed save: 0 = none yet, 1 = incremental, 2 = full, 3 = compressed.
    pub save_kind: AtomicU64,
    pub save_bytes: Peak,
    pub save_ms: Peak,
}

impl Peaks {
    const fn new() -> Self {
        Peaks {
            edit_preimage: Peak::new(), edit_delta: Peak::new(), sculpt_scratch: Peak::new(),
            preview_scan: Peak::new(), clipboard_op: Peak::new(),
            autosave_bytes: Peak::new(), autosave_ms: Peak::new(),
            autosave_compactions: AtomicU64::new(0), save_kind: AtomicU64::new(0),
            save_bytes: Peak::new(), save_ms: Peak::new(),
        }
    }
    pub fn snapshot(&self) -> PeakSnapshot {
        PeakSnapshot {
            edit_preimage_bytes: self.edit_preimage.snap(),
            edit_delta_bytes: self.edit_delta.snap(),
            sculpt_scratch_bytes: self.sculpt_scratch.snap(),
            preview_scan_bytes: self.preview_scan.snap(),
            clipboard_op_bytes: self.clipboard_op.snap(),
            autosave_bytes: self.autosave_bytes.snap(),
            autosave_ms: self.autosave_ms.snap(),
            autosave_compactions: self.autosave_compactions.load(Relaxed),
            save_kind: match self.save_kind.load(Relaxed) {
                1 => "incremental", 2 => "full", 3 => "compressed", _ => "none",
            },
            save_bytes: self.save_bytes.snap(),
            save_ms: self.save_ms.snap(),
        }
    }
}

pub static PEAKS: Peaks = Peaks::new();

/// Serialisable copy of `PEAKS` for `mem_stats`.
#[derive(Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakSnapshot {
    pub edit_preimage_bytes: PeakPair,
    pub edit_delta_bytes: PeakPair,
    pub sculpt_scratch_bytes: PeakPair,
    pub preview_scan_bytes: PeakPair,
    pub clipboard_op_bytes: PeakPair,
    pub autosave_bytes: PeakPair,
    pub autosave_ms: PeakPair,
    pub autosave_compactions: u64,
    pub save_kind: &'static str,
    pub save_bytes: PeakPair,
    pub save_ms: PeakPair,
}

#[cfg(test)]
mod peak_tests {
    use super::*;

    #[test]
    fn peak_tracks_last_and_max() {
        let p = Peak::new();
        p.record(10); p.record(50); p.record(20);
        let s = p.snap();
        assert_eq!((s.last, s.max), (20, 50));
    }
}
