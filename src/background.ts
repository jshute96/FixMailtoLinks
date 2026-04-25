// Background service worker.
//
// Two jobs:
//   1. Keep a single declarativeNetRequest dynamic rule in sync with
//      the user's URL template. The rule matches any mailto: URL and
//      redirects the navigation to the configured target, so Chrome
//      intercepts the click itself — no content script required.
//   2. Open the options page when the toolbar icon is clicked.

import {
  STORAGE_KEY,
  loadConfig,
  templateToRegexSubstitution,
} from './config.js';

// We keep exactly one dynamic DNR rule. Re-using the same id lets us
// replace it on every config change with a single update call.
const RULE_ID = 1;

// Chrome's DNR regex engine is RE2. `^mailto:([^?]*)` captures the
// email portion (everything after `mailto:` up to an optional `?`
// query string like `?subject=...`). The captured group is spliced
// into the redirect via `\1` in the substitution string.
const MAILTO_REGEX = '^mailto:([^?]*).*';

async function applyTemplate(template: string): Promise<void> {
  const substitution = templateToRegexSubstitution(template);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: { regexSubstitution: substitution },
        },
        condition: {
          regexFilter: MAILTO_REGEX,
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
            chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
          ],
        },
      },
    ],
  });
}

async function syncRule(): Promise<void> {
  const cfg = await loadConfig();
  await applyTemplate(cfg.urlTemplate);
}

// On install/update, (re)install the rule from stored config. Dynamic
// rules persist across browser restarts, so we don't need to do this
// on every service-worker wakeup — only when the extension is first
// installed or its version changes.
chrome.runtime.onInstalled.addListener(() => {
  void syncRule();
});

// If the user edits the template in the options page, rebuild the
// rule immediately so the next click picks up the new target.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!(STORAGE_KEY in changes)) return;
  void syncRule();
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('options.html');
  await chrome.windows.create({
    url,
    type: 'popup',
    width: 640,
    height: 480,
  });
});
