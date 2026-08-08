// Content script: makes mailto: links go somewhere useful.
//
// Two mechanisms, because the config supports two outcomes:
//   - A matching target marked "follow automatically" is baked straight
//     into the href, so hover, middle-click and copy-link-address all
//     show the real destination.
//   - Otherwise the href is left as mailto: and a capture-phase click
//     handler opens the chooser dialog instead.
//
// Around that:
//   1. Load the config from synced storage.
//   2. Walk existing <a href="mailto:..."> elements and rewrite them.
//   3. Watch for DOM mutations so links added later (SPAs, async
//      renders) are handled too.
//   4. Re-run when the config changes so already-rewritten tabs pick up
//      new targets without a reload.
//
// This file is a global script (no imports); the helpers it uses come
// from `config.js` and `dialog.js`, listed ahead of it in the manifest.

// Stash the original mailto: href on the element so we can:
//   - skip re-processing links we already rewrote
//   - re-derive the email if the config changes
const ORIGINAL_ATTR = 'data-fix-mailto-original';

// PASSTHROUGH_ATTR — the dialog's own "open in your email app" link,
// which we must not re-intercept — comes from dialog.js, loaded ahead of
// this file. One declaration, so the two sides can't drift apart.

let currentConfig: Config = { targets: [] };

// setAttribute queues a mutation record even when the value doesn't
// change, and our observer reacts to href changes — so writing an
// identical value would feed itself forever. Never write a no-op.
function setHref(a: HTMLAnchorElement, href: string): void {
  if (a.getAttribute('href') !== href) a.setAttribute('href', href);
}

function rewriteAnchor(a: HTMLAnchorElement, cfg: Config): void {
  const original = a.getAttribute(ORIGINAL_ATTR) ?? a.getAttribute('href') ?? '';
  const email = emailFromMailto(original);
  if (!email) return;
  const href = desiredHref(cfg, email);
  if (href === null) {
    // Nothing to follow automatically: restore the mailto: href (if we
    // had replaced it) and let the click handler show the dialog.
    if (a.hasAttribute(ORIGINAL_ATTR)) {
      a.removeAttribute(ORIGINAL_ATTR);
      setHref(a, original);
    }
    return;
  }
  if (!a.hasAttribute(ORIGINAL_ATTR)) a.setAttribute(ORIGINAL_ATTR, original);
  setHref(a, href);
}

function rewriteAll(root: ParentNode, cfg: Config): void {
  // Pick up both original mailto: links and links we've already
  // rewritten (so config updates take effect).
  const selector = `a[href^="mailto:" i], a[${ORIGINAL_ATTR}]`;
  for (const a of root.querySelectorAll<HTMLAnchorElement>(selector)) {
    rewriteAnchor(a, cfg);
  }
}

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
          // URL of its own. Drop our marker so a later config change
          // doesn't resurrect the old address and clobber the page's
          // deliberate href. We must not drop it for our *own* writes,
          // which also land here — those match the current config.
          const email = emailFromMailto(a.getAttribute(ORIGINAL_ATTR) ?? '');
          if (!email || href !== desiredHref(currentConfig, email)) {
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

// Find the clicked anchor. composedPath() rather than event.target so a
// link inside a page's own shadow DOM is still found.
function clickedAnchor(e: MouseEvent): HTMLAnchorElement | null {
  for (const node of e.composedPath()) {
    if (node instanceof HTMLAnchorElement) return node;
  }
  const target = e.target;
  return target instanceof Element
    ? target.closest<HTMLAnchorElement>('a')
    : null;
}

// A dialog rendered inside a small iframe would be clipped to that
// frame, so prefer the top document when it's same-origin and reachable.
function dialogDocument(): Document {
  try {
    const top = window.top;
    if (top && top !== window && top.document.body) return top.document;
  } catch {
    // Cross-origin ancestor: our own document is the only one we can
    // touch. The dialog is still usable, just confined to the frame.
  }
  return document;
}

function onClick(e: MouseEvent): void {
  // Leave modified clicks (new tab/window, download) and non-primary
  // buttons to the browser, and don't fight a page that already handled
  // the event itself.
  if (e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const a = clickedAnchor(e);
  if (!a || a.hasAttribute(PASSTHROUGH_ATTR)) return;
  const mailtoHref = a.getAttribute('href') ?? '';
  const email = emailFromMailto(mailtoHref);
  if (!email) return;

  e.preventDefault();
  e.stopPropagation();

  // Normally an automatic target has already been baked into the href,
  // so a mailto: href here means "ask". But this handler is live before
  // the config finishes loading, and anchors can appear between
  // rewriteAll() and observe(), so re-check and follow it.
  const href = desiredHref(currentConfig, email);
  if (href !== null) {
    window.location.href = href;
    return;
  }

  showMailtoDialog({
    doc: dialogDocument(),
    email,
    mailtoHref,
    targets: matchingTargets(currentConfig, email),
    onConfigure: () => void chrome.runtime.sendMessage({ type: 'openOptions' }),
  });
}

async function main(): Promise<void> {
  // Before the await, deliberately. Reading storage takes long enough at
  // document_start that a click can land first, and an unintercepted
  // mailto: click hands off to the OS mail app — the one outcome this
  // extension exists to prevent. With no config yet, onClick falls
  // through to a dialog with no targets, which still offers the copy
  // buttons and the mailto: link itself.
  document.addEventListener('click', onClick, true);

  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  currentConfig = normalizeConfig(stored[STORAGE_KEY]);
  rewriteAll(document, currentConfig);
  observe();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!(STORAGE_KEY in changes)) return;
    currentConfig = normalizeConfig(changes[STORAGE_KEY].newValue);
    rewriteAll(document, currentConfig);
  });
}

void main();
