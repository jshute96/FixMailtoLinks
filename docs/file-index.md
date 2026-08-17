# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `package.json` | Node project manifest, scripts, devDependencies |
| `pnpm-lock.yaml` | Pinned dependency tree for `pnpm install` |
| `LICENSE` | MIT license |
| `PRIVACY.md` | Privacy policy for the Chrome Web Store listing — what is stored, read, and sent |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `tsconfig.tests.json` | Typecheck-only config covering `tests/`, which `tsconfig.json` excludes |
| `playwright.config.ts` | Playwright test runner config |
| `.gitignore` | Git ignore rules |

## Claude Config (`.claude/`)

| File | Description |
|------|-------------|
| `.claude/settings.json` | Claude Code settings checked in for the project |
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — codereview then commit + push if clean |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 manifest, copied verbatim into `dist/` |
| `src/background.ts` | MV3 service worker — opens the options page, and background tabs/windows for modified clicks |
| `src/content.ts` | Content script — intercepts `mailto:` clicks and follows the matching target or opens the chooser |
| `src/dialog.ts` | Chooser dialog shown when no target is automatic: copy buttons, matching targets, email fallback |
| `src/config.ts` | Shared config types, defaults, domain matching, validation, and storage helpers (a global script) |
| `src/options.ts` | Options page script — edits, validates, and saves the target list; drives the "Test it" lines |
| `src/options.html` | Options page markup: target rows, the Rules box, and the "Test it" section |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons, manifest and `options.html`, then runs `tsc` |
| `scripts/zip_extension.sh` | Builds the extension and zips `dist/` into `/tmp/` for distribution |
| `scripts/release-extension.sh` | Cuts a `vX.Y.Z` GitHub release: version checks, tag, and zip upload |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixtures: extension-loaded Chromium, page server, and config helper |
| `tests/fixtures/pages/link_page.html` | Manual/E2E test page with mailto links in many shapes: plain, parameterized, multi- and no-recipient, nested, dynamic |
| `tests/fixtures/pages/landing.html` | Trivial navigation target for the click-through test |
| `tests/fixtures/pages/iframe_page.html` | Test page with mailto links inside `srcdoc` and `about:blank` frames |
| `tests/e2e/clicks.spec.ts` | E2E specs for click interception: parsing, encoding, modifier clicks, and domain matching |
| `tests/e2e/dialog.spec.ts` | E2E specs for the chooser dialog: contents, target links, copy, close, configure |
| `tests/e2e/options.spec.ts` | E2E specs for the options page: target rows, save/cancel, and the "Test it" lines |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `images/options-page.png` | Options page screenshot, shown in `README.md` |
| `images/dialog-box.png` | Chooser dialog screenshot, shown in `README.md` |
| `images/options-page-webstore.png` | Options screenshot padded to 1280x800 for the Chrome Web Store |
| `images/dialog-box-webstore.png` | Dialog screenshot padded to 1280x800 for the Chrome Web Store |
| `images/promo-tile-440x280.png` | 440x280 promo tile for the Chrome Web Store listing |
| `images/promo-tile.html` | Source the promo tile PNG is rendered from |
| `images/promo-tile-candidates.html` | Rejected promo tile designs, kept for future listing work |
| `images/promo-tile-candidates-e.html` | Variants of the chosen promo tile design |
| `architecture.md` | High-level design: content script, service worker, options page, storage |
