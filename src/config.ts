// Shared config types, defaults, and helpers used by the options
// page and the background service worker.

export interface Config {
  // URL template used to rewrite mailto: links. The literal token
  // `{email}` is replaced with the email address at navigation time.
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

// Convert a user-facing URL template like
//   "https://www.google.com/search?q={email}"
// into a declarativeNetRequest `regexSubstitution` string, where the
// captured email from the regex filter `^mailto:([^?]*).*` is
// spliced in via `\1`.
//
// In a regexSubstitution string, `\` is the escape character (e.g.
// `\1` for capture group 1), so any literal backslash in the user's
// template must be doubled. Everything else is kept verbatim — the
// email is spliced in exactly as it appears in the mailto: URL, which
// is typically already a valid URL component (e.g. `foo@bar.com` or
// `foo%40bar.com`).
export function templateToRegexSubstitution(template: string): string {
  const parts = template.split('{email}');
  return parts.map((p) => p.replace(/\\/g, '\\\\')).join('\\1');
}
