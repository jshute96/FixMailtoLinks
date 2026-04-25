# Architecture

High-level design of the Fix Mailto Links extension.

## Goals

- Rewrite every `mailto:` link on every page to point somewhere else.
- Let the user configure where.
- Persist that configuration across devices via Chrome sync.

## Why a content script (and not `declarativeNetRequest`)

We rewrite `href` attributes in the page via an injected content
script. The obvious-looking alternative — a
`declarativeNetRequest` (DNR) redirect rule that matches
`^mailto:...` — does not work, and it's worth capturing why so we
don't try it again.

- **`mailto:` clicks are not network requests.** Chrome treats
  `mailto:` as an external protocol. When the user clicks a
  `mailto:` link, Chrome does not route it through the network
  stack; it hands the URL directly to the OS protocol handler
  (system email client, webmail registration, etc.).
- **DNR only sees network requests.** `declarativeNetRequest` rules
  are evaluated against outgoing HTTP(S) requests in the network
  stack. Because `mailto:` never enters that stack, no DNR rule —
  regardless of its `regexFilter` — will ever match.
- **Other "no-content-script" hooks have the same blind spot.**
  `chrome.webRequest`, `chrome.webNavigation.onBeforeNavigate`, and
  friends are all tied to the network / navigation pipeline, which
  the external-protocol handoff bypasses. None of them fire for
  `mailto:`.
- **The DOM is the only interception point that actually fires.**
  The `href` attribute is resolved by the renderer, in the page, at
  click time. Rewriting it there (or intercepting the click) is the
  only mechanism available to an extension that reliably changes
  what happens when a `mailto:` link is clicked.

So: the content script isn't an implementation preference — it's the
only layer where we can meaningfully intervene.

## Pieces

### Content script (`src/content.ts`)

- Runs at `document_start` on all URLs and all frames.
- Loads the saved config from `chrome.storage.sync`.
- On first run, walks the DOM and rewrites all
  `a[href^="mailto:"]` anchors.
- Uses a `MutationObserver` to catch links added later by SPAs or
  async renders, and to re-rewrite if a page swaps `href` back to a
  `mailto:`.
- Listens for `chrome.storage.onChanged` so that saving a new
  template in the options page updates already-open tabs without a
  reload.
- Stashes the original `mailto:` href on a
  `data-fix-mailto-original` attribute so a template change can
  re-derive the email instead of re-parsing the rewritten URL.

### Background service worker (`src/background.ts`)

- Opens the options page in a small popup window when the toolbar
  icon is clicked.
- Kept intentionally tiny — all rewriting logic lives in the
  content script.

### Options page (`src/options.html` + `src/options.ts`)

- Simple form with one text input (the URL template) and Save /
  Reset buttons.
- Reads and writes a single object (`{ urlTemplate }`) in
  `chrome.storage.sync` under the key `config`.

### Shared config (`src/config.ts`)

- Exposes `Config`, `DEFAULT_CONFIG`, `STORAGE_KEY`, and
  `loadConfig` / `saveConfig` helpers.
- Used by the options page (as an ES module).
- **Not** imported by the content script — MV3 content scripts do
  not support static ES module imports, so the handful of helpers
  used there are duplicated inline in `content.ts`.

## URL template format

- Free-form string; substring `{email}` is replaced with the
  URL-encoded email address at rewrite time.
- Default: `https://www.google.com/search?q={email}`.

## Storage layout

- Area: `chrome.storage.sync`.
- Key: `config`.
- Value shape: `{ urlTemplate: string }`.
- Missing/partial values fall back to `DEFAULT_CONFIG`.
