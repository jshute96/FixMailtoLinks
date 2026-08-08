// The chooser dialog shown when a clicked mailto: link has no target
// configured to be followed automatically.
//
// Like `config.ts`, this is a global script rather than an ES module so
// the same file can be loaded by the content script (which can't use
// static imports) and by the options page's "Test it" section.
//
// The dialog lives in a shadow root so that page CSS can't restyle or
// hide it, and page scripts querying the DOM don't trip over our nodes.

interface MailtoDialogOptions {
  // Document to render into. Not always `document`: a link clicked in a
  // small same-origin iframe renders the dialog in the top document, so
  // it isn't clipped to the frame.
  doc: Document;
  // Address as parsed from the link, e.g. `alice@example.com`. May name
  // no recipient (`mailto:?subject=…`) or several (`a@x.com,b@y.com`),
  // either of which drops the copy buttons and the target list.
  email: string;
  // The original, unmodified mailto: href, so "open in your email app"
  // keeps any ?subject/&body the page supplied.
  mailtoHref: string;
  // Matching targets in configured order. May be empty.
  targets: TargetConfig[];
  // Open the target links in a new tab. The options page's test link
  // sets this so trying a target doesn't navigate away from the unsaved
  // form; on a live page a click behaves like any other link. Never
  // applied to the mailto: bullet — handing off to the email app would
  // leave an empty tab behind.
  openInNewTab?: boolean;
  // Runs before the dialog closes when "Configure link targets" is
  // clicked. Omit on the options page, where closing already leaves the
  // user looking at the settings.
  onConfigure?: () => void;
}

const DIALOG_HOST_ID = 'fix-mailto-links-dialog';

const DIALOG_STYLE = `
  /* "all: initial" keeps page CSS from restyling us, but it also resets
     the host to an inline box with no size. Give it the viewport-filling
     box explicitly so the host itself is the overlay's containing block. */
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
  }
  .overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.4;
    color: #222;
  }
  .panel {
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    padding: 1rem 1.25rem 1.25rem;
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    overflow: auto;
    box-sizing: border-box;
  }
  h2 {
    font-size: 1.05rem;
    margin: 0 0 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  h2 img { width: 1.5em; height: 1.5em; }
  .address {
    font-family: ui-monospace, monospace;
    background: #f2f2f2;
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    word-break: break-all;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  button {
    font: inherit;
    padding: 0.4rem 0.75rem;
    border: 1px solid #bbb;
    border-radius: 4px;
    background: #fafafa;
    cursor: pointer;
  }
  button:hover { background: #f0f0f0; }
  h3 {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #666;
    margin: 1.1rem 0 0.4rem;
  }
  /* The panel heading already supplies the gap above the first one. */
  h3:first-of-type { margin-top: 0; }
  ul { margin: 0; padding-left: 1.25rem; }
  li { margin: 0 0 0.3rem; }
  a { color: #1a56c4; text-decoration: none; word-break: break-all; }
  a:hover { text-decoration: underline; }
  .empty { color: #666; margin: 0 0 0.4rem; }
  .footer {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 1.25rem;
    padding-top: 0.9rem;
    border-top: 1px solid #eee;
  }
  .spacer { flex: 1; }
  .status { color: #2a7a2a; font-size: 0.85rem; }
`;

// Shown under "Open with" when there is nothing to list, keyed by why.
// A single address that simply matched no rule is the one case the user
// can do something about; the other two are properties of the link.
const EMPTY_MESSAGE: Record<AddressCount, string> = {
  one: 'No link targets match this address.',
  none: "This link has no email address, so the links don't work.",
  multiple: "This link has multiple email addresses, so the links don't work.",
};

// Set by the dialog on its own "open in your email app" link, which is a
// real mailto: anchor and would otherwise re-trigger the dialog. Declared
// here because this is the file that writes it; content.js reads it.
const PASSTHROUGH_ATTR = 'data-fix-mailto-passthrough';

// The dialog currently on screen in this frame's world, so replacing it
// can run its teardown instead of orphaning the listeners it registered
// on the document.
let activeClose: (() => void) | null = null;

function closeMailtoDialog(doc: Document): void {
  activeClose?.();
  doc.getElementById(DIALOG_HOST_ID)?.remove();
}

// Clipboard access can be denied (permissions policy, or a frame the
// page never focused). Fall back to the old selection-based copy so the
// buttons still do something useful there.
async function copyText(doc: Document, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const scratch = doc.createElement('textarea');
      scratch.value = text;
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      doc.body.appendChild(scratch);
      scratch.select();
      const ok = doc.execCommand('copy');
      scratch.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Pages often percent-encode the whole mailto:, so a display-name
// address arrives as `mailto:%22Eve%20Smith%22%20%3Ceve@example.com%3E`.
// That is unreadable, and this is the one place the user is asked to
// look at the raw link. Decode for display only — the href keeps the
// original bytes, so handing off to the email app is unaffected.
function displayMailto(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

// `https://www.google.com/search?q=…` reads as `google.com`.
function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function extensionName(): string {
  try {
    return chrome.runtime.getManifest().name;
  } catch {
    return 'Fix Mailto Links';
  }
}

// The dialog renders into the page's document, so the page has to be
// allowed to load the icon — hence the manifest's
// web_accessible_resources entry. Returns null if that lookup fails, so
// a missing icon costs us the image and not the whole heading.
function extensionIconUrl(): string | null {
  try {
    return chrome.runtime.getURL('icons/icon-48.png');
  } catch {
    return null;
  }
}

function showMailtoDialog(opts: MailtoDialogOptions): void {
  const { doc, email, mailtoHref, targets } = opts;
  // Never stack dialogs: a second click while one is open replaces it.
  closeMailtoDialog(doc);

  const host = doc.createElement('div');
  host.id = DIALOG_HOST_ID;
  const root = host.attachShadow({ mode: 'open' });

  const style = doc.createElement('style');
  style.textContent = DIALOG_STYLE;
  root.appendChild(style);

  const overlay = doc.createElement('div');
  overlay.className = 'overlay';
  const panel = doc.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.tabIndex = -1;
  overlay.appendChild(panel);
  root.appendChild(overlay);

  // Escape is listened for on the window, in capture, for the same
  // reason the content script's click listeners are (see content.ts): a
  // page listener there that calls stopPropagation() would otherwise
  // leave the dialog with no way to close from the keyboard. Falls back
  // to the document for a document with no view, which shouldn't happen
  // but costs one `??` to survive.
  const keys: EventTarget = doc.defaultView ?? doc;
  const close = (): void => {
    if (activeClose === close) activeClose = null;
    keys.removeEventListener('keydown', onKeydown as EventListener, true);
    host.remove();
  };
  function onKeydown(e: KeyboardEvent): void {
    // Each frame gets its own copy of this script but they can all render
    // into the top document, so another frame's dialog can replace ours
    // without our close() ever running. Nothing else can reach that
    // instance, so stand down the first time we notice it's gone.
    if (!host.isConnected) {
      keys.removeEventListener('keydown', onKeydown as EventListener, true);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
  keys.addEventListener('keydown', onKeydown as EventListener, true);
  activeClose = close;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const heading = doc.createElement('h2');
  const iconUrl = extensionIconUrl();
  if (iconUrl) {
    const icon = doc.createElement('img');
    icon.src = iconUrl;
    // Decorative: the name sits right beside it, so announcing the icon
    // too would just repeat it.
    icon.alt = '';
    heading.appendChild(icon);
  }
  heading.appendChild(doc.createTextNode(extensionName()));
  panel.appendChild(heading);

  const linkHeading = doc.createElement('h3');
  linkHeading.textContent = 'Link';
  panel.appendChild(linkHeading);

  const address = doc.createElement('div');
  address.className = 'address';
  address.textContent = displayMailto(mailtoHref);
  panel.appendChild(address);

  // Both buttons take a single address — "Copy username" has no answer
  // for a list, and none at all for an empty link — so they are left out
  // rather than offered and producing nonsense.
  if (hasOneAddress(email)) {
    const status = doc.createElement('span');
    status.className = 'status';

    const buttons = doc.createElement('div');
    buttons.className = 'buttons';
    for (const [label, value] of [
      ['Copy username', emailUsernameOf(email)],
      ['Copy email address', bareAddress(email)],
    ] as const) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        void copyText(doc, value).then((ok) => {
          status.textContent = ok ? 'Copied' : 'Copying failed';
        });
      });
      buttons.appendChild(btn);
    }
    buttons.appendChild(status);
    panel.appendChild(buttons);
  }

  const targetsHeading = doc.createElement('h3');
  targetsHeading.textContent = 'Open with';
  panel.appendChild(targetsHeading);

  if (targets.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'empty';
    // Why the list is empty decides what to say. Only a single address
    // that matched no rule is something the user can act on; a link with
    // no address, or several, could not have matched whatever they
    // configure, so don't word it as though their settings were at
    // fault.
    empty.textContent = EMPTY_MESSAGE[addressCount(email)];
    panel.appendChild(empty);
  }

  const list = doc.createElement('ul');
  for (const target of targets) {
    const url = expandTemplate(target.urlTemplate, email);
    const link = doc.createElement('a');
    link.href = url;
    // Just the site — the full URL is long, mostly boilerplate, and
    // says nothing about which destination this is. It stays in the
    // tooltip for anyone who wants to check.
    link.textContent = displayHost(url);
    link.title = url;
    if (opts.openInNewTab) {
      link.target = '_blank';
      link.rel = 'noopener';
    }
    link.addEventListener('click', () => close());
    const item = doc.createElement('li');
    item.appendChild(link);
    list.appendChild(item);
  }

  // Last bullet: the untouched original, so the user can still hand off
  // to their email app, keeping any ?subject/&body the page supplied.
  const mailLink = doc.createElement('a');
  mailLink.href = mailtoHref;
  mailLink.textContent = displayMailto(mailtoHref);
  // The content script's click handler runs on this anchor too; the
  // dialog is inside a shadow root but the event still bubbles into the
  // document. Mark it so the handler leaves it alone.
  mailLink.setAttribute(PASSTHROUGH_ATTR, '');
  mailLink.addEventListener('click', () => close());
  const mailItem = doc.createElement('li');
  mailItem.appendChild(mailLink);
  list.appendChild(mailItem);
  panel.appendChild(list);

  const footer = doc.createElement('div');
  footer.className = 'footer';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => close());
  footer.appendChild(cancel);
  footer.appendChild(Object.assign(doc.createElement('span'), {
    className: 'spacer',
  }));
  const configure = doc.createElement('button');
  configure.type = 'button';
  configure.textContent = 'Configure link targets';
  configure.addEventListener('click', () => {
    opts.onConfigure?.();
    close();
  });
  footer.appendChild(configure);
  panel.appendChild(footer);

  doc.body.appendChild(host);
  panel.focus();
}
