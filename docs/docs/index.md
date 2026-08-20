---
layout: page
title: Docs
subtitle: Everything you need to get started, and a few things worth knowing before you dig deep.
---

<div class="doc-grid">
  {% for d in site.data.docs %}
    <a class="card doc-card" href="{{ d.url | relative_url }}">
      <h3>{{ d.title }}</h3>
      <p>{{ d.text }}</p>
    </a>
  {% endfor %}
</div>

<hr>

## For developers

VuencEdit's own architecture, IPC, and subsystem documentation lives alongside the source and is
kept up to date as the app changes — it's the real reference, not this manual.

- [Architecture overview](https://github.com/{{ site.repository }}/blob/main/DOCUMENTATION/01-architecture.md)
- [File format](https://github.com/{{ site.repository }}/tree/main/DOCUMENTATION)
- [Full documentation index](https://github.com/{{ site.repository }}/tree/main/DOCUMENTATION)

Questions or bug reports are welcome on the [Discord server](https://discord.com/invite/rjYXwBC)
or as a [GitHub issue](https://github.com/{{ site.repository }}/issues).
