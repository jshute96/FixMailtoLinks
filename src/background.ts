// Background service worker: opens the options page in a tab, both when
// the toolbar icon is clicked and when the chooser dialog's "Configure
// link targets" button asks for it.

async function openOptionsTab(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
}

chrome.action.onClicked.addListener(() => void openOptionsTab());

chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type === 'openOptions') void openOptionsTab();
  // No response is sent, so return nothing (i.e. don't keep the message
  // channel open waiting for one).
});
