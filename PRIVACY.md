# Privacy Policy — Fix Mailto Links

*Last updated: 2026-08-08*

**Fix Mailto Links collects nothing, sends nothing, and has no servers.**
The extension makes no network requests of any kind. There is no
analytics, no telemetry, no tracking, and no remote code.

## What the extension stores

- Your list of target rules — the domain patterns and target URL
  templates you enter on the Options page.
- Stored with Chrome's
  [`storage.sync`](https://developer.chrome.com/docs/extensions/reference/api/storage)
  API, so Chrome syncs it across the browsers where you're signed in.
- That sync is between you and Google, under Google's own privacy terms.
  The author of this extension has no access to it.
- Uninstalling the extension removes the stored rules.

## What the extension reads

- The `href` of `mailto:` links on pages you visit, at the moment you
  click one.
- Email addresses are parsed from that `href` in the page, used
  immediately, and never stored or logged.
- The extension needs access to all websites because `mailto:` links can
  appear on any page. It does not read, collect, or transmit page
  content beyond the link you click.

## Where email addresses can go

- When you click a `mailto:` link, the extension substitutes the address
  into a target URL **you** configured and navigates to it.
- The address is sent to whatever site your rule points at,
  exactly as if you had typed the URL yourself.
- The extension never sends addresses anywhere else.

## Clipboard

The chooser dialog's copy button writes the email address to your
clipboard. This happens only when you click that button, and the
extension never reads your clipboard.

## Changes

Any change to this policy will be published in this file in the
[project repository](https://github.com/jshute96/FixMailtoLinks).

## Contact

Questions: open an issue at <https://github.com/jshute96/FixMailtoLinks/issues>.
