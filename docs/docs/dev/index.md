---
layout: page
title: Developer Reference
subtitle: How VuencEdit works inside, and what we know about the Eden file format.
---

VuencEdit is a [Tauri](https://tauri.app) app: a Rust backend does all the byte-level work over a
memory-mapped world file, and a React and TypeScript frontend draws the UI, the 2D map (Canvas) and
the 3D view (Three.js). Bulk data crosses the boundary as raw binary, never JSON-encoded.

These pages are written for two kinds of reader. If you want to **work on VuencEdit**, start with
Architecture, then Frontend and the IPC Reference. If you're building **another Eden World Builder
tool** (a port, a mod, a renderer), the file format, block and colour tables, 3D rendering and world
generation pages are written to be read on their own.

<div class="doc-grid">
  {% for d in site.data.dev %}
    <a class="card doc-card" href="{{ d.url | relative_url }}">
      <h3>{{ d.title }}</h3>
      <p>{{ d.text }}</p>
    </a>
  {% endfor %}
</div>

## Provenance

Eden World Builder was created by Ari Ronen, and its source was released in 2018. The `.eden` format
was first reverse-engineered by [Robert Munafo](https://mrob.com/pub/vidgames/eden-file-format.html).
VuencEdit descends from [Eden World Manipulator](https://github.com/jldeiro/EdenWorldManipulator2.0)
and [Vuenctools](https://github.com/bLUUBfACE/EdenWorldManipulator).

When these pages and the code disagree, the code wins. Corrections are welcome as a
[GitHub issue](https://github.com/{{ site.repository }}/issues).
