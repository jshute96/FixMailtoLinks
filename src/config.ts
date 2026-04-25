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

export async function loadConfig(): Promise<Config> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const cfg = stored[STORAGE_KEY] as Partial<Config> | undefined;
  return { ...DEFAULT_CONFIG, ...(cfg ?? {}) };
}

export async function saveConfig(cfg: Config): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: cfg });
}
