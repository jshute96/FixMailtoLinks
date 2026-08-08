// Shared config types, defaults, and helpers used by the options
// page. Note: the content script does NOT import this file — MV3
// content scripts don't support static ES module imports, so the
// handful of helpers it needs are duplicated inline there.

export interface Config {
  // URL template used to rewrite mailto: links. The literal token
  // `{email}` is replaced with the URL-encoded email address.
  urlTemplate: string;
}

export const DEFAULT_CONFIG: Config = {
  urlTemplate: 'https://www.google.com/search?q={email}',
};

export const STORAGE_KEY = 'config';

// A template must be an absolute http(s) URL. This is not cosmetic —
// other schemes actively break the extension:
//   - `` (empty) rewrites every link to href="", i.e. a self-link.
//   - `mailto:...` makes the content script's own rewrite look like a
//     fresh mailto: link to its MutationObserver, which rewrites it
//     again, forever.
//   - `javascript:...` would inject script-executing hrefs into every
//     page the user visits.
export function isValidTemplate(template: string): boolean {
  return /^https?:\/\//i.test(template.trim());
}

// Coerce whatever is in storage (or typed by the user) into a usable
// template, falling back to the default. Storage is synced, so a bad
// value can arrive from another device or an older build; every reader
// normalizes rather than trusting it.
export function normalizeTemplate(template: string | undefined): string {
  const trimmed = (template ?? '').trim();
  return isValidTemplate(trimmed) ? trimmed : DEFAULT_CONFIG.urlTemplate;
}

export async function loadConfig(): Promise<Config> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const cfg = stored[STORAGE_KEY] as Partial<Config> | undefined;
  return { urlTemplate: normalizeTemplate(cfg?.urlTemplate) };
}

export async function saveConfig(cfg: Config): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: cfg });
}
