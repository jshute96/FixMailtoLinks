# ![icon](src/icons/icon-48.png) Fix Mailto Links Chrome Extension

This chrome extension rewrites `mailto:` links into normal links
to configured target pages, or opens a dialog box where you can pick
a target page or copy the email address.

Typically, you might prefer linking into your people directory rather than
opening an email client.

The link dialog:

<!-- Both screenshots are stored at the size the UI really is on screen
     (the dialog is 30rem wide, the options page 52rem), so they render
     1:1 here and still shrink on a narrow window. -->
![The chooser dialog](docs/screenshots/dialog-box.png)

## Configuration

Click the toolbar icon to open the Options page, where you configure the
target links.

- There's an ordered list of rules, optionally matching by the email's
  domain, each with a target link.
- A target link is an `http://` or `https://` URL containing `{email}`
  (the whole address) or `{username}` (the part before the `@`).
- These either open the first match directly, or open a dialog box
  showing all matching targets.
- "Test it" tries an address against the rules currently on screen,
  before you save them.

Settings sync with your Chrome profile.

The Options page:

![The options page](docs/screenshots/options-page.png)

## Installation

### Chrome extension

1. Clone this repo and install dependencies:
   ```bash
   git clone https://github.com/jshute96/FixMailtoLinks.git
   cd FixMailtoLinks
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. In Chrome: open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select the `dist/` directory.

## Development setup

```bash
npm install
npx playwright install chromium
```

## Building

```bash
npm run build        # one-shot build into dist/
npm run watch        # rebuild on TS changes
```

## Testing

```bash
npm test             # run Playwright e2e tests
npm run test:headed  # same, with a visible browser
npm run typecheck    # typecheck the test suite (tsc doesn't cover tests/)
```

`npm test` rebuilds `dist/` first, then drives a real Chromium with the
extension loaded against the fixture pages in `tests/fixtures/pages/`.
See the Testing section of `docs/architecture.md` for how the harness
works and the gotchas it encodes.

### Test pages

Useful for trying the extension interactively:

- [`link_page.html`](tests/fixtures/pages/link_page.html) — mailto links
  in various shapes, including dynamically added links.
- [`iframe_page.html`](tests/fixtures/pages/iframe_page.html) — links
  inside `about:blank` and `srcdoc` frames.

## Layout

- `src/` — TypeScript sources and `manifest.json`
- `dist/` — built extension (gitignored, loaded unpacked into Chrome)
- `scripts/build.mjs` — build script (cleans `dist/`, copies icons and
  manifest, runs `tsc`)
- `tests/e2e/` — Playwright tests
- `tests/fixtures/extension.ts` — fixtures that load the extension,
  expose its service worker, serve the fixture pages, and reset config
- `tests/fixtures/pages/` — HTML pages the tests (and you) load
- `docs/` — design docs and the file index
