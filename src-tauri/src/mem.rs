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

#[cfg(target_os = "windows")]
mod imp {
    use super::{ProcessMemory, SystemMemory};

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
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{ProcessMemory, SystemMemory};

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
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    use super::{ProcessMemory, SystemMemory};
    pub(super) fn process_memory() -> ProcessMemory { ProcessMemory::default() }
    pub(super) fn system_memory() -> SystemMemory { SystemMemory::default() }
}

pub fn process_memory() -> ProcessMemory { imp::process_memory() }
pub fn system_memory() -> SystemMemory { imp::system_memory() }
