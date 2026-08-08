// Content script: rewrites mailto: links on the page to follow the
// user-configured URL template.
//
// Strategy:
//   1. Load the config from synced storage.
//   2. Walk existing <a href="mailto:..."> elements and rewrite them.
//   3. Watch for DOM mutations so links added later (SPAs, async
//      renders) also get rewritten.
//   4. Re-run when the config changes so already-rewritten tabs pick
//      up the new template without a reload.
//
// This file deliberately avoids `import` because MV3 content scripts
// don't support static ES module imports. The shared helpers are
// duplicated (in very short form) here and in `config.ts`.

interface ContentConfig {
  urlTemplate: string;
}

const DEFAULT_TEMPLATE = 'https://www.google.com/search?q={email}';
const STORAGE_KEY = 'config';

// Stash the original mailto: href on the element so we can:
//   - skip re-processing links we already rewrote
//   - re-derive the email if the template changes
const ORIGINAL_ATTR = 'data-fix-mailto-original';

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

function rewriteUrl(template: string, email: string): string {
  return template.replace(/\{email\}/g, encodeURIComponent(email));
}

// Mirrors normalizeTemplate() in config.ts (see the header comment on
// why this file duplicates instead of importing). A stored template can
// be empty or use a scheme that breaks us — notably `mailto:`, which
// would make our own rewrite look like a fresh mailto: link to the
// observer below and loop forever — so never trust storage directly.
function normalizeTemplate(template: string | undefined): string {
  const trimmed = (template ?? '').trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : DEFAULT_TEMPLATE;
}

function rewriteAnchor(a: HTMLAnchorElement, cfg: ContentConfig): void {
  const original =
    a.getAttribute(ORIGINAL_ATTR) ?? a.getAttribute('href') ?? '';
  const email = emailFromMailto(original);
  if (!email) return;
  if (!a.hasAttribute(ORIGINAL_ATTR)) {
    a.setAttribute(ORIGINAL_ATTR, original);
  }
  a.setAttribute('href', rewriteUrl(cfg.urlTemplate, email));
}

function rewriteAll(root: ParentNode, cfg: ContentConfig): void {
  // Pick up both original mailto: links and links we've already
  // rewritten (so config updates take effect).
  const selector = `a[href^="mailto:" i], a[${ORIGINAL_ATTR}]`;
  const anchors = root.querySelectorAll<HTMLAnchorElement>(selector);
  for (const a of anchors) rewriteAnchor(a, cfg);
}

let currentConfig: ContentConfig = { urlTemplate: DEFAULT_TEMPLATE };

function observe(): void {
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'childList') {
        for (const node of rec.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          if (el.matches?.('a')) {
            rewriteAnchor(el as HTMLAnchorElement, currentConfig);
          }
          rewriteAll(el, currentConfig);
        }
      } else if (
        rec.type === 'attributes' &&
        rec.attributeName === 'href' &&
        rec.target instanceof HTMLAnchorElement
      ) {
        // Href changed under us. Note we read the *current* href rather
        // than the recorded one: records are delivered in batches, so by
        // the time we see them the element (and currentConfig) may have
        // moved on, and the live value is what we actually care about.
        const a = rec.target;
        const href = a.getAttribute('href') ?? '';
        if (href.toLowerCase().startsWith('mailto:')) {
          // Pointed back at mailto: — treat it as a brand new link so the
          // stashed original is re-derived from this address, not the old.
          a.removeAttribute(ORIGINAL_ATTR);
          rewriteAnchor(a, currentConfig);
        } else if (a.hasAttribute(ORIGINAL_ATTR)) {
          // The page changed an already-rewritten link to some non-mailto
          // URL of its own. Drop our marker so a later template change
          // doesn't resurrect the old address and clobber the page's
          // deliberate href. We must not drop it for our *own* writes,
          // which also land here — those match the current template.
          const email = emailFromMailto(a.getAttribute(ORIGINAL_ATTR) ?? '');
          if (!email || href !== rewriteUrl(currentConfig.urlTemplate, email)) {
            a.removeAttribute(ORIGINAL_ATTR);
          }
        }
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
}

async function main(): Promise<void> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const cfg = stored[STORAGE_KEY] as Partial<ContentConfig> | undefined;
  currentConfig = { urlTemplate: normalizeTemplate(cfg?.urlTemplate) };
  rewriteAll(document, currentConfig);
  observe();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!(STORAGE_KEY in changes)) return;
    const next = changes[STORAGE_KEY].newValue as
      | Partial<ContentConfig>
      | undefined;
    currentConfig = { urlTemplate: normalizeTemplate(next?.urlTemplate) };
    rewriteAll(document, currentConfig);
  });
}

void main();
