# HomiGrotas — Security Research Blog

Offensive security research and technical deep dives, hosted on GitHub Pages.

## Structure

| Path | Content |
|------|---------|
| `index.html` | Homepage (Jekyll) — terminal-style post index |
| `_layouts/` | Jekyll layouts (`default`, `post`) |
| `_includes/` | Navigation & footer partials |
| `assets/` | CSS theme + matrix/typewriter JS |
| `_research/web/` | Web application security writeups |
| `_research/open_source/` | Open-source code review writeups |
| `_learning/` | Build-along tutorials & exploit development labs |

## Local development

The site is built with Jekyll 3.10 + the `github-pages` gem (identical to the GitHub Actions / Pages build).

```bash
# via Docker (no local Ruby needed)
docker run --rm -v "$PWD":/srv/jekyll -p 4000:4000 \
  jekyll/jekyll:pages jekyll serve

# or natively
bundle install
bundle exec jekyll serve
```

Then open http://localhost:4000.

## Writing a new post

Add a markdown file under `_research/` or `_learning/` with front matter:

```yaml
---
layout: post
title: "Your Title"
date: 2026-01-01
category: web        # web | open source | learning
tags: [tag1, tag2]
severity: high       # critical | high | medium | low | n-a
excerpt: "One-line summary shown on the homepage."
---
```

The writeup then appears automatically on the homepage under the matching section.

## Publishing

Commit and push to `main`. GitHub Actions / Pages builds and publishes automatically.
