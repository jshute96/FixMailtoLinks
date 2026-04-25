# Architecture

High-level design of the Fix Mailto Links extension.

## Goals

- Redirect every `mailto:` navigation to a configurable URL.
- Let the user configure where.
- Persist that configuration across devices via Chrome sync.
- Inject **nothing** into pages — all rewriting is handled by Chrome
  at navigation time.

## Pieces

### Background service worker (`src/background.ts`)

- Maintains a single dynamic `declarativeNetRequest` rule that
  matches `mailto:*` URLs and redirects them to the user's configured
  target.
- Rebuilds the rule on `runtime.onInstalled` and whenever
  `chrome.storage.sync` reports a change to the config key.
- Opens the options page in a popup window when the toolbar icon is
  clicked.

### Options page (`src/options.html` + `src/options.ts`)

- Simple form: one text input for the URL template, Save / Reset
  buttons.
- Writes `{ urlTemplate }` to `chrome.storage.sync` under the key
  `config`.
- The service worker picks up the change via `storage.onChanged` and
  rebuilds the DNR rule.

### Shared config (`src/config.ts`)

- Exposes `Config`, `DEFAULT_CONFIG`, `STORAGE_KEY`,
  `loadConfig` / `saveConfig`.
- Exposes `templateToRegexSubstitution`, which turns a user template
  into the `regexSubstitution` string DNR expects.

## How the redirect works

- **Regex filter:** `^mailto:([^?]*).*`
  - Matches any `mailto:` URL and captures the address portion up to
    an optional `?` (so `mailto:foo@bar.com?subject=hi` still yields
    `foo@bar.com`).
- **Substitution:** the user template with `{email}` replaced by
  `\1`, and any literal `\` in the template doubled (DNR's
  substitution syntax uses `\` as the escape character).
- **Resource types:** `main_frame` and `sub_frame` — we only need to
  intercept actual navigations.

Chrome enforces the redirect before the `mailto:` handoff happens, so
the email client never opens and no DOM manipulation is needed.

## URL template format

- Free-form string; substring `{email}` is replaced with the captured
  email at navigation time.
- The captured email is spliced in verbatim (typically already a
  valid URL component like `foo@bar.com` or `foo%40bar.com`).
- Default: `https://www.google.com/search?q={email}`.

## Storage layout

- Area: `chrome.storage.sync`.
- Key: `config`.
- Value shape: `{ urlTemplate: string }`.
- Missing/partial values fall back to `DEFAULT_CONFIG`.

## Permissions

- `storage` — persist the template across devices.
- `declarativeNetRequest` — install the redirect rule.
- `host_permissions: ["<all_urls>"]` — DNR redirect actions require
  host access for the initiator and redirect target; since the target
  is user-configurable, the broad permission is the simplest fit.
