# ![icon](src/icons/icon-48.png) Fix Mailto Links Chrome Extension

This chrome extension rewrites mailto: links into normal links.
Users can configure what to link to.

## Usage

- Once installed, every `mailto:` link on every page is rewritten in
  place. By default, clicking such a link runs a Google search for
  the email address instead of opening an email client.
- Click the extension's toolbar icon (or open the extension's options
  from `chrome://extensions`) to change the URL template. Use
  `{email}` as a placeholder for the address; it will be URL-encoded.
- Settings are stored in Chrome's synced storage, so they follow your
  Chrome profile across devices.

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

To poke at the extension by hand, load `dist/` unpacked and open
`tests/fixtures/pages/link_page.html` — it has plain, parameterized,
nested, and dynamically added `mailto:` links, plus a non-mailto
control.

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
