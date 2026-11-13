# Site source (hagg3.github.io/VuencEdit)

Jekyll site, copied to the public repo by `publish.sh vuencedit`. This file is in `exclude:`, so it never builds.

## Where the copy lives

| What | Where |
|---|---|
| Home page | `index.html` (hero text, compat pills, call to action) |
| Home + Features cards | `_data/features.yml` (one entry per card) |
| Features, Downloads, About | `features.md`, `downloads.md`, `about.md` |
| Help pages | `docs/*.md`; the list on the index and the sidebar come from `_data/docs.yml` |
| Tutorials | `docs/tutorials/*.md`; list in `_data/tutorials.yml` (index + sidebar) |
| Developer reference | `docs/dev/*.md`; list in `_data/dev.yml` |
| Blog posts | `_posts/YYYY-MM-DD-slug.md`; the `/blog/` index is `blog/index.html`, the feed is `/feed.xml` (jekyll-feed) |
| Local CMS (private) | `admin/` (see "Local editor" below) |
| Top nav tabs | `_data/nav.yml` |
| Footer, beta chip, head tags | `_includes/footer.html`, `_includes/nav.html`, `_includes/head.html` |
| Latest version (no-JS fallback) | `_config.yml` → `latest_version` |
| Site title, description | `_config.yml` |

Page text is plain Markdown under the front matter. Reusable bits: `{% include card.html %}`, `{% include screenshot.html %}`, `{% include placeholder.html %}`.

## Look

Styles are in `_sass/` (one entry, `assets/css/main.scss`). Colours and sizes are variables in `_sass/_variables.scss`. There is one phone breakpoint (`$phone`, 700 px). Budget: CSS ≤ 12 KB minified, page HTML ≤ 25 KB, images WebP.

## Build locally

`github-pages` won't install on Ruby 4. Use a throwaway Jekyll 4 Gemfile outside the repo:
`BUNDLE_GEMFILE=/path/to/Gemfile bundle exec jekyll serve -s docs`


## Screenshot placeholders

`{% raw %}{% include placeholder.html caption="..." file="name.webp" shot="what to capture" %}{% endraw %}` draws a dashed box that shows the suggested file name and the shot to take. The full list is the 35.4 checklist at the end of `TEST WORLDS/website-review-2026-11-13.md`.

## Writing a blog post

Copy `_posts/2026-11-13-welcome-to-the-vuencedit-blog.md` to `_posts/YYYY-MM-DD-your-slug.md` and edit the front matter (`layout: post`, `title`, optional `subtitle`). The date comes from the filename; a future date stays hidden until you build on or after it. The post appears on `/blog/` and in `/feed.xml` automatically. Link other pages with `{% raw %}{{ '/docs/' | relative_url }}{% endraw %}`.

## Local editor (Sveltia CMS, private)

`admin/index.html` + `admin/config.yml` give a wp-admin-style editor for blog posts and the five Help pages. It never publishes: `publish.sh` excludes `/docs/admin/` and `_config.yml` excludes `admin`.

1. Open `docs/admin/index.html` through any local static server, e.g. `python3 -m http.server 8000` from `docs/`, then visit `http://localhost:8000/admin/` in **Chrome or Edge** (Safari lacks the File System Access API).
2. Click **Work with Local Repository** and pick the repo root (the folder containing `docs/`).
3. Edit and save; the CMS writes the files. Then review `git diff`, commit and push by hand.

Scope: posts and Help pages only. The Help pages contain `include` tags (screenshot placeholders) that show as plain text in the editor: leave those lines untouched. **Tutorials, Features, Home, Downloads and About are hand-edited** (the placeholder include has no WYSIWYG form). The CMS loads from unpkg, so it needs internet.
