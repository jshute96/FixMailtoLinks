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

// Mirrors encodeForUrl() in src/config.ts: encodeURIComponent, but with
// `@` left readable, which RFC 3986 permits in a query.
function googleSearch(email: string): string {
  const encoded = encodeURIComponent(email).replace(/%40/g, '@');
  return `https://www.google.com/search?q=${encoded}`;
}

// DEFAULT_CONFIG's single target matches every address but is *not*
// automatic, so a fresh install leaves hrefs alone and offers the search
// from the dialog. Asserting both halves is what distinguishes it from
// an empty target list, which also leaves hrefs alone.
async function expectDefaultTarget(page: Page): Promise<void> {
  expect(DEFAULT_TEMPLATE).toBe('https://www.google.com/search?q={email}');
  await expectHref(page, 'alice@example.com', 'mailto:alice@example.com');
  await page.getByRole('link', { name: 'alice@example.com' }).click();
  const links = page.locator('#fix-mailto-links-dialog').locator('li a');
  await expect(links.first()).toHaveAttribute('href', googleSearch('alice@example.com'));
  await page.keyboard.press('Escape');
}

test.describe('mailto rewriting with an automatic catch-all target', () => {
  // The shipped default does *not* follow automatically, so these set an
  // automatic target explicitly rather than leaning on DEFAULT_CONFIG.
  test.beforeEach(async ({ config }) => {
    await config.setTemplate(DEFAULT_TEMPLATE);
  });

  test('rewrites a plain mailto: link to a Google search', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
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
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // `+` must survive as %2B, not decay into a space.
    await expectHref(
      page,
      'team+news@example.com',
      'https://www.google.com/search?q=team%2Bnews@example.com',
    );
    // The href is percent-encoded in the source page. The content script
    // decodes it, then substitutes only the address from inside the
    // angle brackets — a display name is noise in a lookup URL.
    await expectHref(
      page,
      '"Eve Smith" <eve@example.com>',
      googleSearch('eve@example.com'),
    );

    await page.close();
  });

  test('rewrites links nested inside other elements', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
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
      'https://example.test/lookup?addr=dave@example.com',
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
      `${fixtureServer.baseUrl}/landing.html?to=alice@example.com`,
    );
    await page.getByRole('link', { name: 'alice@example.com' }).click();

    await page.waitForURL(/landing\.html/);
    await expect(page.locator('#target')).toHaveText('landing page');
    expect(new URL(page.url()).searchParams.get('to')).toBe('alice@example.com');

    await page.close();
  });
});

test.describe('frames without a URL of their own', () => {
  test.beforeEach(async ({ config }) => {
    await config.setTemplate(DEFAULT_TEMPLATE);
  });

  // `match_about_blank` in the manifest is what makes these work; drop it
  // and both assertions below fail while the top-frame one still passes.
  const FRAME_PAGE = 'iframe_page.html';

  test('rewrites links inside srcdoc and about:blank frames', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
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
  // older build or another device has to be survivable. A target whose
  // template can't work is dropped, which leaves the link as `mailto:`
  // (the dialog then offers whatever else is configured).

  for (const [label, template] of [
    // Without normalization the href would become "", i.e. a link back to
    // the current page.
    ['an empty template', '   '],
    // A mailto: template makes the rewriter's own output look like a fresh
    // mailto: link to its MutationObserver, which rewrites it again — an
    // unbounded loop that hangs the page.
    ['a mailto: template', 'mailto:{email}'],
    ['a javascript: template', 'javascript:alert(1)'],
  ] as const) {
    test(`drops a target with ${label}`, async ({
      extensionContext,
      fixtureServer,
      config,
    }) => {
      await config.setTargets([
        { emailDomain: '', urlTemplate: template, openDirectly: true },
        // A valid sibling proves the config was read at all, so the
        // assertion below isn't passing on an extension that never ran.
        {
          emailDomain: 'example.org',
          urlTemplate: 'https://example.test/org?q={email}',
          openDirectly: true,
        },
      ]);
      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

      await expectHref(
        page,
        'Email Bob',
        'https://example.test/org?q=bob@example.org',
      );
      await expectHref(page, 'alice@example.com', 'mailto:alice@example.com');
      // The page is still responsive, not spinning in the observer.
      expect(await page.evaluate(() => 1 + 1)).toBe(2);

      await page.close();
    });
  }

  test('falls back to the default when the whole config is unusable', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    // Not an empty target list (a deliberate "always ask"), but a shape
    // we can make no sense of at all.
    await config.setRaw({ nonsense: true });
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectDefaultTarget(page);

    await page.close();
  });
});

test.describe('multiple targets', () => {
  test('uses the first automatic target whose domain matches', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([
      {
        emailDomain: 'example.org',
        urlTemplate: 'https://example.test/org?u={username}',
        openDirectly: true,
      },
      {
        emailDomain: '',
        urlTemplate: 'https://example.test/any?q={email}',
        openDirectly: true,
      },
    ]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(page, 'Email Bob', 'https://example.test/org?u=bob');
    // No example.com entry, so the catch-all takes it.
    await expectHref(
      page,
      'alice@example.com',
      'https://example.test/any?q=alice@example.com',
    );

    await page.close();
  });

  test('skips an earlier match that is not automatic', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    // A target that only wants to appear in the dialog must not suppress
    // a later one the user asked us to follow straight away.
    await config.setTargets([
      {
        emailDomain: '',
        urlTemplate: 'https://example.test/ask?q={email}',
        openDirectly: false,
      },
      {
        emailDomain: 'example.com',
        urlTemplate: 'https://example.test/com?u={username}',
        openDirectly: true,
      },
    ]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(page, 'alice@example.com', 'https://example.test/com?u=alice');
    // bob@example.org matches only the non-automatic catch-all, so his
    // link is left alone for the dialog to handle.
    await expectHref(page, 'Email Bob', 'mailto:bob@example.org');

    await page.close();
  });

  test('matches subdomains of a configured domain', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([
      {
        emailDomain: 'example.com',
        urlTemplate: 'https://example.test/com?u={username}',
        openDirectly: true,
      },
    ]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expectHref(page, 'alice@example.com', 'https://example.test/com?u=alice');

    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>(
        'a[href="https://example.com/contact"]',
      );
      a!.setAttribute('href', 'mailto:sam@mail.example.com');
    });

    await expectHref(page, 'regular https link', 'https://example.test/com?u=sam');

    await page.close();
  });

  test('leaves links alone when nothing is configured', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    // An empty target list is a legitimate choice: always ask.
    await config.setTargets([]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await expectHref(page, 'alice@example.com', 'mailto:alice@example.com');

    await page.close();
  });

  test('restores the mailto: href when the target stops matching', async ({
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
      'https://example.test/lookup?addr=alice@example.com',
    );

    await config.setTargets([
      {
        emailDomain: 'other.test',
        urlTemplate: 'https://example.test/other?q={email}',
        openDirectly: true,
      },
    ]);

    await expectHref(page, 'alice@example.com', 'mailto:alice@example.com');
    // And the page hasn't been left spinning in the observer.
    expect(await page.evaluate(() => 1 + 1)).toBe(2);

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
      'https://example.test/lookup?addr=alice@example.com',
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
      'https://example.test/alice@example.com/profile?q=alice@example.com',
    );

    await page.close();
  });

  test('updates already-open pages when the template changes', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTemplate(DEFAULT_TEMPLATE);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expectHref(page, 'alice@example.com', googleSearch('alice@example.com'));

    // No reload: the content script listens on chrome.storage.onChanged
    // and re-derives every href from the stashed original.
    await config.setTemplate('https://example.test/lookup?addr={email}');

    await expectHref(
      page,
      'alice@example.com',
      'https://example.test/lookup?addr=alice@example.com',
    );
    // A link added before the change is re-derived too, not just the
    // ones present at load.
    await expectHref(
      page,
      'Dave (with subject/body)',
      'https://example.test/lookup?addr=dave@example.com',
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
      'https://example.test/lookup?addr=alice@example.com',
    );

    await config.reset();

    // The default target is not automatic, so the href goes back to
    // mailto: and the search is offered in the dialog instead.
    await expectDefaultTarget(page);

    await page.close();
  });
});
