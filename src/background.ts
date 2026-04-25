// Background service worker: opens the options page in its own
// window when the toolbar icon is clicked.

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('options.html');
  await chrome.windows.create({
    url,
    type: 'popup',
    width: 640,
    height: 480,
  });
});
