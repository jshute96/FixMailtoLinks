// Shared config types, defaults, matching rules, and storage helpers.
//
// This file is deliberately a *global* script, not an ES module: it has
// no top-level `import` or `export`. MV3 content scripts can't use
// static ES imports, so the only way to share real code between the
// content script and the extension's own pages is to load the same
// classic script in both places — via `content_scripts` in the manifest
// and a plain <script> tag in options.html. Every declaration below is
// therefore a global in whichever world the file is loaded into.
//
// The same applies to `dialog.ts` and `content.ts`. Only `options.ts` is
// a module, and modules can still read these globals.

// One configured destination for a mailto: address.
interface TargetConfig {
  // Domain of the *email address* (not the page) this target applies
  // to, e.g. `abc.com`. Empty matches every address.
  emailDomain: string;
  // URL to send the address to. `{email}` and `{username}` are replaced
  // with the URL-encoded address and its local part.
  urlTemplate: string;
  // When set, a click on a matching mailto: link goes straight here
  // instead of opening the chooser dialog. The options page calls this
  // "Open directly".
  openDirectly: boolean;
}

interface Config {
  // Checked in order; see matchingTargets() / autoTarget().
  targets: TargetConfig[];
}

const STORAGE_KEY = 'config';

const DEFAULT_CONFIG: Config = {
  targets: [
    {
      emailDomain: '',
      urlTemplate: 'https://www.google.com/search?q={email}',
      // Off by default: a fresh install shows the chooser dialog rather
      // than silently redirecting the first mailto: link someone clicks.
      openDirectly: false,
    },
  ],
};

// A template must be an absolute http(s) URL. This is not cosmetic —
// other schemes actively break the extension:
//   - `` (empty) sends the click to the current page.
//   - `mailto:...` hands straight back to the OS mail app, i.e. the one
//     outcome the extension exists to prevent.
//   - `javascript:...` would run script in the page on every click, and
//     in the dialog would be a script-executing link.
// The service worker applies the same http(s) test before opening a new
// tab or window, so a bad value already in storage can't get through
// that path either.
function isValidTemplate(template: string): boolean {
  return /^https?:\/\//i.test(template.trim());
}

// A target that mentions neither placeholder sends every address to the
// same fixed URL, which is never what someone means to configure. This
// is checked where targets are *entered* rather than in normalizeConfig:
// unlike the checks above, such a template still works, so dropping one
// already in storage would be destroying a working (if odd) setup over a
// matter of taste.
function templateUsesAddress(template: string): boolean {
  return /\{(username|email)\}/.test(template);
}

// The user may reasonably type `@abc.com`, `*.abc.com`, or `ABC.com.`
// when they mean the domain `abc.com`. Accept all of them rather than
// rejecting input that obviously expresses the right intent.
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^\*\./, '')
    .replace(/\.$/, '');
}

// The address inside a mailto: href can carry a display name, as in
// `"Eve Smith" <eve@example.com>`. Pull the bracketed address out before
// splitting, or the "domain" would come back as `example.com>`.
function bareAddress(email: string): string {
  const angle = /<([^>]*)>/.exec(email);
  return (angle ? angle[1] : email).trim();
}

function emailDomainOf(email: string): string {
  const addr = bareAddress(email);
  const at = addr.lastIndexOf('@');
  return at < 0 ? '' : addr.slice(at + 1).trim().toLowerCase();
}

// Split a comma-separated recipient list, ignoring commas that aren't
// separators. Both exceptions turn up in real links:
//   - inside a quoted local part — RFC 6068 requires `%2C` there, but
//     the href is percent-decoded before this sees it, so the comma is
//     literal again by now.
//   - inside a display name — `"Smith, Eve" <eve@example.com>`, which is
//     how mail clients write a surname-first name.
// Splitting naively would read either as two recipients and send a
// perfectly ordinary link to the dialog.
function splitAddresses(list: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const ch of list) {
    if (ch === ',' && !quoted && !angled) {
      parts.push(current);
      current = '';
      continue;
    }
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === '<' && !quoted) angled = true;
    else if (ch === '>' && !quoted) angled = false;
    current += ch;
  }
  parts.push(current);
  return parts;
}

// The recipients a mailto: link names, in order, each reduced to a bare
// address. Empty entries — a trailing comma, or a path that was only
// whitespace — are dropped.
function addressList(email: string): string[] {
  return splitAddresses(email)
    .map((part) => bareAddress(part))
    .filter((part) => part !== '');
}

// How many recipients there are to look up. Only `one` can be, which is
// why this exists rather than a plain emptiness test:
//   - `none`     — `mailto:?subject=…`, the "share this page" shape.
//   - `multiple` — `mailto:a@x.com,b@y.com`. A template takes a single
//     address, so substituting a list produces a lookup for a person who
//     doesn't exist, and the domain rules can only match one of them.
// Both leave nothing a target could sensibly do, so both always get the
// dialog, which says so and hands off to the email app instead.
type AddressCount = 'none' | 'one' | 'multiple';

function addressCount(email: string): AddressCount {
  const addresses = addressList(email);
  if (addresses.length === 0) return 'none';
  return addresses.length === 1 ? 'one' : 'multiple';
}

function hasOneAddress(email: string): boolean {
  return addressCount(email) === 'one';
}

// The part before the `@`. Used for `{username}` templates, which is
// what corporate people-directory lookups usually want.
function emailUsernameOf(email: string): string {
  const addr = bareAddress(email);
  const at = addr.lastIndexOf('@');
  return at < 0 ? addr : addr.slice(0, at);
}

// A target with no domain matches everything. A domain also matches its
// subdomains, so `abc.com` covers `mail.abc.com` — corporate mail often
// arrives from a subdomain and users don't expect to list each one.
function targetMatches(target: TargetConfig, email: string): boolean {
  const domain = normalizeDomain(target.emailDomain);
  if (!domain) return true;
  const actual = emailDomainOf(email);
  return actual === domain || actual.endsWith(`.${domain}`);
}

// Both placeholders get the bare address, matching what targetMatches()
// looks at and what the dialog's copy buttons produce. A display name
// would only ever be noise in a directory lookup or a search, and the
// original href is kept verbatim elsewhere for the one consumer that
// wants it — the dialog's hand-off to the email app.
// Encoding is not optional: a local part can legally contain `+` (which
// a query parser reads as a space), `&` and `=` (which would split the
// query into extra parameters), `#` (which would truncate the rest into
// a fragment), and — inside a quoted local part — spaces.
//
// `@` is the exception. RFC 3986 allows it unescaped in both path and
// query, so escaping it only makes the URL uglier in the address bar for
// no gain. encodeURIComponent escapes it because it is written for the
// general case, so put it back.
//
// The one place a bare `@` changes a URL's meaning is inside the
// authority, where it starts the userinfo field: a template shaped
// `https://{username}.corp.example.com/` given `evil@attacker.test`
// resolves as user `evil` at `attacker.test.corp.example.com`. That is
// still a subdomain of the template's own domain, and `/`, `?` and `#`
// stay encoded so the authority can't be closed early either — so the
// destination remains wherever the template pointed, and the worst case
// is a confusing address bar. Left readable on that basis.
function encodeForUrl(value: string): string {
  return encodeURIComponent(value).replace(/%40/g, '@');
}

function expandTemplate(template: string, email: string): string {
  const addr = bareAddress(email);
  return template
    .replace(/\{email\}/g, encodeForUrl(addr))
    .replace(/\{username\}/g, encodeForUrl(emailUsernameOf(addr)));
}

// Every target that applies to this address, in configured order. This
// is what the chooser dialog lists. Nothing matches unless the link
// names exactly one recipient — an empty-domain target matches every
// *address*, not the absence of one or a list of several. See
// addressCount.
function matchingTargets(cfg: Config, email: string): TargetConfig[] {
  if (!hasOneAddress(email)) return [];
  return cfg.targets.filter((t) => targetMatches(t, email));
}

// The first matching target the user asked us to follow without asking.
// Note this skips *earlier* matching targets that aren't automatic: an
// entry that only wants to appear in the dialog shouldn't suppress a
// later one that wants to be followed straight away.
function autoTarget(cfg: Config, email: string): TargetConfig | null {
  // Never open directly without exactly one address to look up: see
  // addressCount. The dialog is the only sensible answer there.
  if (!hasOneAddress(email)) return null;
  return (
    cfg.targets.find((t) => t.openDirectly && targetMatches(t, email)) ??
    null
  );
}

// The href a mailto: link should carry, or null to leave it as mailto:
// (which means the content script handles the click and shows the
// dialog instead).
function desiredHref(cfg: Config, email: string): string | null {
  const target = autoTarget(cfg, email);
  return target ? expandTemplate(target.urlTemplate, email) : null;
}

function normalizeTarget(raw: unknown): TargetConfig | null {
  const t = raw as Partial<TargetConfig> | undefined;
  const urlTemplate = (t?.urlTemplate ?? '').trim();
  if (!isValidTemplate(urlTemplate)) return null;
  return {
    emailDomain: normalizeDomain(t?.emailDomain ?? ''),
    urlTemplate,
    openDirectly: t?.openDirectly === true,
  };
}

// Coerce whatever is in storage into a usable config. Storage is synced,
// so a bad value can arrive from another device; every reader normalizes
// rather than trusting it.
function normalizeConfig(raw: unknown): Config {
  const obj = raw as { targets?: unknown } | undefined;
  if (!obj || !Array.isArray(obj.targets)) return cloneConfig(DEFAULT_CONFIG);
  // An empty list is a legitimate choice — it means "always ask".
  return {
    targets: obj.targets
      .map(normalizeTarget)
      .filter((t): t is TargetConfig => t !== null),
  };
}

function cloneConfig(cfg: Config): Config {
  return { targets: cfg.targets.map((t) => ({ ...t })) };
}

async function loadConfig(): Promise<Config> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return normalizeConfig(stored[STORAGE_KEY]);
}

async function saveConfig(cfg: Config): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: cfg });
}

function decodePercent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// The `to` hfields of a mailto: query, comma-joined into the same shape
// an address list takes in the path. A query may carry more than one.
//
// Parsed by hand rather than with URLSearchParams, which reads `+` as a
// space; `+` is legal in a local part, and the address-part path keeps
// it verbatim. Header names are case-insensitive.
function recipientHeaders(query: string): string {
  const found: string[] = [];
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).toLowerCase() !== 'to') continue;
    const value = decodePercent(part.slice(eq + 1)).trim();
    if (value) found.push(value);
  }
  return found.join(',');
}

// Extract the address from a mailto: href, dropping any ?subject/&body
// parameters.
//
// Two distinct "no address" results, and the difference is load-bearing:
//   - null — not a mailto: link at all, so not ours to intercept.
//   - ''   — a mailto: link that names no recipient, e.g.
//            `mailto:?subject=…`, the shape "share this by email"
//            buttons use. There is nothing to look up, but the click
//            still has to be claimed: letting it through opens the OS
//            mail app, which is the one outcome this extension exists to
//            prevent.
function emailFromMailto(href: string): string | null {
  if (!href.toLowerCase().startsWith('mailto:')) return null;
  const rest = href.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const addr = decodePercent((q >= 0 ? rest.slice(0, q) : rest).trim()).trim();
  // RFC 6068 puts the recipients in the path, in `to` headers, or both —
  // `mailto:alice@x.com?to=bob@y.com` names two people. Joining rather
  // than preferring one is what keeps addressCount from reading that as
  // a single recipient and quietly dropping the other.
  const headers = q >= 0 ? recipientHeaders(rest.slice(q + 1)) : '';
  return [addr, headers].filter((part) => part !== '').join(',');
}
