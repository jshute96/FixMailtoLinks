// End-to-end coverage for the content script's core job: sending a click
// on a `mailto:` link to the configured URL template instead of to the
// OS email app.
//
// The extension never rewrites the page, so there is no href to inspect:
// where a link goes is only observable by clicking it. Every assertion
// here therefore performs a real click and checks the resulting
// navigation. Destination hosts are stubbed at the context level (see the
// extensionContext fixture) so nothing reaches the network.
//
// Everything runs against tests/fixtures/pages/link_page.html, served
// over http:// (see the fixtureServer fixture) because unpacked
// extensions don't get file:// access by default.

import { test, expect, DEFAULT_TEMPLATE } from '../fixtures/extension';
import type { Page, BrowserContext } from '@playwright/test';

const PAGE = 'link_page.html';
const DIALOG = '#fix-mailto-links-dialog';

// Mirrors encodeForUrl() in src/config.ts: encodeURIComponent, but with
// `@` left readable, which RFC 3986 permits in a query.
function googleSearch(email: string): string {
  const encoded = encodeURIComponent(email).replace(/%40/g, '@');
  return `https://www.google.com/search?q=${encoded}`;
}

function linkPage(base: string): string {
  return `${base}/${PAGE}`;
}

// Click a mailto: link and assert where it took us.
//
// Reloads the fixture page first, so a single test can follow several
// links without the caller having to navigate back each time.
async function expectFollows(
  page: Page,
  base: string,
  name: string,
  expected: string,
): Promise<void> {
  await page.goto(linkPage(base));
  await page.getByRole('link', { name }).click();
  // Poll rather than toHaveURL: the expected values contain `?` and `*`,
  // which some matcher overloads read as glob metacharacters. This is a
  // plain string comparison.
  await expect.poll(() => page.url()).toBe(expected);
}

// A link with no automatic target must open the chooser dialog and leave
// the page where it is. Returns the dialog locator; Playwright pierces
// the open shadow root, so `.locator('li a')` reaches the target list.
async function expectDialog(
  page: Page,
  base: string,
  name: string,
): Promise<ReturnType<Page['locator']>> {
  await page.goto(linkPage(base));
  const before = page.url();
  await page.getByRole('link', { name }).click();
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('.panel')).toBeVisible();
  // The whole point of the dialog path is that nothing was followed.
  expect(page.url()).toBe(before);
  return dialog;
}

async function dismissDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
}

// DEFAULT_CONFIG's single target matches every address but is *not*
// automatic, so a fresh install asks rather than following. Asserting the
// offered target is what distinguishes it from an empty target list,
// which also asks but has nothing to offer.
async function expectDefaultTarget(page: Page, base: string): Promise<void> {
  expect(DEFAULT_TEMPLATE).toBe('https://www.google.com/search?q={email}');
  const dialog = await expectDialog(page, base, 'alice@example.com');
  await expect(dialog.locator('li a').first()).toHaveAttribute(
    'href',
    googleSearch('alice@example.com'),
  );
  await dismissDialog(page);
}

// Wait for the tab a background-opening click produced, and for it to
// reach `expected`. Ctrl-click and middle-click deliberately don't focus
// what they open, so the new page has to be picked up from the context
// rather than from a popup event on the opener.
//
// Polling for the URL rather than just for the page matters: a tab from
// chrome.tabs.create reports `about:blank` until the real navigation
// commits, so asserting straight after it appears races the commit.
async function waitForNewPage(
  ctx: BrowserContext,
  before: Page[],
  expected: string,
): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => {
      found = ctx.pages().find((p) => !before.includes(p));
      return found ? found.url() : '';
    })
    .toBe(expected);
  return found!;
}

test.describe('following a mailto link with an automatic catch-all target', () => {
  // The shipped default does *not* follow automatically, so these set an
  // automatic target explicitly rather than leaning on DEFAULT_CONFIG.
  test.beforeEach(async ({ config }) => {
    await config.setTemplate(DEFAULT_TEMPLATE);
  });

  test('sends a plain mailto: link to a Google search', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    const base = fixtureServer.baseUrl;

    await expectFollows(page, base, 'alice@example.com', googleSearch('alice@example.com'));
    await expectFollows(page, base, 'Email Bob', googleSearch('bob@example.org'));

    await page.close();
  });

  test('handles a mixed-case MAILTO: scheme', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();

    // Scheme matching is case-insensitive, but the address itself keeps
    // whatever case the page used.
    await expectFollows(
      page,
      fixtureServer.baseUrl,
      'Carol (mixed-case scheme)',
      googleSearch('Carol@Example.COM'),
    );

    await page.close();
  });

  test('strips ?subject/&body params and keeps only the address', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();

    await expectFollows(
      page,
      fixtureServer.baseUrl,
      'Dave (with subject/body)',
      googleSearch('dave@example.com'),
    );

    await page.close();
  });

  test('encodes addresses that contain URL-significant characters', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    const base = fixtureServer.baseUrl;

    // `+` must survive as %2B, not decay into a space.
    await expectFollows(
      page,
      base,
      'team+news@example.com',
      'https://www.google.com/search?q=team%2Bnews@example.com',
    );
    // The href is percent-encoded in the source page. The content script
    // decodes it, then substitutes only the address from inside the
    // angle brackets — a display name is noise in a lookup URL.
    await expectFollows(
      page,
      base,
      '"Eve Smith" <eve@example.com>',
      googleSearch('eve@example.com'),
    );

    await page.close();
  });

  test('catches hrefs the browser only resolves to mailto:', async ({
    extensionContext,
    fixtureServer,
  }) => {
    // Chrome strips leading/trailing whitespace and embedded tabs before
    // resolving an href, so these reach the OS mail app despite a raw
    // attribute that doesn't start with "mailto:". Cancelling the click
    // is the only defence now, so missing one lets it escape.
    const page = await extensionContext.newPage();
    const base = fixtureServer.baseUrl;

    await expectFollows(
      page,
      base,
      'Ivan (leading whitespace)',
      googleSearch('ivan@example.com'),
    );
    await expectFollows(
      page,
      base,
      'Judy (tab in scheme)',
      googleSearch('judy@example.com'),
    );

    await page.close();
  });

  test('follows a link activated from the keyboard', async ({
    extensionContext,
    fixtureServer,
  }) => {
    // The only path where pointerdown never fires, so it is the sole
    // exercise of the awaited config branch and of the "cancel first,
    // then await" guarantee the whole design rests on.
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));

    await page.getByRole('link', { name: 'alice@example.com' }).focus();
    await page.keyboard.press('Enter');

    await expect.poll(() => page.url()).toBe(googleSearch('alice@example.com'));

    await page.close();
  });

  test('follows links nested inside other elements', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    const base = fixtureServer.baseUrl;

    // composedPath() has to walk out to the enclosing <a> from the
    // <strong>/<em> that actually received the click.
    await expectFollows(page, base, 'Frank', googleSearch('frank@example.net'));
    await expectFollows(page, base, 'Grace', googleSearch('grace@example.net'));

    await page.close();
  });

  test('leaves non-mailto links untouched', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    const base = fixtureServer.baseUrl;

    // Positive control first, so a pass below can't just mean the
    // extension never ran.
    await expectFollows(page, base, 'alice@example.com', googleSearch('alice@example.com'));

    await page.goto(linkPage(base));
    await page.getByRole('link', { name: 'regular https link' }).click();
    await expect.poll(() => page.url()).toBe('https://example.com/contact');

    await page.close();
  });

  test('follows links added to the DOM after load', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    const base = fixtureServer.baseUrl;
    await page.goto(linkPage(base));

    // Nothing watches the DOM any more: the listener is delegated on the
    // document, so a link that never existed at load time is handled
    // with no extra machinery.
    await page.getByRole('button', { name: 'Add another mailto link' }).click();
    await page.getByRole('link', { name: 'user1@example.com' }).click();

    await expect.poll(() => page.url()).toBe(googleSearch('user1@example.com'));

    await page.close();
  });

  test('follows an href that is switched to mailto: after load', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));

    // The href is read at click time, so a link that starts out benign
    // and is later pointed at mailto: is caught without any observer.
    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>(
        'a[href="https://example.com/contact"]',
      );
      a!.setAttribute('href', 'mailto:late@example.com');
    });
    await page.getByRole('link', { name: 'regular https link' }).click();

    await expect.poll(() => page.url()).toBe(googleSearch('late@example.com'));

    await page.close();
  });

  test('clicking navigates for real, not just in the URL bar', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    // The point of the extension is that the click lands on a real web
    // page instead of handing off to an email client, so assert the
    // destination actually rendered.
    await config.setTemplate(`${fixtureServer.baseUrl}/landing.html?to={email}`);
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));

    await page.getByRole('link', { name: 'alice@example.com' }).click();

    await page.waitForURL(/landing\.html/);
    await expect(page.locator('#target')).toHaveText('landing page');
    expect(new URL(page.url()).searchParams.get('to')).toBe('alice@example.com');

    await page.close();
  });
});

test.describe('the page is never modified', () => {
  test.beforeEach(async ({ config }) => {
    await config.setTemplate(DEFAULT_TEMPLATE);
  });

  test('leaves every href and attribute exactly as the page wrote them', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));

    // Give any stray load-time work a chance to happen before asserting
    // a negative, so this can't pass merely by running too early.
    await page.waitForTimeout(250);

    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    );
    expect(hrefs).toContain('mailto:alice@example.com');
    expect(hrefs).toContain('MAILTO:Carol@Example.COM');
    expect(hrefs).toContain('https://example.com/contact');

    // No marker attributes, and nothing appended to the document.
    // `data-fix-mailto-original` belonged to the old href-rewriting
    // design; this is deliberate regression coverage for its removal,
    // not a stale reference to keep tidying away.
    const extras = await page.evaluate(() => ({
      marked: document.querySelectorAll('[data-fix-mailto-original]').length,
      dialogs: document.querySelectorAll('#fix-mailto-links-dialog').length,
    }));
    expect(extras).toEqual({ marked: 0, dialogs: 0 });

    // And the links still work, so "unmodified" isn't "inert".
    await page.getByRole('link', { name: 'alice@example.com' }).click();
    await expect.poll(() => page.url()).toBe(googleSearch('alice@example.com'));

    await page.close();
  });
});

test.describe('modifier and middle clicks', () => {
  // These targets open in a tab or window created by the *service worker*,
  // and Playwright installs its request routing when it attaches to the
  // new page — a race the extension can win, letting the request escape
  // to the network. So point these tests at the local fixture server,
  // which needs no interception to be hermetic.
  function landing(base: string, email: string): string {
    return `${base}/landing.html?to=${encodeURIComponent(email).replace(/%40/g, '@')}`;
  }

  test.beforeEach(async ({ config, fixtureServer }) => {
    await config.setTemplate(`${fixtureServer.baseUrl}/landing.html?to={email}`);
  });

  test('middle-click opens the target in a background tab', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));
    const before = extensionContext.pages();

    const link = page.getByRole('link', { name: 'alice@example.com' });
    const box = (await link.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.up({ button: 'middle' });

    const opened = await waitForNewPage(
      extensionContext,
      before,
      landing(fixtureServer.baseUrl, 'alice@example.com'),
    );
    // The opener stays put — a background tab is what middle-click does
    // on an ordinary link.
    expect(page.url()).toBe(linkPage(fixtureServer.baseUrl));

    await opened.close();
    await page.close();
  });

  test('Ctrl-click opens the target in a background tab', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));
    const before = extensionContext.pages();

    await page
      .getByRole('link', { name: 'Email Bob' })
      .click({ modifiers: ['Control'] });

    const opened = await waitForNewPage(
      extensionContext,
      before,
      landing(fixtureServer.baseUrl, 'bob@example.org'),
    );
    expect(page.url()).toBe(linkPage(fixtureServer.baseUrl));

    await opened.close();
    await page.close();
  });

  test('Shift-click opens the target in a new window', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));
    const before = extensionContext.pages();

    await page
      .getByRole('link', { name: 'alice@example.com' })
      .click({ modifiers: ['Shift'] });

    const opened = await waitForNewPage(
      extensionContext,
      before,
      landing(fixtureServer.baseUrl, 'alice@example.com'),
    );
    expect(page.url()).toBe(linkPage(fixtureServer.baseUrl));

    await opened.close();
    await page.close();
  });

  test('a plain click honours the page\'s own target="_blank"', async ({
    extensionContext,
    fixtureServer,
  }) => {
    // Following the href used to honour this for free. Now it has to be
    // read off the anchor, or the click would navigate the page away.
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));
    const before = extensionContext.pages();

    await page.getByRole('link', { name: 'Heidi (target=_blank)' }).click();

    const opened = await waitForNewPage(
      extensionContext,
      before,
      landing(fixtureServer.baseUrl, 'heidi@example.com'),
    );
    expect(page.url()).toBe(linkPage(fixtureServer.baseUrl));

    await opened.close();
    await page.close();
  });

  test('a synthetic Ctrl-click cannot spawn tabs', async ({
    extensionContext,
    fixtureServer,
  }) => {
    // chrome.tabs.create isn't gated on user activation the way
    // window.open is, so without an isTrusted check a page could dispatch
    // synthetic Ctrl-clicks at any mailto: link of its own and open tabs
    // without limit. Untrusted clicks fall back to navigating, which is
    // what following a rewritten href used to do.
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));
    const before = extensionContext.pages();

    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>(
        'a[href="mailto:alice@example.com"]',
      )!;
      for (let i = 0; i < 3; i++) {
        a.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
        );
      }
    });

    // It navigates this tab instead — proof the clicks were handled at
    // all, so a pass can't just mean nothing happened.
    await expect
      .poll(() => page.url())
      .toBe(landing(fixtureServer.baseUrl, 'alice@example.com'));
    expect(extensionContext.pages().filter((p) => !before.includes(p))).toHaveLength(0);

    await page.close();
  });

  test('Alt-click is left to the browser', async ({
    extensionContext,
    fixtureServer,
  }) => {
    // Alt-click means "download the target", not "navigate", so the
    // event must reach the browser uncancelled.
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));
    await page.evaluate(() => {
      (window as unknown as { seen: boolean[] }).seen = [];
      document.addEventListener(
        'click',
        (e) => {
          (window as unknown as { seen: boolean[] }).seen.push(e.defaultPrevented);
        },
        true,
      );
    });

    await page
      .getByRole('link', { name: 'alice@example.com' })
      .click({ modifiers: ['Alt'] });

    // Read the probe before the control click: that one navigates, which
    // would take `window.seen` with it.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { seen: boolean[] }).seen))
      .toEqual([false]);
    expect(page.url()).toBe(linkPage(fixtureServer.baseUrl));

    // Positive control: the same link without Alt IS claimed, so a pass
    // above can't just mean the extension never ran here.
    await page.getByRole('link', { name: 'alice@example.com' }).click();
    await expect
      .poll(() => page.url())
      .toBe(landing(fixtureServer.baseUrl, 'alice@example.com'));

    await page.close();
  });

  test('a modified click on a link with no automatic target still asks', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    // Nothing to follow, so the dialog appears rather than a new tab —
    // but the request for a new tab is remembered, and the target links
    // it offers open in one.
    await config.setTargets([
      {
        emailDomain: '',
        urlTemplate: 'https://example.test/ask?q={email}',
        openDirectly: false,
      },
    ]);
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));

    await page
      .getByRole('link', { name: 'alice@example.com' })
      .click({ modifiers: ['Control'] });

    const dialog = page.locator(DIALOG);
    await expect(dialog.locator('.panel')).toBeVisible();
    await expect(dialog.locator('li a').first()).toHaveAttribute('target', '_blank');

    await page.close();
  });

  test('middle-click on a non-mailto link is left to the browser', async ({
    extensionContext,
    fixtureServer,
  }) => {
    // Whether Chrome then opens a tab is Chrome's business (and headless
    // doesn't always). What this extension owes the page is that it
    // hasn't cancelled the event, so read defaultPrevented directly.
    //
    // The probe has to be a *capture* listener on `document`, the same
    // node the content script uses: the content script registers first
    // (document_start) and calls stopPropagation() on the clicks it
    // claims, which would starve a listener anywhere else in the tree.
    // stopPropagation doesn't affect later listeners on the same node,
    // so this one still sees both events.
    const page = await extensionContext.newPage();
    await page.goto(linkPage(fixtureServer.baseUrl));
    await page.evaluate(() => {
      (window as unknown as { seen: boolean[] }).seen = [];
      document.addEventListener(
        'auxclick',
        (e) => {
          (window as unknown as { seen: boolean[] }).seen.push(e.defaultPrevented);
        },
        true,
      );
    });

    const middleClick = async (name: string) => {
      const box = (await page.getByRole('link', { name }).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.up({ button: 'middle' });
    };

    await middleClick('regular https link');
    // Positive control: the mailto: link in the same page IS cancelled,
    // so a false below means "we let it through", not "the probe is
    // broken".
    await middleClick('alice@example.com');

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { seen: boolean[] }).seen))
      .toEqual([false, true]);

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

  test('handles links inside srcdoc and about:blank frames', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    const framePage = `${fixtureServer.baseUrl}/${FRAME_PAGE}`;

    // Positive control in the top frame first, so a failure below means
    // "the frames were missed", not "the extension hadn't run yet".
    await page.goto(framePage);
    await page.getByRole('link', { name: 'top@example.com' }).click();
    await expect.poll(() => page.url()).toBe(googleSearch('top@example.com'));

    for (const [frame, address] of [
      ['#srcdoc-frame', 'srcdoc@example.com'],
      ['#blank-frame', 'blank@example.com'],
    ] as const) {
      await page.goto(framePage);
      await page.frameLocator(frame).getByRole('link', { name: address }).click();
      // The frame navigates, not the top document, so check the frame's
      // own URL rather than the page's.
      await expect
        .poll(() => page.frames().map((f) => f.url()))
        .toContain(googleSearch(address));
    }

    await page.close();
  });
});

test.describe('templates that would break the extension', () => {
  // These can only reach the content script through storage — the options
  // page rejects them — but storage is synced, so a value written by an
  // older build or another device has to be survivable. A target whose
  // template can't work is dropped, which means the click falls through
  // to the dialog (offering whatever else is configured).

  for (const [label, template] of [
    // Without normalization the click would go to "", i.e. back to the
    // page it started on.
    ['an empty template', '   '],
    // A mailto: template would hand straight back to the email app,
    // which is the one outcome the extension exists to prevent.
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
      const base = fixtureServer.baseUrl;

      await expectFollows(
        page,
        base,
        'Email Bob',
        'https://example.test/org?q=bob@example.org',
      );
      // alice matched only the dropped target, so she gets the dialog.
      await expectDialog(page, base, 'alice@example.com');
      await dismissDialog(page);

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

    await expectDefaultTarget(page, fixtureServer.baseUrl);

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
    const base = fixtureServer.baseUrl;

    await expectFollows(page, base, 'Email Bob', 'https://example.test/org?u=bob');
    // No example.com entry, so the catch-all takes it.
    await expectFollows(
      page,
      base,
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
    const base = fixtureServer.baseUrl;

    await expectFollows(page, base, 'alice@example.com', 'https://example.test/com?u=alice');
    // bob@example.org matches only the non-automatic catch-all, so his
    // click goes to the dialog.
    await expectDialog(page, base, 'Email Bob');
    await dismissDialog(page);

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
    const base = fixtureServer.baseUrl;

    await expectFollows(page, base, 'alice@example.com', 'https://example.test/com?u=alice');

    await page.goto(linkPage(base));
    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>(
        'a[href="https://example.com/contact"]',
      );
      a!.setAttribute('href', 'mailto:sam@mail.example.com');
    });
    await page.getByRole('link', { name: 'regular https link' }).click();
    await expect.poll(() => page.url()).toBe('https://example.test/com?u=sam');

    await page.close();
  });

  test('asks when nothing is configured', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    // An empty target list is a legitimate choice: always ask.
    await config.setTargets([]);
    const page = await extensionContext.newPage();

    const dialog = await expectDialog(page, fixtureServer.baseUrl, 'alice@example.com');
    await expect(dialog.getByText('No link targets match this address.')).toBeVisible();
    await dismissDialog(page);

    await page.close();
  });

  test('stops following once the target no longer matches', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    const base = fixtureServer.baseUrl;
    await expectFollows(
      page,
      base,
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

    await expectDialog(page, base, 'alice@example.com');
    await dismissDialog(page);

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

    await expectFollows(
      page,
      fixtureServer.baseUrl,
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

    await expectFollows(
      page,
      fixtureServer.baseUrl,
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
    const base = fixtureServer.baseUrl;
    await expectFollows(page, base, 'alice@example.com', googleSearch('alice@example.com'));

    // No reload: the frame's cached config is kept current by a
    // chrome.storage.onChanged listener, registered when it first read
    // storage. Without it the click below would still use the old
    // template.
    await page.goto(linkPage(base));
    await config.setTemplate('https://example.test/lookup?addr={email}');

    await page.getByRole('link', { name: 'alice@example.com' }).click();
    await expect
      .poll(() => page.url())
      .toBe('https://example.test/lookup?addr=alice@example.com');

    await page.close();
  });

  test('falls back to the default template when config is cleared', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    const base = fixtureServer.baseUrl;
    await expectFollows(
      page,
      base,
      'alice@example.com',
      'https://example.test/lookup?addr=alice@example.com',
    );

    await config.reset();

    // The default target is not automatic, so the click asks instead of
    // following, and offers the search from the dialog.
    await expectDefaultTarget(page, base);

    await page.close();
  });
});
