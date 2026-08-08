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
//   - `` (empty) rewrites every link to href="", i.e. a self-link.
//   - `mailto:...` makes the content script's own rewrite look like a
//     fresh mailto: link to its MutationObserver, which rewrites it
//     again, forever.
//   - `javascript:...` would inject script-executing hrefs into every
//     page the user visits.
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
// is what the chooser dialog lists.
function matchingTargets(cfg: Config, email: string): TargetConfig[] {
  return cfg.targets.filter((t) => targetMatches(t, email));
}

// The first matching target the user asked us to follow without asking.
// Note this skips *earlier* matching targets that aren't automatic: an
// entry that only wants to appear in the dialog shouldn't suppress a
// later one that wants to be followed straight away.
function autoTarget(cfg: Config, email: string): TargetConfig | null {
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

// Extract the address from a mailto: href, dropping any ?subject/&body
// parameters. Returns null for anything that isn't a usable mailto:.
function emailFromMailto(href: string): string | null {
  if (!href.toLowerCase().startsWith('mailto:')) return null;
  const rest = href.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const addr = (q >= 0 ? rest.slice(0, q) : rest).trim();
  if (!addr) return null;
  try {
    return decodeURIComponent(addr);
  } catch {
    return addr;
  }
}
