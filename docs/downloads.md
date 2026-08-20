---
layout: page
title: Downloads
subtitle: Pre-built installers for macOS, Windows, and Linux.
---

<p id="release-meta" style="color:#a3adb6; font-size:13px; margin-top:-8px;">v{{ site.latest_version }}</p>

<div class="callout callout-warm">
  <strong>Beta software.</strong> VuencEdit writes binary world files directly. Back up your
  worlds before editing them — use the app's built-in backup-on-save option, or copy the file
  yourself first.
</div>

<div class="download-grid">

  <div class="card download-card" data-platform="mac">
    <div class="platform-name">macOS</div>
    <a class="btn btn-primary" data-suffix="_universal.dmg" href="https://github.com/{{ site.repository }}/releases/latest">Download for macOS</a>
    <div class="file-meta">VuencEdit_{{ site.latest_version }}_universal.dmg</div>
    <p style="font-size:12px; color:#a3adb6; margin:0;">Universal binary — Apple Silicon and Intel. Requires macOS 11+.</p>
  </div>

  <div class="card download-card" data-platform="win">
    <div class="platform-name">Windows</div>
    <a class="btn btn-primary" data-suffix="_x64-setup.exe" href="https://github.com/{{ site.repository }}/releases/latest">Download for Windows</a>
    <div class="file-meta">VuencEdit_{{ site.latest_version }}_x64-setup.exe</div>
    <div class="secondary-links">
      or the <a data-suffix="_x64_en-US.msi" href="https://github.com/{{ site.repository }}/releases/latest">.msi installer</a>
    </div>
  </div>

  <div class="card download-card" data-platform="linux">
    <div class="platform-name">Linux</div>
    <a class="btn btn-primary" data-suffix="_amd64.AppImage" href="https://github.com/{{ site.repository }}/releases/latest">Download AppImage</a>
    <div class="file-meta">VuencEdit_{{ site.latest_version }}_amd64.AppImage</div>
    <div class="secondary-links">
      or <a data-suffix="_amd64.deb" href="https://github.com/{{ site.repository }}/releases/latest">.deb</a>
      · <a data-suffix="-1.x86_64.rpm" href="https://github.com/{{ site.repository }}/releases/latest">.rpm</a>
    </div>
  </div>

</div>

<p style="text-align:center; font-size:13px;">
  All installers, checksums, and older versions are on the
  <a href="https://github.com/{{ site.repository }}/releases">Releases page</a>.
</p>

## Before you install

Builds are not code-signed — that costs money the project doesn't spend — so both operating
systems will warn you the first time you open VuencEdit. This is expected, not a sign of malware:

- **macOS** shows *"VuencEdit can't be opened because it is from an unidentified developer."*
  Right-click (or Control-click) the app and choose **Open**, then confirm in the dialog that
  appears. You only need to do this once.
- **Windows** shows a SmartScreen warning ("Windows protected your PC"). Click **More info**,
  then **Run anyway**.

## System requirements

VuencEdit is a Tauri app — a small native shell around a WebView, not a bundled Electron/Chromium
runtime — so it's lightweight on memory and disk compared to most editors in this space. Any
Mac from the last several years, or a Windows 10/11 or modern Linux desktop, is enough.

<div class="btn-row">
  <a class="btn btn-secondary" href="{{ '/docs/getting-started/' | relative_url }}">Read the Getting Started guide &rarr;</a>
</div>

<script src="{{ '/assets/js/downloads.js' | relative_url }}"></script>
