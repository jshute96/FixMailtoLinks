// End-to-end coverage for the content script's core job: turning
// `mailto:` links into links that follow the configured URL template.
//
// Everything here runs against tests/fixtures/pages/link_page.html,
// served over http:// (see the fixtureServer fixture) because unpacked
// extensions don't get file:// access by default.

import { test, expect, DEFAULT_TEMPLATE } from '../fixtures/extension';
import type { Page } from '@playwright/test';

const PAGE = 'link_page.html';

// The content script loads its config asynchronously (an awaited
// chrome.storage.sync.get) and only then rewrites the DOM, so a link is
// briefly still `mailto:` after load. Every assertion goes through a
// polling matcher rather than a bare getAttribute for that reason.
async function expectHref(page: Page, text: string, href: string): Promise<void> {
  await expect(page.getByRole('link', { name: text })).toHaveAttribute('href', href);
}

function googleSearch(email: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(email)}`;
}

test.describe('mailto rewriting with the default template', () => {
  test('rewrites a plain mailto: link to a Google search', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config; // fixture resets storage; the default template applies
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));
    await expectHref(page, 'Email Bob', googleSearch('bob@example.org'));

    await page.close();
  });

  test('handles a mixed-case MAILTO: scheme', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // Scheme matching is case-insensitive, but the address itself keeps
    // whatever case the page used.
    await expectHref(
      page,
      'Carol (mixed-case scheme)',
      googleSearch('Carol@Example.COM'),
    );

    await page.close();
  });

  test('strips ?subject/&body params and keeps only the address', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(
      page,
      'Dave (with subject/body)',
      googleSearch('dave@example.com'),
    );

    await page.close();
  });

  test('encodes addresses that contain URL-significant characters', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // `+` must survive as %2B, not decay into a space.
    await expectHref(
      page,
      'team+news@example.com',
      'https://www.google.com/search?q=team%2Bnews%40example.com',
    );
    // The href is percent-encoded in the source page; the content script
    // decodes it before substituting, so the display name comes through.
    await expectHref(
      page,
      'Eve (URL-encoded display name)',
      googleSearch('"Eve Smith" <eve@example.com>'),
    );

    await page.close();
  });

  test('rewrites links nested inside other elements', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(page, 'Frank', googleSearch('frank@example.net'));
    await expectHref(page, 'Grace', googleSearch('grace@example.net'));

    await page.close();
  });

  test('leaves non-mailto links untouched', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // Wait for the rewrite pass to have happened before asserting a
    // negative, otherwise this would pass even if the script rewrote
    // everything a moment later.
    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));

    const control = page.getByRole('link', { name: 'regular https link' });
    await expect(control).toHaveAttribute('href', 'https://example.com/contact');
    await expect(control).not.toHaveAttribute('data-fix-mailto-original', /./);

    await page.close();
  });

  test('rewrites links added to the DOM after load', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // This exercises the MutationObserver path — the button appends a
    // fresh <a href="mailto:..."> that was never in the initial HTML.
    await page.getByRole('button', { name: 'Add another mailto link' }).click();

    await expectHref(page, 'user1@example.com', googleSearch('user1@example.com'));

    await page.close();
  });

  test('rewrites an href that is switched to mailto: after load', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // The observer also watches href attribute changes, so a link that
    // starts out benign and is later pointed at mailto: gets caught.
    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));
    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>(
        'a[href="https://example.com/contact"]',
      );
      a!.setAttribute('href', 'mailto:late@example.com');
    });

    await expectHref(page, 'regular https link', googleSearch('late@example.com'));

    await page.close();
  });

  test('gives up a link the page repoints at a non-mailto URL', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));

    // The page takes the link back for its own purposes. We leave it
    // alone at the time — but the stashed original must be dropped too,
    // or the next template change re-derives the old address and
    // clobbers what the page deliberately set.
    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>(
        'a[data-fix-mailto-original="mailto:alice@example.com"]',
      );
      a!.setAttribute('href', 'https://example.com/alice-profile');
    });
    await expectHref(page, 'alice@example.com', 'https://example.com/alice-profile');

    await config.setTemplate('https://example.test/lookup?addr={email}');

    // A sibling link proves the template change really propagated, so the
    // assertion below isn't just passing on a change that never arrived.
    await expectHref(
      page,
      'Dave (with subject/body)',
      'https://example.test/lookup?addr=dave%40example.com',
    );
    await expectHref(page, 'alice@example.com', 'https://example.com/alice-profile');

    await page.close();
  });

  test('clicking a rewritten link actually navigates to the target', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    // The point of the extension is that the click goes somewhere on the
    // web instead of handing off to an email client, so assert on the
    // navigation rather than just the attribute.
    await config.setTemplate(`${fixtureServer.baseUrl}/landing.html?to={email}`);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(
      page,
      'alice@example.com',
      `${fixtureServer.baseUrl}/landing.html?to=alice%40example.com`,
    );
    await page.getByRole('link', { name: 'alice@example.com' }).click();

    await page.waitForURL(/landing\.html/);
    await expect(page.locator('#target')).toHaveText('landing page');
    expect(new URL(page.url()).searchParams.get('to')).toBe('alice@example.com');

    await page.close();
  });
});

test.describe('frames without a URL of their own', () => {
  // `match_about_blank` in the manifest is what makes these work; drop it
  // and both assertions below fail while the top-frame one still passes.
  const FRAME_PAGE = 'iframe_page.html';

  test('rewrites links inside srcdoc and about:blank frames', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${FRAME_PAGE}`);

    // Positive control in the top frame first, so a failure below means
    // "the frames were missed", not "the extension hadn't run yet".
    await expectHref(page, 'top@example.com', googleSearch('top@example.com'));

    await expect(
      page
        .frameLocator('#srcdoc-frame')
        .getByRole('link', { name: 'srcdoc@example.com' }),
    ).toHaveAttribute('href', googleSearch('srcdoc@example.com'));

    await expect(
      page
        .frameLocator('#blank-frame')
        .getByRole('link', { name: 'blank@example.com' }),
    ).toHaveAttribute('href', googleSearch('blank@example.com'));

    await page.close();
  });
});

test.describe('templates that would break the rewriter', () => {
  // These can only reach the content script through storage — the options
  // page rejects them — but storage is synced, so a value written by an
  // older build or another device has to be survivable.

  test('ignores an empty template instead of emptying every href', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTemplate('   ');
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // Without normalization the href would become "", i.e. a link back to
    // the current page.
    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));

    await page.close();
  });

  test('ignores a mailto: template rather than looping forever', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    // A mailto: template makes the rewriter's own output look like a fresh
    // mailto: link to its MutationObserver, which rewrites it again — an
    // unbounded loop that hangs the page.
    await config.setTemplate('mailto:{email}');
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));
    // The page is still responsive, not spinning in the observer.
    expect(await page.evaluate(() => 1 + 1)).toBe(2);

    await page.close();
  });

  test('ignores a javascript: template', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTemplate('javascript:alert(1)');
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));

    await page.close();
  });
});

test.describe('custom templates', () => {
  test('applies a configured template to every link', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(
      page,
      'alice@example.com',
      'https://example.test/lookup?addr=alice%40example.com',
    );

    await page.close();
  });

  test('substitutes every occurrence of {email}', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTemplate('https://example.test/{email}/profile?q={email}');
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(
      page,
      'alice@example.com',
      'https://example.test/alice%40example.com/profile?q=alice%40example.com',
    );

    await page.close();
  });

  test('updates already-open pages when the template changes', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));

    // No reload: the content script listens on chrome.storage.onChanged
    // and re-derives every href from the stashed original.
    await config.setTemplate('https://example.test/lookup?addr={email}');

    await expectHref(
      page,
      'alice@example.com',
      'https://example.test/lookup?addr=alice%40example.com',
    );
    // A link added before the change is re-derived too, not just the
    // ones present at load.
    await expectHref(
      page,
      'Dave (with subject/body)',
      'https://example.test/lookup?addr=dave%40example.com',
    );

    await page.close();
  });

  test('falls back to the default template when config is cleared', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expectHref(
      page,
      'alice@example.com',
      'https://example.test/lookup?addr=alice%40example.com',
    );

    await config.reset();

    expect(DEFAULT_TEMPLATE).toBe('https://www.google.com/search?q={email}');
    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));

    await page.close();
  });
});
