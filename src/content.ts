// Content script: makes mailto: links go somewhere useful.
//
// Entirely passive until the user acts. The page is never read, written
// or observed at load time: all this file does at document_start is
// register three capture-phase listeners. A page with no mailto: links —
// the normal case — is left byte-identical, and never causes a storage
// read.
//
// Interception points, because the browser routes link activation
// through two different events:
//   - `click`    — primary button, including Ctrl/Cmd/Shift variants.
//   - `auxclick` — middle button. Middle-click does NOT fire `click`.
// Both are cancelable, so preventDefault() stops the browser handing the
// mailto: off to the OS mail app, which is the outcome this extension
// exists to avoid.
//
// The modifier then decides where the destination opens, mirroring what
// the same modifier would have done on an ordinary link.
//
// This file is a global script (no imports); the helpers it uses come
// from `config.js` and `dialog.js`, listed ahead of it in the manifest.

// Where a destination should open. Mirrors the browser's own handling of
// the modifier used, so a Ctrl-click on a mailto: link behaves like a
// Ctrl-click on any other link.
//
// `newTab` is deliberately a *background* tab (what Ctrl-click and
// middle-click do) while `foregroundTab` is not (what target="_blank"
// does).
type OpenMode = 'current' | 'newTab' | 'foregroundTab' | 'newWindow';

// Populated on first use, then kept fresh by a storage listener. Null
// means "not loaded yet", which is distinct from a loaded-but-empty
// config: the former has to await, the latter can answer immediately.
let cachedConfig: Config | null = null;
let configPromise: Promise<Config> | null = null;

function watchConfigChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!(STORAGE_KEY in changes)) return;
    cachedConfig = normalizeConfig(changes[STORAGE_KEY].newValue);
  });
}

// Reads storage at most once per frame, and only once the user has shown
// interest in a mailto: link.
function configReady(): Promise<Config> {
  if (!configPromise) {
    configPromise = (async () => {
      // Registered *before* the read starts, not after it resolves: a
      // save landing while the read is in flight would otherwise be
      // missed, and then overwritten by the older value the read
      // returns.
      watchConfigChanges();
      const cfg = await loadConfig();
      // Don't clobber a change that arrived while the read was in
      // flight — the listener already stored the newer value.
      return (cachedConfig ??= cfg);
    })().catch(() => {
      // One catch for the whole chain, `watchConfigChanges()` included.
      // Storage is unreachable if the extension was reloaded or updated
      // while this page stayed open, and in that state *every*
      // chrome.storage call throws — including registering the listener.
      // Treat it as "no targets", which still gets the user a dialog
      // with the copy buttons and the original mailto: link, rather than
      // a click that silently does nothing.
      return (cachedConfig ??= { targets: [] });
    });
  }
  return configPromise;
}

// Find the activated anchor. composedPath() rather than event.target so a
// link inside a page's own shadow DOM is still found. The event.target
// branch is a fallback for events with an empty composed path; ordinary
// clicks never reach it.
function clickedAnchor(e: Event): HTMLAnchorElement | null {
  for (const node of e.composedPath()) {
    if (node instanceof HTMLAnchorElement) return node;
  }
  const target = e.target;
  return target instanceof Element
    ? target.closest<HTMLAnchorElement>('a')
    : null;
}

// The mailto: address this event activates, or null if the event isn't
// one we handle. Shared by the prefetch and the interception path so the
// two can't disagree about what counts as a mailto: click.
function activatedEmail(
  e: Event,
): { a: HTMLAnchorElement; email: string; href: string } | null {
  const a = clickedAnchor(e);
  // PASSTHROUGH_ATTR marks the dialog's own "open in your email app"
  // link. It is declared in dialog.js — loaded ahead of this file — so
  // the writer and this reader can't drift apart.
  if (!a || a.hasAttribute(PASSTHROUGH_ATTR)) return null;
  // `a.href`, not the raw attribute. Chrome strips leading and trailing
  // whitespace and *embedded* tabs/newlines before resolving an href, so
  // `  mailto:x@y.com` and even `mai<TAB>lto:x@y.com` are links it will
  // happily hand to the mail app while a raw-attribute test says they
  // aren't mailto at all. Since cancelling the click is now the only
  // defence, missing one lets it escape.
  //
  // Resolving also lower-cases the scheme and leaves the rest untouched,
  // so percent-encoding and the address's own case both survive for the
  // dialog's verbatim hand-off.
  const href = a.href;
  const email = emailFromMailto(href);
  return email ? { a, email, href } : null;
}

function openModeFor(e: MouseEvent, a: HTMLAnchorElement): OpenMode | null {
  // Middle button. Other auxiliary buttons (back/forward) aren't link
  // activations, so leave them to the browser.
  if (e.type === 'auxclick') return e.button === 1 ? 'newTab' : null;
  if (e.button !== 0) return null;
  // Alt-click means "download the target", not "navigate". Downloading a
  // mailto: is meaningless, but so is redirecting it somewhere the user
  // didn't ask to go, so pass it through untouched.
  if (e.altKey) return null;
  if (e.shiftKey) return 'newWindow';
  if (e.ctrlKey || e.metaKey) return 'newTab';
  // The page itself asked for a new tab on this link. Following the href
  // used to honour that for free; now it has to be read explicitly, or a
  // target="_blank" mailto: would navigate the page away instead.
  if (a.target === '_blank') return 'foregroundTab';
  return 'current';
}

// Which window a same-tab navigation applies to. `_top` and `_parent` are
// the same regression class as `_blank`: following the href honoured them
// for free, and without this a targeted mailto: link inside an iframe
// would navigate the iframe instead of the frame it named.
//
// Named targets (`target="somewhere"`) and `<base target>` are not
// supported — `a.target` doesn't reflect `<base>`, and resolving a frame
// by name is more machinery than a mailto: link has ever needed.
function navigationWindow(a: HTMLAnchorElement): Window {
  try {
    if (a.target === '_top' && window.top) return window.top;
    if (a.target === '_parent') return window.parent;
  } catch {
    // Cross-origin ancestor we can't even reference. Our own frame is
    // the only one left.
  }
  return window;
}

function navigate(url: string, mode: OpenMode, a: HTMLAnchorElement): void {
  if (mode === 'current') {
    try {
      navigationWindow(a).location.href = url;
    } catch {
      // Navigating a cross-origin ancestor can be refused. Better to
      // land in this frame than to swallow the click entirely.
      window.location.href = url;
    }
    return;
  }
  // Deliberately not window.open(): it focuses what it opens, whereas
  // Ctrl-click and middle-click open a *background* tab. The service
  // worker has the tab APIs needed to reproduce that, and to place the
  // new tab next to this one.
  const message: OpenLinkMessage = { type: 'openLink', url, where: mode };
  // Rejects if the extension was reloaded out from under this page.
  // Nothing useful to do about it, but an unhandled rejection would
  // surface as an error against the extension.
  void chrome.runtime.sendMessage(message).catch(() => {});
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

function act(
  cfg: Config,
  a: HTMLAnchorElement,
  email: string,
  mailtoHref: string,
  mode: OpenMode,
): void {
  const href = desiredHref(cfg, email);
  if (href !== null) {
    navigate(href, mode, a);
    return;
  }
  showMailtoDialog({
    doc: dialogDocument(),
    email,
    mailtoHref,
    targets: matchingTargets(cfg, email),
    // A click asked to open away from this page before we knew a dialog
    // was coming. Honour that on whichever target gets picked — as a new
    // tab in every case, since the dialog's links can only carry
    // `target`, not "background tab" or "new window".
    openInNewTab: mode !== 'current',
    onConfigure: () =>
      void chrome.runtime
        .sendMessage({ type: 'openOptions' })
        .catch(() => {}),
  });
}

function onActivate(e: MouseEvent): void {
  // Don't fight a page that already handled the event itself.
  if (e.defaultPrevented) return;
  const activated = activatedEmail(e);
  if (!activated) return;
  let mode = openModeFor(e, activated.a);
  if (mode === null) return;
  // Opening a tab or window goes through the service worker, which —
  // unlike window.open() — is not gated on user activation. A page could
  // otherwise dispatch synthetic Ctrl-clicks at any mailto: link of its
  // own and spawn tabs without limit. Untrusted clicks still navigate,
  // which is what following a rewritten href used to do.
  if (!e.isTrusted && mode !== 'current') mode = 'current';

  // Must happen synchronously, before any await: once this handler
  // returns, the browser is free to follow the mailto:.
  e.preventDefault();
  e.stopPropagation();

  const { a, email, href } = activated;
  if (cachedConfig) {
    act(cachedConfig, a, email, href, mode);
    return;
  }
  // First mailto: interaction in this frame, and pointerdown either
  // didn't fire (keyboard activation) or hasn't resolved yet.
  void configReady().then((cfg) => act(cfg, a, email, href, mode));
}

// Warm the config as soon as a pointer goes down on a mailto: link — any
// button, so a right-click that ends in "open in new tab" is covered too
// — so the activation that follows can decide synchronously and act
// without a visible pause.
//
// Passive: cancelling pointerdown suppresses the whole mousedown/click
// sequence, and we only want to observe it.
function onPointerDown(e: PointerEvent): void {
  if (configPromise) return;
  if (!activatedEmail(e)) return;
  void configReady();
}

document.addEventListener('pointerdown', onPointerDown, {
  capture: true,
  passive: true,
});
document.addEventListener('click', onActivate, true);
document.addEventListener('auxclick', onActivate, true);
