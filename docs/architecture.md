# Architecture

High-level design of the Fix Mailto Links extension.

## Goals

- Stop `mailto:` links on every page from opening an email app.
- Let the user configure where they go instead, per email domain, with
  more than one possible destination.
- Ask, rather than guess, when no single destination is the obvious
  answer.
- Persist that configuration across devices via Chrome sync.

## Why a content script (and not `declarativeNetRequest`)

We intercept clicks in the page via an injected content script. The
obvious-looking alternative — a `declarativeNetRequest` (DNR) redirect
rule matching `^mailto:...` — does not work, and it's worth capturing
why so we don't try it again.

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
  The `href` is resolved by the renderer, in the page, at click
  time. Cancelling that click (or rewriting the `href` beforehand)
  is the only mechanism available to an extension that reliably
  changes what happens when a `mailto:` link is clicked.

So: the content script isn't an implementation preference — it's the
only layer where we can meaningfully intervene.

### What a click listener still can't catch

Everything below reaches the OS mail app regardless. All of it is
accepted; none of it has a fix available at this layer.

- **`mailto:` navigation from script** — a page doing
  `location.href = 'mailto:…'` from a button. There is no click on a
  `mailto:` anchor to cancel, and the external-protocol hand-off is
  invisible to every extension API.
- **A `mailto:` typed into the address bar**, or opened from another
  application.
- **The link's context menu** — *Open link in new tab* / *Copy link
  address* both give the raw `mailto:`. See *Why not rewrite hrefs*.
- **Frames the content script can't be injected into** —  a `data:` URL
  iframe, or a sandboxed frame with an opaque origin.
  `match_origin_as_fallback` (Chrome 105+) would cover these; it hasn't
  been judged worth the minimum-version floor.

The alternative that *would* catch the address bar and script-driven
cases is a web-hosted `mailto` protocol handler
(`registerProtocolHandler`, the mechanism Gmail uses). Rejected because:

- It needs a page served from a real https origin, which this extension
  otherwise doesn't have.
- Registering it takes a user gesture and a permission prompt.
- It can't navigate in place, and per-domain rules would have to move
  to that hosted page.

## Pieces

### Shared globals, not ES modules

- `config.ts` and `dialog.ts` are **global scripts**: no top-level
  `import` or `export`, so everything they declare is a global in
  whichever world they load into.
- That shape is forced by MV3: content scripts can't use static ES
  module imports, so the only way to share real code between the
  content script and the extension's own pages is to load the same
  classic script in both.
  - Manifest `content_scripts.js`: `config.js`, `dialog.js`,
    `content.js`, in that order.
  - `options.html`: plain `<script src>` tags for the first two, then
    `<script type="module" src="options.js">`.
- `options.ts` is the only module, and modules can still read globals.
- The earlier design duplicated the shared helpers inline in
  `content.ts`. With the dialog needing to run on the options page too,
  that stopped being tenable.

### Content script (`src/content.ts`)

- Runs at `document_start` on all URLs and all frames.
- `match_about_blank` is set so the script also reaches frames with
  no URL of their own — `about:blank` and `srcdoc` iframes, which
  inherit their parent's origin. Some embeds build their content
  that way; without this they'd be skipped entirely.

#### Passive by default

The page is never read, written, or observed until the user acts. All
the script does at `document_start` is register three listeners.

- A page with no `mailto:` links — the normal case — is left
  byte-identical, and never triggers a storage read.
- No `MutationObserver`, so links added later by SPAs or async
  renders need no special handling: the listeners are delegated on
  the document and see them for free.
- The `href` is read at click time, so a link the page repoints at
  `mailto:` later is picked up with no bookkeeping.

This replaced an earlier design that rewrote every `mailto:` href up
front and kept it current with a `MutationObserver`. See *Why not
rewrite hrefs* below.

#### Interception points

Link activation reaches two different events, and both are cancelable:

- **`click`** — primary button, including the Ctrl/Cmd/Shift variants.
- **`auxclick`** — middle button. Middle-click does *not* fire `click`.

Both are registered on **`window`**, in the capture phase — not on
`document`:

- Capture reaches `window` first, so a page listener there calling
  `stopPropagation()` (overlay and analytics libraries do this) would
  starve a document-level listener, and the `mailto:` would escape.
- The content script runs at `document_start`, so it is first on the node
  that sees the event first. Nothing the page registers later can get in
  front of it.

Both handlers:

- Find the anchor via `composedPath()`, so links inside a page's own
  shadow DOM are covered.
- Test `a.href`, the **resolved** URL, not the raw attribute. Chrome
  strips leading/trailing whitespace and embedded tabs and newlines
  before resolving, so `  mailto:x@y.com` and even `mai<TAB>lto:x@y.com`
  are links it will hand to the mail app.
  - Under the old design missing one was only a skipped rewrite, and the
    click listener caught it anyway. Now the parse is the only defence,
    so a miss is an escape.
  - Resolving lower-cases the scheme and leaves the rest alone, so
    percent-encoding and the address's own case survive for the dialog's
    verbatim hand-off.
- Ignore the dialog's own `mailto:` bullet, which carries
  `data-fix-mailto-passthrough`.
- Claim the event outright on a `mailto:` link (`preventDefault` plus
  `stopPropagation` at window capture), so the page's own handlers
  for that link don't run.
- Call `preventDefault()` **synchronously**, before any `await`: once
  the handler returns, the browser is free to follow the `mailto:`.
- Leave Alt-click alone. It means "download the target", which is not
  a navigation to redirect.

#### Links with no single recipient

Two shapes carry no one address to look up, and both are handled the
same way (`addressCount` in `config.ts` tells them apart):

- **None** — `mailto:?subject=…&body=…`, what "share this page by
  email" buttons use.
- **Several** — `mailto:a@x.com,b@y.com`. A `mailto:` may legally list
  more than one recipient.

Both are **claimed like any other click**. Letting one through opens the
mail app, which is the one outcome the extension exists to prevent. So
`emailFromMailto` distinguishes two empty results: `null` means "not a
`mailto:` at all", `''` means "a `mailto:` with no recipient".

Neither can be looked up, so neither gets a target:

- An empty `emailDomain` matches every *address* — not the absence of
  one, and not a list of several.
- A template takes a single address. Substituting a list looks up a
  person who doesn't exist, and the domain rules could only ever match
  one of the recipients.
- `matchingTargets` and `autoTarget` both return nothing, so **open
  directly never applies** and the dialog always opens.

What the dialog does with them:

- Drops the copy buttons — "Copy username" has no answer for a list, and
  none at all for an empty link.
- Says which of the two it is, rather than "no link targets match",
  which would blame settings that could not have helped.
- Still offers the hand-off to the mail app, subject and body intact.
  That is the one thing that behaves correctly either way.

Counting the recipients, which is what the whole rule rests on:

- The set is the **path address plus every `to` hfield**, comma-joined —
  RFC 6068 allows either or both, so `mailto:a@x.com?to=b@y.com` names
  two people. Reading one source alone would look someone up and drop
  the rest silently.
- The query is split by hand rather than with `URLSearchParams`, which
  would read a `+` in a local part as a space.
- Splitting the list ignores commas inside quotes or angle brackets. The
  href is percent-decoded first, so a `%2C` in a quoted local part is a
  literal comma by then, and `"Smith, Eve" <eve@example.com>` is one
  recipient however it was written.

#### Where the destination opens

The modifier decides, mirroring what it would have done on an
ordinary link:

| Click | Opens in |
| --- | --- |
| plain | current frame (`location.href`) |
| plain, `target="_blank"` | new tab, in front |
| plain, `target="_top"` / `_parent` | that frame |
| Ctrl / Cmd | background tab |
| middle | background tab |
| Shift | new window |

The `target` cases exist because following the `href` used to honour
them for free:

- Without them a targeted `mailto:` link navigates whatever frame it
  happens to sit in, which for an ad-style iframe is the wrong one.
- **Not supported**: named targets (`target="frame-name"`) and
  `<base target>`. `a.target` doesn't reflect `<base>`, and resolving a
  frame by name is more machinery than a `mailto:` link has needed.
  Both fall back to the current frame.
- Navigating a cross-origin ancestor can be refused; that falls back to
  the current frame rather than swallowing the click.

How the new tab or window is opened:

- By the **service worker** (`chrome.tabs.create` /
  `chrome.windows.create`), not `window.open`. `window.open` focuses
  what it opens, whereas Ctrl-click and middle-click open a tab in the
  *background*. The worker also knows the opener's position, so the new
  tab lands next to it.
- Only for **trusted** events. `chrome.tabs.create` is not gated on user
  activation the way `window.open` is, so without an `isTrusted` check a
  page could dispatch synthetic Ctrl-clicks at its own `mailto:` links
  and spawn tabs without limit. An untrusted click still navigates,
  which is what following a rewritten `href` used to do.
- If there is no automatic target, a click that asked to open elsewhere
  still gets the dialog — the request is remembered, and the target the
  user picks opens in a new tab. All three away-from-here modes collapse
  to one there: the dialog's links can carry `target`, but not
  "background" or "new window".

#### Loading the config

- Read from `chrome.storage.sync` at most once per frame, and only
  once the user has shown interest in a `mailto:` link.
- Prefetched on `pointerdown` over such a link, so the `click` that
  follows can usually decide synchronously and navigate with no pause.
  That listener is `passive` — cancelling `pointerdown` would suppress
  the whole mousedown/click sequence.
- When the prefetch hasn't happened (keyboard activation) or hasn't
  resolved, the handler cancels the event first and awaits the load.
- After the first read, a `chrome.storage.onChanged` listener keeps the
  cached value current, so saving new targets in the options page
  affects already-open tabs without a reload.
- If storage is unreachable — the extension was reloaded while the page
  stayed open — the frame falls back to "no targets", which still gets
  the user a dialog rather than a click that does nothing.
  - The fallback wraps the *whole* chain, listener registration
    included. In that state every `chrome.storage` call throws, so a
    guard around only the read would let the failure through and leave
    the frame permanently unable to handle a click.
  - The `onChanged` listener is registered **before** the read starts,
    so a save landing mid-read isn't missed, and the newer value isn't
    overwritten by the older one the read returns.

#### Why not rewrite hrefs

The original design baked the destination into the `href`. That made
hover, middle-click and copy-link-address all show the real URL for
free.

It was dropped because the machinery it needed was out of proportion to
what it bought:

- A document-wide `MutationObserver` on every frame of every page,
  including the overwhelming majority with no `mailto:` links at all.
- Attribute bookkeeping (`data-fix-mailto-original`) to re-derive the
  address on a config change, plus the rules for when to abandon a link
  the page had repointed itself.
- A feedback-loop hazard: the observer watched `href` changes and the
  rewriter wrote them.

The observer's cost was measured before removing it, on pages with no
`mailto:` links. Method: a one-off Playwright harness (not kept in the
repo) timing synthetic DOM churn with the observer attached vs not, and
page loads with the unpacked extension loaded vs not.

- ~8 ms per 40,000 nodes inserted, of which ~5 ms was the callback and
  the rest mutation recording.
- Under 1 ms at realistic SPA render sizes (10k nodes and below).
- No page-load delta outside run-to-run noise, at 0, 5 and 30 frames.

So the performance cost was small. It was the complexity, not the
milliseconds, that decided this.

What that costs, and is accepted:

- Hovering shows `mailto:…` in the status bar, not the destination.
- Right-click → *Copy link address* / *Open link in new tab* give the
  `mailto:`. A context menu can't be intercepted from a click handler,
  and adding the `contextMenus` permission wasn't judged worth it.
- Dragging a link carries the `mailto:` URL.

### Chooser dialog (`src/dialog.ts`)

- Shown when a clicked `mailto:` link has no automatic target.
- Contents, top to bottom:
  - The extension name (read from the manifest) as the heading.
  - **Link** — the original `mailto:` href.
  - **Copy username** / **Copy email address** buttons, with the
    "Copied" confirmation beside them.
  - **Open with** — a bullet list: every matching target in configured
    order, then the
    original `mailto:` href as the last bullet, so handing off to the
    email app stays available (and keeps any `?subject`/`&body` the
    page supplied).
  - **Cancel**, and **Configure link targets** (asks the service
    worker to open the options page in a tab).
- Both places that show the `mailto:` — the **Link** box and the last
  bullet — percent-decode it for display. Pages often encode the whole
  href, and `mailto:%22Eve%20Smith%22%20%3Ceve@example.com%3E` is not
  something to ask anyone to read. The `href` keeps the original bytes,
  so the hand-off to the email app is unchanged.
- Targets are labelled by site — `google.com`, not the whole expanded
  URL, which is long, mostly boilerplate, and says nothing about which
  destination it is. The full URL is the link's `title`.
- Every bullet is a real `<a>`, so middle-click and Ctrl-click behave
  normally. `openInNewTab` puts `target="_blank"` on the *target* links
  only — never on the `mailto:` bullet, where the handoff to the email
  app would strand an empty tab.
- Escape is listened for on the **window**, in capture, for the same
  reason the click listeners are: a page listener there calling
  `stopPropagation()` would otherwise leave the dialog with no keyboard
  way out.
- Rendered into an open shadow root so page CSS can't restyle or hide
  it, and page scripts querying the DOM don't trip over our nodes.
  `:host` carries the fixed, viewport-filling box — `all: initial`
  alone would leave the host a zero-size inline element.
- The dialog's own `mailto:` bullet carries
  `data-fix-mailto-passthrough` so the content script's click listener
  lets it through instead of re-opening the dialog.
- Rendered into `window.top.document` when that is same-origin and
  reachable, so a link clicked in a small iframe isn't clipped to the
  frame. Falls back to the local document for cross-origin frames.
- Clipboard writes go through `navigator.clipboard`, falling back to a
  hidden textarea plus `document.execCommand('copy')` where the async
  API is denied (permissions policy, unfocused frame).
- For a link with no single recipient the copy buttons are omitted and
  the empty-list line names the reason (no address, or several) rather
  than saying no target matched — only that last one is something the
  user could configure their way out of.

Known gaps, none of them yet judged worth the code:

- No `aria-labelledby` on the panel, no focus trap (Tab walks into the
  page behind the overlay), and focus isn't returned to the clicked link
  on close.
- Light palette only — no `prefers-color-scheme` handling, so it glares
  on a dark page.

### Background service worker (`src/background.ts`)

- Opens the options page **in a tab** — both for the toolbar icon and
  for `{ type: 'openOptions' }` messages from the dialog. It used to
  open a small popup window, which was easy to lose behind other
  windows and too small for the target list.
- Opens a destination **in a background tab or a new window** for
  `{ type: 'openLink' }` messages, which is how the content script
  serves Ctrl-click, middle-click and Shift-click. It lives here
  because only the extension APIs can open a tab without focusing it,
  and because `sender.tab` gives the opener's window and position.
  - Re-checks that the URL is `http(s)` first. This is the boundary
    where a stored template turns into a real navigation, which is
    worth a guard even though the options page validates on entry.
- Otherwise kept tiny — all the matching and dialog logic lives in the
  content script.

### Options page (`src/options.html` + `src/options.ts`)

- Edits the ordered target list: one row per target, with Add, move
  up/down, and remove controls.
- **Save** validates every row and refuses the whole save on the first
  bad URL, showing an error.
  - Rejecting beats silently substituting or dropping the row: that
    would throw away what the user typed.
  - Confirmations fade after a moment; errors stay until the user edits
    a row. A message you have to catch within seconds is no use when
    it's saying the save didn't happen.
  - A write that storage *refuses* — sync off, the per-item size cap,
    the write-rate quota — shows `Save failed: <reason>` in the same
    place, equally sticky. Showing nothing would read as a save that
    worked.
  - The two refusals a user can provoke are reworded: Chrome says
    `QUOTA_BYTES_PER_ITEM quota exceeded`, which is not a sentence to
    show anyone. Anything else falls back to what was thrown.
- **Cancel** re-reads storage into the form, discarding edits, and
  reports a failed read the same way: the form would otherwise still be
  showing the edits it claimed to have discarded.
- **A failed read at load** shows the same message and **disables
  Save**. An empty form there means the read failed, not that no targets
  are configured — and saving it would write that empty list over
  settings nobody ever saw. A reload is the way out.
- Each row's move-up/move-down button is disabled at the end of the
  list it can't move past.
- Sets `data-ready` on `<body>` once the first render completes, since
  that render waits on an async storage read.

#### The "Test it" section

- Two lines, each a text field and a live `mailto:` link whose text and
  href track it. Defaults `nobody@example.com` and `nobody@example.net`,
  so a per-domain config can be tried against addresses that match
  differently without retyping.
- Clicking it runs the **live form**, not what's in storage, so a
  target can be tried before committing to it. Rows with an unusable
  URL normalize away rather than blocking the test.
- Everything opens in a new tab here — a target followed automatically,
  and the dialog's target links via `openInNewTab` — so the unsaved
  edits being tested survive. On a live page the same links navigate in
  place.
- **Configure link targets** is shown but given no handler here:
  closing the dialog already puts the user back on the settings.
- The content script does **not** run on `chrome-extension://` pages,
  which is exactly why the dialog had to become shared code rather
  than living inside `content.ts`.

### Shared config (`src/config.ts`)

- Types (`Config`, `TargetConfig`), `DEFAULT_CONFIG`, `STORAGE_KEY`,
  validation/normalization, the matching rules, and
  `loadConfig` / `saveConfig`.
- Also owns `emailFromMailto`, the `mailto:` href parser.

## Configuration

A config is an **ordered list of targets**. Each target has:

- `emailDomain` — matched against the domain of the *email address*,
  not the page. Empty matches every address.
- `urlTemplate` — where to send the address.
- `openDirectly` — go straight there instead of asking. Shown in the
  options page as **Open directly**.

### Matching rules

- Targets are checked top to bottom.
- An empty `emailDomain` matches everything. A domain also matches its
  subdomains (`abc.com` covers `mail.abc.com`) — corporate mail often
  arrives from a subdomain and users don't expect to list each one.
- The click follows the **first matching target with
  `openDirectly`** set. A non-automatic target that matches
  earlier does *not* suppress a later automatic one — an entry that
  only wants to appear in the dialog shouldn't block one the user asked
  us to follow.
- If no automatic target matches, the dialog opens listing **all**
  matching targets in order.
- An empty target list is legitimate: it means "always ask".
- A link with **no address**, or with **several**, matches nothing
  whatever is configured, and is never opened directly — see *Links with
  no single recipient*.

### URL template format

- Free-form string with two placeholders:
  - `{email}` — the whole address as parsed from the link.
  - `{username}` — the part before the `@`, which is what corporate
    people-directory lookups usually want.
- Both are URL-encoded on substitution, which is not optional. A local
  part can legally contain characters that would otherwise change the
  URL's meaning:
  - `+` — read as a space by query parsers.
  - `&` and `=` — would split the query into extra parameters.
  - `#` — would truncate the rest into a fragment.
  - Spaces, inside a quoted local part.
- `@` is the exception, and is left readable. RFC 3986 permits it
  unescaped in both path and query, so `?q=nobody@example.com` beats
  `?q=nobody%40example.com` in the address bar at no cost.
- Default target: `https://www.google.com/search?q={email}`, matching
  any domain, **not** opened directly — a fresh install shows the
  chooser rather than silently redirecting the first link clicked.
- An address can carry a display name (`"Eve Smith" <eve@example.com>`).
  RFC 6068 doesn't allow this, but it turns up in the wild.
  - Both placeholders, the domain match, and the dialog's copy buttons
    all use the address from inside the angle brackets.
  - The full href is never altered, and the dialog's hand-off link
    uses it verbatim, so nothing is lost for the one consumer that
    wants a real `mailto:`.

### Validation

- A template must be an absolute `http://` or `https://` URL
  (leading/trailing whitespace is trimmed first).
- The restriction isn't cosmetic — each rejected shape breaks the
  extension in a distinct way:
  - **Empty** sends the click to `""`, i.e. back to the current page.
  - **`mailto:`** hands straight back to the OS email app — the one
    outcome the extension exists to prevent.
  - **`javascript:`** would run script in the page on every click, and
    would be a script-executing link in the dialog.
- A separate check, `templateUsesAddress`, requires the template to
  mention `{username}` or `{email}`. It is enforced **only** where
  targets are entered (the options page), not in `normalizeConfig`:
  unlike the rules above, a placeholder-free template still works — it
  just sends every address to one fixed page — so dropping one already
  in storage would destroy a working setup over a matter of taste.
- The scheme rules are enforced in two places, deliberately:
  - The options page rejects the save outright.
  - Every reader normalizes: `normalizeConfig` drops targets whose
    template is unusable. Storage is synced, so a bad value can still
    arrive from another device or a build that predates this
    validation.
  - The service worker re-checks before opening a new tab or window,
    the last point before a stored value becomes a navigation.
- Domains are normalized rather than rejected: `@abc.com`, `*.abc.com`
  and `ABC.com.` all mean `abc.com`, and rejecting input that obviously
  expresses the right intent would just be rude.

## Permissions and exposure

- `storage` is the **only** permission requested. Host access comes from
  the content script's `<all_urls>` match, and nothing is ever read out
  of a page — see *Passive by default*.
- `web_accessible_resources` exposes `icons/icon-48.png` to every
  origin, because the dialog renders into the page's document and the
  page has to be allowed to load it.
  - That makes the extension **detectable**: any page can probe
    `chrome-extension://<id>/icons/icon-48.png`.
  - `use_dynamic_url` would hide it, but `chrome.runtime.getURL` returns
    the static URL, which is what the dialog's `<img>` uses — so it
    would cost the icon. Accepted as-is.
- Messages are only receivable from the extension's own contexts: there
  is no `externally_connectable`, so no web page can talk to the service
  worker directly.

## Storage layout

- Area: `chrome.storage.sync`.
- Key: `config`.
- Value shape: `{ targets: TargetConfig[] }`.
- Missing or unrecognizable values fall back to `DEFAULT_CONFIG`. An
  explicitly empty `targets` array is kept as-is — it's a real choice.

## Testing

Playwright e2e specs in `tests/e2e/`, run with `pnpm test`. There are no
unit tests — every interesting behaviour needs a real extension in a
real browser.

### How the harness works

- `tests/fixtures/extension.ts` launches a persistent Chromium with
  `dist/` loaded unpacked, and exposes the MV3 service worker.
- The context is **worker-scoped** (one browser per Playwright worker,
  reused across tests) because a fresh launch costs ~1s each.
- The service-worker handle is **test-scoped**: MV3 workers idle out and
  respawn, which invalidates a cached handle.
- Specs open their own page via `extensionContext.newPage()` and close
  it themselves.

### Fixture pages

- Served over `http://` from `tests/fixtures/pages/` by a local server
  bound to port 0. A real origin is required — unpacked extensions get
  no `file://` access, and `data:` URLs aren't matched by `<all_urls>`.
- `link_page.html` — the main target: plain, mixed-case, parameterized,
  nested, and dynamically-added `mailto:` links, plus a non-mailto
  control. Also usable by hand in a normal browser.
- `landing.html` — navigation target, so a spec can point the template
  at it and assert a click really lands on a page.
- `iframe_page.html` — a `srcdoc` frame and an `about:blank` frame,
  each holding a `mailto:` link, plus a top-frame link as a positive
  control. Covers the `match_about_blank` manifest setting.

### The `config` fixture

- Reads/writes the extension's synced config through the service worker.
- `setTargets` writes a target list; `setTemplate` is shorthand for the
  common one-automatic-catch-all case.
- `setRaw` writes an arbitrary value under the config key, so specs can
  exercise shapes the options page would never produce — junk synced
  from another device.
- Resets storage before and after every test. This matters because the
  browser context is shared: without it, a test that sets a custom
  config leaks into its siblings.

### Gotchas worth knowing

- **Playwright locators pierce the dialog's open shadow root**, so it
  can be addressed with ordinary role/text selectors under
  `#fix-mailto-links-dialog`. Its `toBeVisible()` only works because
  `:host` has a real box; a zero-size host reads as hidden.

- **Where a link goes is only observable by clicking it.** Nothing is
  written to the page, so there is no href to inspect. Specs click,
  then assert on the resulting navigation, and re-load the fixture page
  between assertions.
- **Always assert with polling matchers** (`expect.poll`,
  `toHaveAttribute`). The first click in a frame awaits a
  `chrome.storage.sync.get` before it navigates.
  - Prefer `expect.poll(() => page.url())` over `toHaveURL` for exact
    URLs: the expected values contain `?` and `*`, which some matcher
    overloads read as glob metacharacters.
- **Before asserting a negative** (e.g. "this link was left alone"),
  first assert something positive happened. Otherwise the test passes
  against an extension that simply hasn't run yet.
- **Stub external hosts on the context, not the page** (see
  `STUB_HOSTS`), so tabs the extension opens are covered too.
  - Even then, a tab created by the service worker can start loading
    before Playwright attaches its routing. Specs that assert on
    Ctrl/middle/Shift-click point at the local fixture server instead,
    which needs no interception.
- **The content script calls `stopPropagation()`** on clicks it claims.
  A probe listener must be a *capture* listener on `window` — the same
  node — to still see those events. On `document` it sees only the
  clicks the extension passed through, which reads as a pass for the
  wrong reason.
- **`chrome.storage.sync` rations writes** (`MAX_WRITE_OPERATIONS_PER_MINUTE`,
  120). The `config` fixture resets before *and* after every test, so an
  unconditional remove blows the quota once the suite is big enough and
  fails a random test. `reset()` reads first and only writes when there
  is something to clear.
- **Traces are `on-first-retry`, not `retain-on-failure`.** Recording
  against the long-lived worker-scoped context eventually stalls the
  trace fixture past its own 30s timeout, failing whichever test is next.
- **`tsconfig.json` does not cover `tests/`** — it is scoped to the
  extension build. Run `pnpm run typecheck` (`tsconfig.tests.json`) to
  typecheck specs; Playwright transpiles them without checking types.
