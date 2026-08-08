// Background service worker. Two jobs:
//   - Open the options page, both from the toolbar icon and from the
//     chooser dialog's "Configure link targets" button.
//   - Open a destination in a new tab or window on behalf of the content
//     script, which can't reproduce background-tab behaviour itself.

// The content script builds this payload and is type-checked against it:
// none of these files are TS modules, so they share one global
// declaration space and a mismatch is a compile error rather than a
// runtime surprise. The type is erased, so nothing is loaded across.
interface OpenLinkMessage {
  type: 'openLink';
  url: string;
  // `newTab` is a background tab (Ctrl-click, middle-click);
  // `foregroundTab` is not (target="_blank").
  where: 'newTab' | 'foregroundTab' | 'newWindow';
}

async function openOptionsTab(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
}

// The content script only ever sends URLs built from a stored template,
// which the options page already restricts to http(s). Re-check here
// anyway: this is the boundary where a URL turns into a real navigation,
// and the check is cheaper than reasoning about every path that reaches
// it. (`config.js` can't be imported — it's a classic script, not a
// module — so the test is inlined rather than shared.)
function isOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function openLink(
  msg: OpenLinkMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  // Drop the click rather than open something unexpected. Silent by
  // design: every path that produces a URL has already validated it, so
  // reaching here means a stored value that no UI would accept, and
  // there is nothing the user could act on.
  if (!isOpenableUrl(msg.url)) return;
  if (msg.where === 'newWindow') {
    await chrome.windows.create({ url: msg.url });
    return;
  }
  // Being able to say `active: false` is the point of routing this
  // through the service worker: Ctrl-click and middle-click open a
  // background tab, and window.open() in the page would have stolen
  // focus. Placing it right after the opener matches Chrome's own tab
  // ordering too.
  const tab = sender.tab;
  await chrome.tabs.create({
    url: msg.url,
    active: msg.where === 'foregroundTab',
    windowId: tab?.windowId,
    index: tab?.index === undefined ? undefined : tab.index + 1,
    openerTabId: tab?.id,
  });
}

// Nothing here can recover from a failed tab/window creation, but an
// unhandled rejection in the worker is reported against the extension,
// so swallow it rather than let the errors panel fill up.
function ignoreFailure(work: Promise<void>): void {
  void work.catch(() => {});
}

chrome.action.onClicked.addListener(() => ignoreFailure(openOptionsTab()));

chrome.runtime.onMessage.addListener(
  (message: { type?: string }, sender) => {
    if (message?.type === 'openOptions') ignoreFailure(openOptionsTab());
    else if (message?.type === 'openLink') {
      ignoreFailure(openLink(message as OpenLinkMessage, sender));
    }
    // No response is sent, so return nothing (i.e. don't keep the message
    // channel open waiting for one).
  },
);
