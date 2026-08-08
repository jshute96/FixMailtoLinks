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
- Loads the saved config from `chrome.storage.sync`, normalizing it
  (see *Configuration*) rather than trusting the stored value.
- Listens for `chrome.storage.onChanged` so that saving new targets in
  the options page updates already-open tabs without a reload.

#### Two mechanisms, because there are two outcomes

- **A matching automatic target** is baked into the `href`. Hover,
  middle-click and copy-link-address then all show the real
  destination.
  - On first run it walks the DOM and rewrites all
    `a[href^="mailto:"]` anchors.
  - A `MutationObserver` catches links added later by SPAs or async
    renders, and re-rewrites if a page swaps `href` back to `mailto:`.
- **No matching automatic target** leaves the `href` as `mailto:`, and
  a capture-phase `click` listener on the document opens the chooser
  dialog instead.
  - The listener bows out for modified clicks (Ctrl/Cmd/Shift/Alt,
    non-primary button), so "open in new tab" still works.
  - On a `mailto:` link it does claim the event outright
    (`stopPropagation` at document capture), so the page's own click
    handlers on that link don't run.
  - It finds the anchor via `composedPath()`, so links inside a page's
    own shadow DOM are covered.
  - It is registered **before** the config load is awaited. Reading
    storage takes long enough at `document_start` that a click can land
    first, and an unintercepted one hands off to the OS mail app.
  - It re-checks for an automatic target before showing the dialog,
    since it can run before the config has arrived, or on an anchor
    added between the first rewrite pass and the observer starting.

#### Tracking the original address

- Stashes the original `mailto:` href on a
  `data-fix-mailto-original` attribute so a config change can
  re-derive the email instead of re-parsing the rewritten URL.
- If the new config has nothing to open directly, the attribute
  is dropped and the `mailto:` href restored.
- If a page repoints an already-rewritten link at some other
  non-`mailto:` URL, the observer **drops** that attribute. Keeping
  it would let the next config change re-derive the old address
  and clobber the href the page deliberately set.
- Our own rewrites reach that same code path, so the observer only
  drops the attribute when the current href differs from what the
  current config produces for the stashed address.
- The observer reads the element's *live* href, not the value in the
  mutation record: records arrive in batches, so by delivery time the
  element and the active config may both have moved on.
- `setHref()` never writes a value that is already there.
  `setAttribute` queues a mutation record even for an unchanged value,
  and the observer reacts to href changes — a no-op write would feed
  itself forever.

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

### Background service worker (`src/background.ts`)

- Opens the options page **in a tab** — both for the toolbar icon and
  for `{ type: 'openOptions' }` messages from the dialog. It used to
  open a small popup window, which was easy to lose behind other
  windows and too small for the target list.
- Kept intentionally tiny — all rewriting logic lives in the
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
- **Cancel** re-reads storage into the form, discarding edits.
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
  - The full href is preserved separately — in
    `data-fix-mailto-original` and the dialog's hand-off link — so
    nothing is lost for the one consumer that wants a real `mailto:`.

### Validation

- A template must be an absolute `http://` or `https://` URL
  (leading/trailing whitespace is trimmed first).
- The restriction isn't cosmetic — each rejected shape breaks the
  extension in a distinct way:
  - **Empty** rewrites every href to `""`, i.e. a link back to the
    current page.
  - **`mailto:`** makes the content script's own output look like a
    fresh `mailto:` link to its own `MutationObserver`. `setAttribute`
    queues a mutation record even when the value doesn't change, so
    this loops without bound and hangs the page.
  - **`javascript:`** would inject script-executing hrefs into every
    page the user visits.
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
- Domains are normalized rather than rejected: `@abc.com`, `*.abc.com`
  and `ABC.com.` all mean `abc.com`, and rejecting input that obviously
  expresses the right intent would just be rude.

## Storage layout

- Area: `chrome.storage.sync`.
- Key: `config`.
- Value shape: `{ targets: TargetConfig[] }`.
- Missing or unrecognizable values fall back to `DEFAULT_CONFIG`. An
  explicitly empty `targets` array is kept as-is — it's a real choice.

## Testing

Playwright e2e specs in `tests/e2e/`, run with `npm test`. There are no
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
  at it and assert a rewritten link really goes somewhere.
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

- **Always assert with polling matchers** (`toHaveAttribute`,
  `expect.poll`). The content script awaits a `chrome.storage.sync.get`
  before its first rewrite pass, so a link is briefly still `mailto:`
  after load; a bare `getAttribute` races it.
- **Before asserting a negative** (e.g. "this link was left alone"),
  first assert some positive rewrite happened. Otherwise the test passes
  against an extension that simply hasn't run yet.
- **Traces are `on-first-retry`, not `retain-on-failure`.** Recording
  against the long-lived worker-scoped context eventually stalls the
  trace fixture past its own 30s timeout, failing whichever test is next.
- **`tsconfig.json` does not cover `tests/`** — it is scoped to the
  extension build. Run `npm run typecheck` (`tsconfig.tests.json`) to
  typecheck specs; Playwright transpiles them without checking types.
