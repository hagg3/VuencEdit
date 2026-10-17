---
layout: page
title: Downloads
subtitle: Installers for macOS, Windows and Linux.
---

<p id="release-meta" style="color:#a3adb6; font-size:13px; margin-top:-8px;">v{{ site.latest_version }}</p>

<div class="callout callout-warm">
  <strong>Beta software.</strong> VuencEdit writes the game's binary world files directly. The
  first save over a file keeps a backup next to it, but copy anything you care about yourself first.
</div>

<div class="download-grid">

  <div class="card download-card" data-platform="mac">
    <div class="platform-name">macOS</div>
    <a class="btn btn-primary" data-suffix="_universal.dmg" href="https://github.com/{{ site.repository }}/releases/latest">Download for macOS</a>
    <div class="file-meta">VuencEdit_{{ site.latest_version }}_universal.dmg</div>
    <p style="font-size:12px; color:#a3adb6; margin:0;">Universal build for Apple Silicon and Intel.</p>
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
  Other installers and older versions are on the
  <a href="https://github.com/{{ site.repository }}/releases">Releases page</a>.
</p>

## Before you install

The builds aren't code-signed, since certificates cost money the project doesn't spend. Both
operating systems will warn you the first time you open VuencEdit:

- **macOS** shows *"VuencEdit can't be opened because it is from an unidentified developer."*
  Right-click (or Control-click) the app and choose **Open**, then confirm in the dialog that
  appears. You only need to do this once. If that doesn't work, open System Settings, go to Privacy & Security, scroll to the bottom and click **Open Anyway**.
- **Windows** shows a SmartScreen warning ("Windows protected your PC"). Click **More info**,
  then **Run anyway**.

## System requirements

VuencEdit is a Tauri app: a native shell around the system WebView, with no bundled Chromium. It
runs on a Mac from the last several years, Windows 10 or 11, or a recent Linux desktop. Big 256-high
worlds use more memory. If the app is struggling, Settings has a Low, Balanced or High memory preset.

<div class="btn-row">
  <a class="btn btn-secondary" href="{{ '/docs/getting-started/' | relative_url }}">Getting Started &rarr;</a>
</div>

<script src="{{ '/assets/js/downloads.js' | relative_url }}"></script>
