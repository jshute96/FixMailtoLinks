# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `package.json` | Node project manifest, scripts, devDependencies |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `tsconfig.tests.json` | Typecheck-only config covering `tests/`, which `tsconfig.json` excludes |
| `playwright.config.ts` | Playwright test runner config |
| `.gitignore` | Git ignore rules |

## Claude Commands (`.claude/commands/`)

| File | Description |
|------|-------------|
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — codereview then commit + push if clean |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 manifest, copied verbatim into `dist/` |
| `src/background.ts` | MV3 service worker — opens the options page when the toolbar icon is clicked |
| `src/content.ts` | Content script — rewrites `mailto:` links on every page using the configured URL template |
| `src/config.ts` | Shared config types, defaults, template validation, and storage helpers used by the options page |
| `src/options.ts` | Options page script — loads, validates, and saves the URL template in synced storage |
| `src/options.html` | Options page markup; opened in a tab and hosts the template editor |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons and manifest, then runs `tsc` |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixtures: extension-loaded Chromium, page server, and config helper |
| `tests/fixtures/pages/link_page.html` | Manual/E2E test page with plain, parameterized, nested, and dynamically added mailto links |
| `tests/fixtures/pages/landing.html` | Trivial navigation target for the click-through test |
| `tests/fixtures/pages/iframe_page.html` | Test page with mailto links inside `srcdoc` and `about:blank` frames |
| `tests/e2e/rewrite.spec.ts` | E2E specs for content-script rewriting: parsing, encoding, mutations, templates |
| `tests/e2e/options.spec.ts` | E2E specs for the options page: load, save, reset, and effect on open pages |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `architecture.md` | High-level design: content script, service worker, options page, storage |
