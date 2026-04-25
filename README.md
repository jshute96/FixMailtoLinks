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
   git clone https://github.com/jshute96/GoogleDocsDiffRange.git
   cd GoogleDocsDiffRange
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
```

## Layout

- `src/` — TypeScript sources and `manifest.json`
- `dist/` — built extension (gitignored, loaded unpacked into Chrome)
- `scripts/build.mjs` — build script (cleans `dist/`, copies icons and
  manifest, runs `tsc`)
- `tests/e2e/` — Playwright tests
- `tests/fixtures/extension.ts` — fixture that loads the extension and
  exposes its service worker
- `docs/` — design docs and the file index
