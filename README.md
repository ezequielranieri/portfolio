<h1 align="center">portfolio</h1>

![Astro](https://img.shields.io/badge/Astro-5-ff5a03.svg)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS_v4-38bdf8.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

My personal portfolio and technical blog.

> Built by [ezequielranieri](https://github.com/ezequielranieri)
> — Backend & Security Engineer

## Build

```bash
npm run build
```

Or run locally:

```bash
npm run dev
```

The site starts at `http://localhost:4321`.

## What is this?

A portfolio + blog I use to showcase my projects and write about the technical decisions behind each one. It's designed for two audiences:

1. **Recruiters / clients** who land, see 2-3 projects with their stack, and that's it.
2. **Technical peers** who want to go deeper — why that architecture, what trade-offs were evaluated, what broke and how it was fixed.

Each featured project can have zero, one, or multiple associated posts that dive into its architecture.

## Features

- ✅ **100% static HTML** — No SPA, no runtime JS frameworks. Astro generates flat pages at build time.
- ✅ **Bilingual i18n** — Every Spanish post has an English translation linked via the `translationOf` field in TinaCMS.
- ✅ **Visual admin panel** — Posts are written and edited from `/admin` via TinaCMS. Publishing = commit in Git = auto-deploy on Vercel.
- ✅ **Projects from GitHub API** — Featured repos are fetched at build time. Falls back to placeholder data if the API is unavailable.
- ✅ **No database** — No Postgres, no custom backend. Tina Cloud handles admin auth; content lives in Git.
- ✅ **Dark-only** — Monochromatic, no light mode. Palette: `--bg: #0a0a0a`, `--ink: #f2f2f0`, everything in grayscale.

## Stack & Technical Decisions

| Component | Choice | Why |
| :--- | :--- | :--- |
| **Framework** | Astro 5 | Static by default, islands of interactivity only where needed. Generates flat HTML, zero framework JS in the bundle |
| **Styles** | Tailwind CSS v4 | Vite plugin, no legacy `tailwind.config` file. CSS variables as design tokens |
| **CMS** | TinaCMS | Visual editor at `/admin`, content versioned in Git. Publish = commit = auto-deploy, no external webhooks |
| **Deploy** | Vercel | Free tier, native Git integration, auto-builds per branch |
| **Fonts** | Archivo / Inter / JetBrains Mono | Display bold for headings, Inter for body, mono for code and metadata |
| **Analytics** | `@vercel/analytics` | Serverless, cookie-free, privacy-respecting |

## Project Structure

```text
portfolio/
├── content/
│   └── posts/               # Post markdown files (written by TinaCMS)
├── public/
│   └── favicon.svg          # "ER" in Archivo Black
├── src/
│   ├── components/          # One component per file, PascalCase
│   ├── layouts/             # Layout.astro — page shell
│   ├── lib/                 # External integrations (github.ts, i18n.ts)
│   ├── pages/               # Astro routes
│   │   ├── en/              # English pages
│   │   ├── es/              # Spanish pages
│   │   └── index.astro      # Redirect to default locale
│   └── styles/
│       └── global.css       # Design tokens, prose-custom, utilities
├── tina/                    # TinaCMS schema
├── astro.config.mjs
├── .env.example
└── package.json
```

## Environment Variables

| Variable | Required | Description |
| :--- | :---: | :--- |
| `GITHUB_USERNAME` | ✅ | Your GitHub username |
| `GITHUB_FEATURED_REPOS` | ✅ | CSV of repos to feature on the homepage |
| `GITHUB_TOKEN` | ❌ | GitHub token (avoids rate limits during build) |
| `SITE_URL` | ✅ | Deployed site URL (for RSS and sitemap) |
| `NEXT_PUBLIC_TINA_CLIENT_ID` | ✅ | Tina Cloud project ID |
| `TINA_TOKEN` | ✅ | Tina Cloud build token |

Copy `.env.example` to `.env` and fill in the values.

## Known Limitations

### TinaCMS depends on Tina Cloud for auth

The `/admin` panel requires Tina Cloud to be up. If Tina Cloud is down, posts can't be edited until it recovers. Already published content continues to serve normally since it's static HTML on Vercel — editing is blocked, not reading.

### Build depends on GitHub API

If the GitHub API rate-limits the request and no `GITHUB_TOKEN` is configured, projects display placeholder data. The site doesn't break, but stacks and descriptions won't reflect real values until the rate limit resets or the token is set.

### i18n is manual, not automatic

Translations are maintained by hand. No auto-translation or sync tool between versions. If I update a Spanish post, the English translation needs to be updated separately.

## Content Management

### Blog

I write and edit posts from `/admin`. TinaCMS saves them as Markdown in `content/posts/` and commits changes directly to the repo. Each post has these fields:

- `title`, `slug`, `author`, `date`
- `lang` (es/en), `translationOf` (slug of the translated post, if any)
- `project` (optional, links the post to a featured repo)
- `tags`, `excerpt`, `cover`
- `status` (draft / published)

To publish a new post: create it in `/admin`, set `status: published`, and TinaCMS commits. Vercel detects the commit and redeploys.

### Featured Projects

Projects are fetched from the GitHub API at build time. I use `GITHUB_FEATURED_REPOS` to control which repos appear and their order. Custom descriptions and stacks (instead of the repo's README) are configured in `src/lib/github.ts`, `MANUAL_OVERRIDES` section.

## Testing

```bash
# Production build
npm run build
```

The build generates static HTML in `dist/`. No frontend tests — the site is mostly markup, and data comes from external sources (GitHub API, TinaCMS) validated at build time.

## License

MIT License.
