---
layout: page
title: Help
subtitle: How the less obvious parts of VuencEdit work.
---

<div class="doc-grid">
  {% for d in site.data.docs %}
    <a class="card doc-card" href="{{ d.url | relative_url }}">
      <h3>{{ d.title }}</h3>
      <p>{{ d.text }}</p>
    </a>
  {% endfor %}
</div>

## Tutorials

<div class="doc-grid">
  {% for d in site.data.tutorials %}
    <a class="card doc-card" href="{{ d.url | relative_url }}">
      <h3>{{ d.title }}</h3>
      <p>{{ d.text }}</p>
    </a>
  {% endfor %}
</div>

<hr>

## For developers

How VuencEdit works inside, plus a reference for the Eden file format, block tables and 3D
rendering, is in the [Developer Reference]({{ '/docs/dev/' | relative_url }}).

Questions and bug reports are welcome on the [Discord server](https://discord.com/invite/rjYXwBC) or as a [GitHub issue](https://github.com/{{ site.repository }}/issues).
